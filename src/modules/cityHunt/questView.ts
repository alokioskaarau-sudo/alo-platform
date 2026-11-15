import { db } from "../../database/db.js";
import { hashHuntAccessCode } from "../../database/cityHuntPlayers.js";
import { HuntRegistrationError } from "./registration.js";

// Persönliche Questansicht mit geprüfter Teilnahmefreigabe.
// Nur aktuelle Aufgaben und bereits freigegebene Hinweise ausgeben.
export async function getHuntQuestView(
  sessionCode: unknown,
  questKey: unknown
) {
  if (
    typeof sessionCode !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(sessionCode)
  ) {
    throw new HuntRegistrationError("INVALID_SESSION");
  }
  if (
    typeof questKey !== "string" ||
    !/^[A-Za-z0-9_-]{1,60}$/.test(questKey)
  ) {
    throw new HuntRegistrationError("INVALID_QUEST");
  }

  const hash = hashHuntAccessCode(sessionCode);
  const client = await db.connect();

  try {
    // Ein konsistenter Stand für Spieler, Stationen und Hinweise.
    await client.query(
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"
    );
    await client.query("SET LOCAL statement_timeout = '15s'");

    const access = await client.query(`
      SELECT
        p.id, p.event_slug, p.status,
        p.guardian_required, p.age_group,
        p.rules_version AS accepted_rules,
        p.privacy_version AS accepted_privacy,
        e.status AS event_status,
        e.rules_version AS current_rules,
        e.privacy_version AS current_privacy,
        (
          e.starts_at <= NOW()
          AND e.ends_at > NOW()
        ) AS event_in_time,
        (
          g.player_id IS NOT NULL
          AND g.withdrawn_at IS NULL
          AND g.declares_guardianship = TRUE
          AND g.approves_participation = TRUE
          AND g.rules_version = e.rules_version
          AND g.privacy_version = e.privacy_version
          AND (
            p.age_group <> 'UNDER_14'
            OR g.confirms_adult_companion = TRUE
          )
        ) AS guardian_approved,
        EXISTS (
          SELECT 1 FROM alo_hunt_participations attendance
          WHERE attendance.player_id = p.id
            AND attendance.event_slug = e.slug
            AND attendance.withdrawn_at IS NULL
            AND attendance.confirmed_starts_at = e.starts_at
            AND attendance.confirmed_ends_at = e.ends_at
            AND attendance.rules_version = e.rules_version
            AND attendance.privacy_version = e.privacy_version
        ) AS participation_confirmed,
        NOW() AS server_time
      FROM alo_hunt_player_tokens t
      JOIN alo_hunt_players p ON p.id = t.player_id
      JOIN alo_hunt_events e ON e.slug = p.event_slug
      LEFT JOIN alo_hunt_guardian_consents g ON g.player_id = p.id
      WHERE t.token_hash = $1
        AND t.purpose = 'SESSION'
        AND t.revoked_at IS NULL
        AND t.expires_at > NOW()
        AND p.contact_verified_at IS NOT NULL
        AND p.status IN ('PENDING_GUARDIAN', 'READY')
    `, [hash]);

    const player = access.rows[0];
    if (!player) {
      throw new HuntRegistrationError("INVALID_SESSION");
    }
    if (
      player.status !== "READY" ||
      (
        player.guardian_required === true &&
        player.guardian_approved !== true
      )
    ) {
      throw new HuntRegistrationError("PLAYER_NOT_READY");
    }
    if (
      !player.current_rules ||
      !player.current_privacy ||
      player.accepted_rules !== player.current_rules ||
      player.accepted_privacy !== player.current_privacy
    ) {
      throw new HuntRegistrationError("DOCUMENTS_CHANGED");
    }

    // Während Warteliste, Pause oder nach Ende keine Spielinhalte.
    if (
      player.event_status !== "LIVE" ||
      player.event_in_time !== true
    ) {
      await client.query("COMMIT");
      return {
        available: false as const,
        phase: player.event_status as string,
        serverTime: player.server_time,
        message: "Die Quest ist momentan nicht geöffnet.",
      };
    }

    if (player.participation_confirmed !== true) {
      throw new HuntRegistrationError("PARTICIPATION_NOT_CONFIRMED");
    }

    const questResult = await client.query(`
      SELECT quest_key, title, introduction
      FROM alo_hunt_quests
      WHERE event_slug = $1
        AND quest_key = $2
        AND status = 'PUBLISHED'
        AND opens_at <= NOW()
        AND closes_at > NOW()
    `, [player.event_slug, questKey]);

    const quest = questResult.rows[0];
    if (!quest) {
      throw new HuntRegistrationError("QUEST_NOT_AVAILABLE");
    }

    // Keine Antwort-Hashes, QR-Geheimnisse oder Finalcodes auswählen.
    const stations = await client.query(`
      SELECT
        s.station_key, s.position, s.title, s.task_text,
        s.access_mode, s.answer_hint,
        s.area_latitude, s.area_longitude, s.area_radius_m,
        p.discovered_at, p.completed_at,
        CASE WHEN p.completed_at IS NOT NULL
          THEN s.earned_digit ELSE NULL
        END AS earned_digit
      FROM alo_hunt_stations s
      LEFT JOIN alo_hunt_station_progress p
        ON p.event_slug = s.event_slug
        AND p.quest_key = s.quest_key
        AND p.station_key = s.station_key
        AND p.player_id = $3
      WHERE s.event_slug = $1
        AND s.quest_key = $2
        AND s.status = 'PUBLISHED'
      ORDER BY s.position
    `, [player.event_slug, questKey, player.id]);

    if (stations.rows.length === 0) {
      throw new HuntRegistrationError("QUEST_NOT_AVAILABLE");
    }

    let foundIncomplete = false;
    for (let index = 0; index < stations.rows.length; index++) {
      const station = stations.rows[index]!;
      if (station.position !== index + 1) {
        throw new HuntRegistrationError("QUEST_CONFIGURATION_ERROR");
      }
      if (!station.completed_at) {
        foundIncomplete = true;
      } else if (foundIncomplete) {
        throw new HuntRegistrationError("QUEST_PROGRESS_ERROR");
      }
    }

    const completed = stations.rows.filter(row => row.completed_at);
    const current = stations.rows.find(row => !row.completed_at);
    let hints: Array<{ key: string; text: string }> = [];
    let nextHintAt: unknown = null;
    let nextSearchAreaAt: unknown = null;
    let searchArea: {
      latitude: number;
      longitude: number;
      radiusMeters: number;
    } | null = current?.area_latitude != null ? {
      latitude: current.area_latitude as number,
      longitude: current.area_longitude as number,
      radiusMeters: current.area_radius_m as number,
    } : null;

    if (current) {
      if (
        current.access_mode !== "QR" &&
        current.access_mode !== "OBSERVATION"
      ) {
        throw new HuntRegistrationError("QUEST_CONFIGURATION_ERROR");
      }

      // Nur den bereits freigegebenen Kreis der aktuellen Station lesen.
      const areaStage = await client.query(`
        SELECT latitude, longitude, radius_meters
        FROM alo_hunt_search_stages
        WHERE event_slug = $1
          AND quest_key = $2
          AND station_key = $3
          AND status = 'PUBLISHED'
          AND release_at <= NOW()
        ORDER BY release_at DESC, stage_position DESC
        LIMIT 1
      `, [player.event_slug, questKey, current.station_key]);

      const activeArea = areaStage.rows[0];
      if (activeArea) {
        searchArea = {
          latitude: activeArea.latitude as number,
          longitude: activeArea.longitude as number,
          radiusMeters: activeArea.radius_meters as number,
        };
      }

      // Von zukünftigen Kreisen nur den nächsten Zeitpunkt ausgeben.
      const upcomingArea = await client.query(`
        SELECT MIN(release_at) AS next_release
        FROM alo_hunt_search_stages
        WHERE event_slug = $1
          AND quest_key = $2
          AND station_key = $3
          AND status = 'PUBLISHED'
          AND release_at > NOW()
      `, [player.event_slug, questKey, current.station_key]);
      nextSearchAreaAt = upcomingArea.rows[0]?.next_release ?? null;

      const released = await client.query(`
        SELECT hint_key, text_content
        FROM alo_hunt_hints
        WHERE event_slug = $1
          AND quest_key = $2
          AND station_key = $3
          AND status = 'PUBLISHED'
          AND kind = 'TEXT'
          AND release_at <= NOW()
        ORDER BY position
      `, [player.event_slug, questKey, current.station_key]);

      hints = released.rows.map(row => ({
        key: row.hint_key as string,
        text: row.text_content as string,
      }));

      // Nur Zeitpunkt des nächsten Texthinweises, nicht dessen Inhalt.
      const upcoming = await client.query(`
        SELECT MIN(release_at) AS next_release
        FROM alo_hunt_hints
        WHERE event_slug = $1
          AND quest_key = $2
          AND station_key = $3
          AND status = 'PUBLISHED'
          AND kind = 'TEXT'
          AND release_at > NOW()
      `, [player.event_slug, questKey, current.station_key]);
      nextHintAt = upcoming.rows[0]?.next_release ?? null;
    }

    await client.query("COMMIT");

    return {
      available: true as const,
      serverTime: player.server_time,
      quest: {
        key: quest.quest_key as string,
        title: quest.title as string,
        introduction: quest.introduction as string,
      },
      progress: {
        completed: completed.length,
        total: stations.rows.length,
        digits: completed.map(row => ({
          position: row.position as number,
          digit: row.earned_digit as string,
        })),
      },
      currentStation: current ? {
        key: current.station_key as string,
        position: current.position as number,
        title: current.title as string,
        task: current.task_text as string,
        accessMode: current.access_mode as "QR" | "OBSERVATION",
        // Bei Ortsrätseln bedeutet ein Fortschrittseintrag keinen QR-Scan.
        discovered:
          current.access_mode === "QR" && current.discovered_at != null,
        canAnswer:
          current.access_mode === "OBSERVATION" ||
          current.discovered_at != null,
        answerHint: current.answer_hint as string | null,
        searchArea,
        nextSearchAreaAt,
        hints,
        nextHintAt,
      } : null,
      finalUnlocked: current == null,
      // Bedeutet nur: Rätsel abgeschlossen, noch keinen Gewinn beansprucht.
    };

  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

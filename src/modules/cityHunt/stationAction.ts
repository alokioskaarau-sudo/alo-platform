import { createHash, timingSafeEqual } from "node:crypto";
import { db } from "../../database/db.js";
import { hashHuntAccessCode } from "../../database/cityHuntPlayers.js";
import { HuntRegistrationError } from "./registration.js";

// Diese Funktion auch beim späteren Einrichten der Lösungen verwenden.
export function hashHuntStationAnswer(answer: string): string {
  const normalized = answer
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase("de-CH");

  return createHash("sha256")
    .update("ALO-HUNT-STATION-ANSWER-V1\0")
    .update(normalized)
    .digest("hex");
}

function validKey(value: unknown): value is string {
  return typeof value === "string" &&
    /^[A-Za-z0-9_-]{1,60}$/.test(value);
}

function equalHash(actual: string, expected: unknown): boolean {
  if (
    typeof expected !== "string" ||
    !/^[0-9a-f]{64}$/.test(expected)
  ) return false;

  return timingSafeEqual(
    Buffer.from(actual, "hex"),
    Buffer.from(expected, "hex")
  );
}

// Persönliche Teilnahmefreigabe und Versuchslimit werden geprüft.
// QR-Stationen benötigen einen Scan; Ortsrätsel eine passende Antwort.
export async function performHuntStationAction(
  sessionCode: unknown,
  questKey: unknown,
  stationKey: unknown,
  input: unknown
) {
  if (
    typeof sessionCode !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(sessionCode)
  ) throw new HuntRegistrationError("INVALID_SESSION");

  if (!validKey(questKey) || !validKey(stationKey)) {
    throw new HuntRegistrationError("INVALID_STATION");
  }

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new HuntRegistrationError("INVALID_STATION_ACTION");
  }

  const action = input as Record<string, unknown>;
  const discovering = action.type === "DISCOVER";
  const solving = action.type === "SOLVE";

  if (!discovering && !solving) {
    throw new HuntRegistrationError("INVALID_STATION_ACTION");
  }

  if (
    discovering &&
    (
      typeof action.code !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(action.code)
    )
  ) throw new HuntRegistrationError("INVALID_STATION_CODE");

  if (
    solving &&
    (
      typeof action.answer !== "string" ||
      action.answer.length > 200 ||
      !action.answer.trim() ||
      /[\u0000-\u001f\u007f]/u.test(action.answer)
    )
  ) throw new HuntRegistrationError("INVALID_ANSWER");

  const client = await db.connect();

  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '15s'");

    // Ein Spieler kann immer nur eine Fortschrittsänderung ausführen.
    // Sperren verhindern auch Änderungen an Event und Sitzung währenddessen.
    const access = await client.query(`
      SELECT p.id, p.event_slug
      FROM alo_hunt_player_tokens t
      JOIN alo_hunt_players p ON p.id = t.player_id
      JOIN alo_hunt_events e ON e.slug = p.event_slug
      WHERE t.token_hash = $1 AND t.purpose = 'SESSION'
      FOR UPDATE OF p
      FOR SHARE OF t, e
    `, [hashHuntAccessCode(sessionCode)]);

    const player = access.rows[0];
    if (!player) throw new HuntRegistrationError("INVALID_SESSION");

    // Nach Erhalt der Sperren Ablaufzeiten erneut prüfen.
    const eligible = await client.query(`
      SELECT
        (
          t.revoked_at IS NULL
          AND t.expires_at > clock_timestamp()
          AND p.contact_verified_at IS NOT NULL
          AND p.status IN ('PENDING_GUARDIAN', 'READY')
        ) AS session_valid,
        p.status,
        (
          NOT p.guardian_required OR EXISTS (
            SELECT 1 FROM alo_hunt_guardian_consents g
            WHERE g.player_id = p.id
              AND g.withdrawn_at IS NULL
              AND g.declares_guardianship = TRUE
              AND g.approves_participation = TRUE
              AND g.rules_version = e.rules_version
              AND g.privacy_version = e.privacy_version
              AND (
                p.age_group <> 'UNDER_14'
                OR g.confirms_adult_companion = TRUE
              )
          )
        ) AS guardian_approved,
        (
          length(btrim(e.rules_version)) > 0
          AND length(btrim(e.privacy_version)) > 0
          AND p.rules_version = e.rules_version
          AND p.privacy_version = e.privacy_version
        ) AS documents_current,
        (
          e.status = 'LIVE'
          AND e.starts_at <= clock_timestamp()
          AND e.ends_at > clock_timestamp()
        ) AS event_available,
        EXISTS (
          SELECT 1 FROM alo_hunt_participations attendance
          WHERE attendance.player_id = p.id
            AND attendance.event_slug = e.slug
            AND attendance.withdrawn_at IS NULL
            AND attendance.confirmed_starts_at = e.starts_at
            AND attendance.confirmed_ends_at = e.ends_at
            AND attendance.rules_version = e.rules_version
            AND attendance.privacy_version = e.privacy_version
        ) AS participation_confirmed
      FROM alo_hunt_player_tokens t
      JOIN alo_hunt_players p ON p.id = t.player_id
      JOIN alo_hunt_events e ON e.slug = p.event_slug
      WHERE t.token_hash = $1
    `, [hashHuntAccessCode(sessionCode)]);

    const gate = eligible.rows[0];
    if (!gate || gate.session_valid !== true) {
      throw new HuntRegistrationError("INVALID_SESSION");
    }
    if (gate.status !== "READY" || gate.guardian_approved !== true) {
      throw new HuntRegistrationError("PLAYER_NOT_READY");
    }
    if (gate.documents_current !== true) {
      throw new HuntRegistrationError("DOCUMENTS_CHANGED");
    }
    if (gate.event_available !== true) {
      throw new HuntRegistrationError("EVENT_NOT_AVAILABLE");
    }

    if (gate.participation_confirmed !== true) {
      throw new HuntRegistrationError("PARTICIPATION_NOT_CONFIRMED");
    }

    const quest = await client.query(`
      SELECT quest_key
      FROM alo_hunt_quests
      WHERE event_slug = $1 AND quest_key = $2
        AND status = 'PUBLISHED'
      FOR SHARE
    `, [player.event_slug, questKey]);

    if (quest.rowCount !== 1) {
      throw new HuntRegistrationError("QUEST_NOT_AVAILABLE");
    }

    const stations = await client.query(`
      SELECT station_key, position, access_mode, entry_code_hash,
             answer_hash, earned_digit
      FROM alo_hunt_stations
      WHERE event_slug = $1 AND quest_key = $2
        AND status = 'PUBLISHED'
      ORDER BY position
      FOR SHARE
    `, [player.event_slug, questKey]);

    if (!stations.rows.length) {
      throw new HuntRegistrationError("QUEST_NOT_AVAILABLE");
    }

    const progress = await client.query(`
      SELECT station_key, discovered_at, completed_at,
             failed_answer_count, answer_blocked_until
      FROM alo_hunt_station_progress
      WHERE player_id = $1 AND event_slug = $2 AND quest_key = $3
    `, [player.id, player.event_slug, questKey]);

    const byStation = new Map(
      progress.rows.map(row => [row.station_key, row])
    );

    let current: typeof stations.rows[number] | undefined;
    let incompleteSeen = false;

    for (let index = 0; index < stations.rows.length; index++) {
      const station = stations.rows[index]!;
      if (station.position !== index + 1) {
        throw new HuntRegistrationError("QUEST_CONFIGURATION_ERROR");
      }

      if (!byStation.get(station.station_key)?.completed_at) {
        incompleteSeen = true;
        current ??= station;
      } else if (incompleteSeen) {
        throw new HuntRegistrationError("QUEST_PROGRESS_ERROR");
      }
    }

    if (!current || current.station_key !== stationKey) {
      throw new HuntRegistrationError("STATION_NOT_CURRENT");
    }

    // Frische Zeitprüfung nach möglichen Wartezeiten auf Sperren.
    const timing = await client.query(`
      SELECT TRUE AS available
      FROM alo_hunt_quests q
      JOIN alo_hunt_events e ON e.slug = q.event_slug
      WHERE q.event_slug = $1 AND q.quest_key = $2
        AND e.status = 'LIVE'
        AND e.starts_at <= clock_timestamp()
        AND e.ends_at > clock_timestamp()
        AND q.opens_at <= clock_timestamp()
        AND q.closes_at > clock_timestamp()
    `, [player.event_slug, questKey]);

    if (timing.rowCount !== 1) {
      throw new HuntRegistrationError("QUEST_NOT_AVAILABLE");
    }

    if (
      current.access_mode !== "QR" &&
      current.access_mode !== "OBSERVATION"
    ) {
      throw new HuntRegistrationError("QUEST_CONFIGURATION_ERROR");
    }

    if (discovering) {
      // Ortsrätsel werden durch Antworten gelöst, nicht durch QR-Scans.
      if (current.access_mode !== "QR") {
        throw new HuntRegistrationError("INVALID_STATION_ACTION");
      }

      if (!equalHash(
        hashHuntAccessCode(action.code as string),
        current.entry_code_hash
      )) {
        throw new HuntRegistrationError("INVALID_STATION_CODE");
      }

      await client.query(`
        INSERT INTO alo_hunt_station_progress (
          player_id, event_slug, quest_key, station_key
        )
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (player_id, event_slug, quest_key, station_key)
        DO NOTHING
      `, [player.id, player.event_slug, questKey, stationKey]);

      await client.query("COMMIT");
      return {
        ok: true as const,
        discovered: true as const,
        completed: false as const,
      };
    }

    if (current.access_mode === "OBSERVATION") {
      // Fortschrittseintrag für die Versuchszählung anlegen.
      // Dies bestätigt weder den Aufenthalt noch die richtige Lösung.
      // Wiederholte Antworten setzen eine bestehende Denkpause nicht zurück.
      await client.query(`
        INSERT INTO alo_hunt_station_progress (
          player_id, event_slug, quest_key, station_key
        )
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (player_id, event_slug, quest_key, station_key)
        DO NOTHING
      `, [player.id, player.event_slug, questKey, stationKey]);
    } else if (!byStation.get(stationKey)?.discovered_at) {
      throw new HuntRegistrationError("STATION_NOT_DISCOVERED");
    }

    const attempt = await client.query(`
      SELECT
        failed_answer_count,
        answer_blocked_until,
        CASE
          WHEN answer_blocked_until > clock_timestamp()
          THEN GREATEST(
            1,
            CEIL(EXTRACT(EPOCH FROM (
              answer_blocked_until - clock_timestamp()
            )))::int
          )
          ELSE 0
        END AS retry_after_seconds
      FROM alo_hunt_station_progress
      WHERE player_id = $1 AND event_slug = $2
        AND quest_key = $3 AND station_key = $4
    `, [player.id, player.event_slug, questKey, stationKey]);

    const attemptState = attempt.rows[0];
    if (!attemptState) {
      throw new HuntRegistrationError("STATION_NOT_DISCOVERED");
    }

    if (attemptState.retry_after_seconds > 0) {
      await client.query("COMMIT");
      return {
        ok: true as const,
        correct: false as const,
        completed: false as const,
        limited: true as const,
        retryAfterSeconds: attemptState.retry_after_seconds as number,
      };
    }

    // Nach abgelaufener Denkpause beginnt eine neue Runde.
    if (attemptState.answer_blocked_until != null) {
      await client.query(`
        UPDATE alo_hunt_station_progress
        SET failed_answer_count = 0, answer_blocked_until = NULL
        WHERE player_id = $1 AND event_slug = $2
          AND quest_key = $3 AND station_key = $4
      `, [player.id, player.event_slug, questKey, stationKey]);
    }

    if (!equalHash(
      hashHuntStationAnswer(action.answer as string),
      current.answer_hash
    )) {
      const failure = await client.query(`
        UPDATE alo_hunt_station_progress
        SET failed_answer_count = failed_answer_count + 1,
            answer_blocked_until = CASE
              WHEN failed_answer_count + 1 >= 5
              THEN clock_timestamp() + INTERVAL '60 seconds'
              ELSE NULL
            END
        WHERE player_id = $1 AND event_slug = $2
          AND quest_key = $3 AND station_key = $4
          AND completed_at IS NULL
        RETURNING failed_answer_count
      `, [player.id, player.event_slug, questKey, stationKey]);

      if (failure.rowCount !== 1) {
        throw new HuntRegistrationError("QUEST_PROGRESS_ERROR");
      }

      const limited = failure.rows[0].failed_answer_count >= 5;
      await client.query("COMMIT");
      return {
        ok: true as const,
        correct: false as const,
        completed: false as const,
        limited,
        retryAfterSeconds: limited ? 60 : 0,
      };
    }

    const saved = await client.query(`
      UPDATE alo_hunt_station_progress
      SET completed_at = clock_timestamp(),
          failed_answer_count = 0, answer_blocked_until = NULL
      WHERE player_id = $1 AND event_slug = $2
        AND quest_key = $3 AND station_key = $4
        AND completed_at IS NULL
      RETURNING station_key
    `, [player.id, player.event_slug, questKey, stationKey]);

    if (saved.rowCount !== 1) {
      throw new HuntRegistrationError("QUEST_PROGRESS_ERROR");
    }

    await client.query("COMMIT");
    return {
      ok: true as const,
      correct: true as const,
      completed: true as const,
      earnedDigit: current.earned_digit as string,
    };

  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

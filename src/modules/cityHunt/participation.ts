import { db } from "../../database/db.js";
import { hashHuntAccessCode } from "../../database/cityHuntPlayers.js";
import { HuntRegistrationError } from "./registration.js";

// Interner Dienst; noch kein öffentlicher Endpunkt.
export async function confirmHuntParticipation(
  sessionCode: unknown,
  input: unknown
) {
  if (
    typeof sessionCode !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(sessionCode)
  ) throw new HuntRegistrationError("INVALID_SESSION");

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new HuntRegistrationError("INVALID_PARTICIPATION");
  }

  const submitted = input as Record<string, unknown>;
  if (
    submitted.confirmAttendance !== true ||
    typeof submitted.startsAt !== "string" ||
    typeof submitted.endsAt !== "string" ||
    typeof submitted.rulesVersion !== "string" ||
    typeof submitted.privacyVersion !== "string" ||
    submitted.startsAt.length > 40 ||
    submitted.endsAt.length > 40 ||
    submitted.rulesVersion.length > 100 ||
    submitted.privacyVersion.length > 100
  ) throw new HuntRegistrationError("INVALID_PARTICIPATION");

  const hash = hashHuntAccessCode(sessionCode);
  const client = await db.connect();

  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '15s'");

    // Gleiche Sperrreihenfolge wie bei den Spielaktionen: Spieler zuerst.
    const identity = await client.query(`
      SELECT p.id, p.event_slug
      FROM alo_hunt_player_tokens t
      JOIN alo_hunt_players p ON p.id = t.player_id
      WHERE t.token_hash = $1 AND t.purpose = 'SESSION'
      FOR UPDATE OF p
      FOR SHARE OF t
    `, [hash]);

    const player = identity.rows[0];
    if (!player) throw new HuntRegistrationError("INVALID_SESSION");

    // Alle Platzvergaben eines Events laufen nacheinander.
    const eventResult = await client.query(`
      SELECT *,
        starts_at > clock_timestamp() AS before_start
      FROM alo_hunt_events
      WHERE slug = $1
      FOR UPDATE
    `, [player.event_slug]);

    const event = eventResult.rows[0];

    const eligibility = await client.query(`
      SELECT p.status,
        (
          t.revoked_at IS NULL
          AND t.expires_at > clock_timestamp()
          AND p.contact_verified_at IS NOT NULL
          AND p.status IN ('PENDING_GUARDIAN', 'READY')
        ) AS valid_session,
        p.rules_version, p.privacy_version,
        p.guardian_required, p.age_group
      FROM alo_hunt_players p
      JOIN alo_hunt_player_tokens t ON t.player_id = p.id
      WHERE t.token_hash = $1
    `, [hash]);

    const eligible = eligibility.rows[0];
    if (!eligible || eligible.valid_session !== true) {
      throw new HuntRegistrationError("INVALID_SESSION");
    }
    if (eligible.status !== "READY") {
      throw new HuntRegistrationError("PLAYER_NOT_READY");
    }

    if (
      !event ||
      event.status !== "REGISTRATION" ||
      event.registration_open !== true ||
      event.before_start !== true ||
      !event.starts_at || !event.ends_at ||
      !Number.isInteger(event.participant_capacity) ||
      event.participant_capacity < 1
    ) throw new HuntRegistrationError("EVENT_NOT_AVAILABLE");

    if (
      submitted.startsAt !== event.starts_at.toISOString() ||
      submitted.endsAt !== event.ends_at.toISOString()
    ) throw new HuntRegistrationError("EVENT_SCHEDULE_CHANGED");

    if (
      !event.rules_version?.trim() ||
      !event.privacy_version?.trim() ||
      submitted.rulesVersion !== event.rules_version ||
      submitted.privacyVersion !== event.privacy_version ||
      eligible.rules_version !== event.rules_version ||
      eligible.privacy_version !== event.privacy_version
    ) throw new HuntRegistrationError("DOCUMENTS_CHANGED");

    if (eligible.guardian_required) {
      const guardian = await client.query(`
        SELECT player_id
        FROM alo_hunt_guardian_consents
        WHERE player_id = $1
          AND withdrawn_at IS NULL
          AND declares_guardianship = TRUE
          AND approves_participation = TRUE
          AND rules_version = $2 AND privacy_version = $3
          AND ($4 <> 'UNDER_14' OR confirms_adult_companion = TRUE)
        FOR SHARE
      `, [
        player.id, event.rules_version,
        event.privacy_version, eligible.age_group,
      ]);
      if (guardian.rowCount !== 1) {
        throw new HuntRegistrationError("PLAYER_NOT_READY");
      }
    }

    const existing = await client.query(`
      SELECT TRUE AS confirmed
      FROM alo_hunt_participations p
      JOIN alo_hunt_events e ON e.slug = p.event_slug
      WHERE p.player_id = $1 AND p.event_slug = $2
        AND p.withdrawn_at IS NULL
        AND p.confirmed_starts_at = e.starts_at
        AND p.confirmed_ends_at = e.ends_at
        AND p.rules_version = e.rules_version
        AND p.privacy_version = e.privacy_version
    `, [player.id, player.event_slug]);

    if (existing.rowCount === 1) {
      await client.query("COMMIT");
      return { ok: true, confirmed: true, alreadyConfirmed: true };
    }

    const occupied = await client.query(`
      SELECT COUNT(*)::int AS count
      FROM alo_hunt_participations p
      JOIN alo_hunt_events e ON e.slug = p.event_slug
      WHERE p.event_slug = $1 AND p.withdrawn_at IS NULL
        AND p.confirmed_starts_at = e.starts_at
        AND p.confirmed_ends_at = e.ends_at
        AND p.player_id <> $2
    `, [player.event_slug, player.id]);

    if (occupied.rows[0].count >= event.participant_capacity) {
      throw new HuntRegistrationError("EVENT_FULL");
    }

    await client.query(`
      INSERT INTO alo_hunt_participations (
        player_id, event_slug,
        confirmed_starts_at, confirmed_ends_at,
        rules_version, privacy_version
      )
      SELECT $1, e.slug, e.starts_at, e.ends_at,
             e.rules_version, e.privacy_version
      FROM alo_hunt_events e
      WHERE e.slug = $2
      ON CONFLICT (player_id, event_slug) DO UPDATE SET
        confirmed_starts_at = EXCLUDED.confirmed_starts_at,
        confirmed_ends_at = EXCLUDED.confirmed_ends_at,
        rules_version = EXCLUDED.rules_version,
        privacy_version = EXCLUDED.privacy_version,
        confirmed_at = clock_timestamp(),
        withdrawn_at = NULL
    `, [player.id, player.event_slug]);

    await client.query("COMMIT");
    return { ok: true, confirmed: true, alreadyConfirmed: false };

  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

import { canCompleteHuntOnboarding } from "./availability.js";
import { db } from "../../database/db.js";
import {
  createHuntAccessCode,
  hashHuntAccessCode,
} from "../../database/cityHuntPlayers.js";
import { HuntRegistrationError } from "./registration.js";

export async function verifyHuntContact(input: unknown) {
  if (
    typeof input !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(input)
  ) {
    throw new HuntRegistrationError("INVALID_VERIFICATION");
  }

  const hash = hashHuntAccessCode(input);
  const client = await db.connect();

  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '15s'");

    const result = await client.query(`
      SELECT
        t.player_id,
        p.alias,
        p.age_group,
        p.guardian_required,
        p.status AS player_status,
        p.rules_version AS accepted_rules,
        p.privacy_version AS accepted_privacy,
        e.status AS event_status,
        e.registration_open,
        e.waitlist_open,
        e.starts_at,
        e.ends_at,
        e.rules_version AS current_rules,
        e.privacy_version AS current_privacy,
        e.ends_at > clock_timestamp() AS event_not_ended
      FROM alo_hunt_player_tokens t
      JOIN alo_hunt_players p ON p.id = t.player_id
      JOIN alo_hunt_events e ON e.slug = p.event_slug
      WHERE
        t.token_hash = $1
        AND t.purpose = 'VERIFY_CONTACT'
        AND t.used_at IS NULL
        AND t.revoked_at IS NULL
        AND t.expires_at > clock_timestamp()
      FOR UPDATE OF t, p
      FOR SHARE OF e
    `, [hash]);

    const row = result.rows[0];
    if (!row || row.player_status !== "PENDING_CONTACT") {
      throw new HuntRegistrationError("INVALID_VERIFICATION");
    }

    if (
      !canCompleteHuntOnboarding({
        status: row.event_status,
        registrationOpen: row.registration_open,
        waitlistOpen: row.waitlist_open,
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        notEnded: row.event_not_ended,
        rulesVersion: row.current_rules,
        privacyVersion: row.current_privacy,
      })
    ) {
      throw new HuntRegistrationError("EVENT_NOT_AVAILABLE");
    }

    if (
      row.accepted_rules !== row.current_rules ||
      row.accepted_privacy !== row.current_privacy
    ) {
      throw new HuntRegistrationError("DOCUMENTS_CHANGED");
    }

    // Nach einer möglichen Wartezeit auf die Sperre erneut prüfen.
    const consumed = await client.query(`
      UPDATE alo_hunt_player_tokens
      SET used_at = clock_timestamp()
      WHERE
        token_hash = $1
        AND used_at IS NULL
        AND revoked_at IS NULL
        AND expires_at > clock_timestamp()
      RETURNING player_id
    `, [hash]);

    if (consumed.rowCount !== 1) {
      throw new HuntRegistrationError("INVALID_VERIFICATION");
    }

    const status =
      row.guardian_required ? "PENDING_GUARDIAN" : "READY";

    await client.query(`
      UPDATE alo_hunt_players
      SET
        contact_verified_at = clock_timestamp(),
        status = $2,
        updated_at = clock_timestamp()
      WHERE id = $1
    `, [row.player_id, status]);

    const session = createHuntAccessCode();

    await client.query(`
      INSERT INTO alo_hunt_player_tokens (
        token_hash, player_id, purpose, expires_at
      ) VALUES (
        $1, $2, 'SESSION', NOW() + INTERVAL '7 days'
      )
    `, [session.hash, row.player_id]);

    await client.query("COMMIT");

    return {
      player: {
        id: row.player_id as string,
        alias: row.alias as string,
        ageGroup: row.age_group as string,
        status,
      },
      // Für die spätere Sitzungsübergabe, niemals protokollieren.
      sessionCode: session.code,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

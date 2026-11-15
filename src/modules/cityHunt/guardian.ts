import { canCompleteHuntOnboarding } from "./availability.js";
import { db } from "../../database/db.js";
import {
  createHuntAccessCode,
  hashHuntAccessCode,
} from "../../database/cityHuntPlayers.js";
import { HuntRegistrationError } from "./registration.js";

function codeHash(input: unknown): string {
  if (
    typeof input !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(input)
  ) {
    throw new HuntRegistrationError("INVALID_ACCESS");
  }
  return hashHuntAccessCode(input);
}

function validEmail(input: unknown): string {
  if (typeof input !== "string" || input.length > 254) {
    throw new HuntRegistrationError("INVALID_EMAIL");
  }
  const email = input.trim().toLowerCase();
  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    /[\r\n]/.test(email)
  ) {
    throw new HuntRegistrationError("INVALID_EMAIL");
  }
  return email;
}

function checkEvent(row: Record<string, any>) {
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
    !row.current_rules ||
    !row.current_privacy ||
    row.accepted_rules !== row.current_rules ||
    row.accepted_privacy !== row.current_privacy
  ) {
    throw new HuntRegistrationError("DOCUMENTS_CHANGED");
  }
}

// Separater, ausdrücklich auszuführender Vorbereitungsschritt.
export async function initializeHuntGuardianRequests() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS alo_hunt_guardian_requests (
      token_hash TEXT PRIMARY KEY
        REFERENCES alo_hunt_player_tokens(token_hash)
        ON DELETE CASCADE,
      guardian_email TEXT NOT NULL,
      rules_version TEXT NOT NULL,
      privacy_version TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

// Aufruf mit der eigenen Spielersitzung.
// Der Bestätigungscode geht ausschliesslich an den Mailversand.
export async function requestHuntGuardianConsent(
  sessionCode: unknown,
  guardianEmail: unknown
) {
  const sessionHash = codeHash(sessionCode);
  const email = validEmail(guardianEmail);
  const client = await db.connect();

  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '15s'");

    const result = await client.query(`
      SELECT
        p.id, p.alias, p.status, p.guardian_required,
        p.rules_version AS accepted_rules,
        p.privacy_version AS accepted_privacy,
        e.rules_version AS current_rules,
        e.privacy_version AS current_privacy,
        e.status AS event_status,
        e.registration_open,
        e.waitlist_open,
        e.starts_at,
        e.ends_at,
        e.ends_at > clock_timestamp() AS event_not_ended
      FROM alo_hunt_player_tokens t
      JOIN alo_hunt_players p ON p.id = t.player_id
      JOIN alo_hunt_events e ON e.slug = p.event_slug
      WHERE
        t.token_hash = $1
        AND t.purpose = 'SESSION'
        AND t.revoked_at IS NULL
        AND t.expires_at > clock_timestamp()
      FOR UPDATE OF p
      FOR SHARE OF t, e
    `, [sessionHash]);

    const row = result.rows[0];
    if (
      !row ||
      row.status !== "PENDING_GUARDIAN" ||
      row.guardian_required !== true
    ) {
      throw new HuntRegistrationError("INVALID_ACCESS");
    }
    checkEvent(row);

    // Frühere Elternlinks für diesen Spieler verlieren ihre Gültigkeit.
    await client.query(`
      UPDATE alo_hunt_player_tokens
      SET revoked_at = clock_timestamp()
      WHERE player_id = $1
        AND purpose = 'VERIFY_GUARDIAN'
        AND used_at IS NULL
        AND revoked_at IS NULL
    `, [row.id]);

    const verification = createHuntAccessCode();

    await client.query(`
      INSERT INTO alo_hunt_player_tokens (
        token_hash, player_id, purpose, expires_at
      ) VALUES (
        $1, $2, 'VERIFY_GUARDIAN', NOW() + INTERVAL '24 hours'
      )
    `, [verification.hash, row.id]);

    await client.query(`
      INSERT INTO alo_hunt_guardian_requests (
        token_hash, guardian_email, rules_version, privacy_version
      ) VALUES ($1, $2, $3, $4)
    `, [
      verification.hash, email,
      row.current_rules, row.current_privacy,
    ]);

    await client.query("COMMIT");

    return {
      status: "PENDING_GUARDIAN" as const,
      delivery: {
        recipient: email,
        verificationCode: verification.code,
        playerAlias: row.alias as string,
      },
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function confirmHuntGuardianConsent(
  verificationCode: unknown,
  input: unknown
) {
  const hash = codeHash(verificationCode);

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new HuntRegistrationError("INVALID_INPUT");
  }
  const data = input as Record<string, unknown>;
  const name =
    typeof data.guardianName === "string"
      ? data.guardianName.trim()
      : "";

  if (
    name.length < 2 ||
    name.length > 120 ||
    /[\u0000-\u001f\u007f]/.test(name)
  ) {
    throw new HuntRegistrationError("INVALID_GUARDIAN_NAME");
  }

  if (
    data.declaresGuardianship !== true ||
    data.approvesParticipation !== true ||
    data.acceptRules !== true ||
    data.acknowledgePrivacy !== true
  ) {
    throw new HuntRegistrationError("GUARDIAN_APPROVAL_REQUIRED");
  }

  const client = await db.connect();

  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '15s'");

    const result = await client.query(`
      SELECT
        p.id, p.age_group, p.status, p.guardian_required,
        p.rules_version AS accepted_rules,
        p.privacy_version AS accepted_privacy,
        r.guardian_email,
        r.rules_version AS requested_rules,
        r.privacy_version AS requested_privacy,
        e.rules_version AS current_rules,
        e.privacy_version AS current_privacy,
        e.status AS event_status,
        e.registration_open,
        e.waitlist_open,
        e.starts_at,
        e.ends_at,
        e.ends_at > clock_timestamp() AS event_not_ended
      FROM alo_hunt_player_tokens t
      JOIN alo_hunt_guardian_requests r ON r.token_hash = t.token_hash
      JOIN alo_hunt_players p ON p.id = t.player_id
      JOIN alo_hunt_events e ON e.slug = p.event_slug
      WHERE
        t.token_hash = $1
        AND t.purpose = 'VERIFY_GUARDIAN'
        AND t.used_at IS NULL
        AND t.revoked_at IS NULL
        AND t.expires_at > clock_timestamp()
      FOR UPDATE OF p
      FOR SHARE OF e
    `, [hash]);

    const row = result.rows[0];
    if (
      !row ||
      row.status !== "PENDING_GUARDIAN" ||
      row.guardian_required !== true
    ) {
      throw new HuntRegistrationError("INVALID_ACCESS");
    }
    checkEvent(row);

    if (
      row.requested_rules !== row.current_rules ||
      row.requested_privacy !== row.current_privacy ||
      data.rulesVersion !== row.current_rules ||
      data.privacyVersion !== row.current_privacy
    ) {
      throw new HuntRegistrationError("DOCUMENTS_CHANGED");
    }

    const companion = data.confirmsAdultCompanion === true;
    if (row.age_group === "UNDER_14" && !companion) {
      throw new HuntRegistrationError("ADULT_COMPANION_REQUIRED");
    }

    const consumed = await client.query(`
      UPDATE alo_hunt_player_tokens
      SET used_at = clock_timestamp()
      WHERE token_hash = $1
        AND used_at IS NULL
        AND revoked_at IS NULL
        AND expires_at > clock_timestamp()
      RETURNING player_id
    `, [hash]);

    if (consumed.rowCount !== 1) {
      throw new HuntRegistrationError("INVALID_ACCESS");
    }

    await client.query(`
      INSERT INTO alo_hunt_guardian_consents (
        player_id, guardian_name, guardian_email,
        guardian_email_verified_at,
        declares_guardianship, approves_participation,
        confirms_adult_companion, rules_version, privacy_version
      ) VALUES (
        $1, $2, $3, clock_timestamp(),
        TRUE, TRUE, $4, $5, $6
      )
    `, [
      row.id, name, row.guardian_email, companion,
      row.current_rules, row.current_privacy,
    ]);

    await client.query(`
      UPDATE alo_hunt_players
      SET status = 'READY', updated_at = clock_timestamp()
      WHERE id = $1
    `, [row.id]);

    await client.query("COMMIT");
    return { status: "READY" as const };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

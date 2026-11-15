import { db } from "./db.js";
import { createHash, randomBytes } from "node:crypto";

export function createHuntAccessCode() {
  const code = randomBytes(32).toString("base64url");
  const hash = hashHuntAccessCode(code);
  return { code, hash };
}

export function hashHuntAccessCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

// Manuell ausführen, nicht automatisch beim Serverstart.
export async function initializeCityHuntPlayers() {
  const client = await db.connect();

  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query(
      "SELECT pg_advisory_xact_lock($1)",
      [10611001]
    );

    await client.query(`
      CREATE TABLE IF NOT EXISTS alo_hunt_players (
        id UUID PRIMARY KEY,
        event_slug TEXT NOT NULL
          REFERENCES alo_hunt_events(slug),
        alias TEXT NOT NULL
          CHECK (char_length(alias) BETWEEN 3 AND 24),
        age_group TEXT NOT NULL
          CHECK (age_group IN ('UNDER_14', '14_17', 'ADULT')),
        contact_email TEXT NOT NULL,
        contact_verified_at TIMESTAMPTZ,
        guardian_required BOOLEAN NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING_CONTACT'
          CHECK (status IN (
            'PENDING_CONTACT', 'PENDING_GUARDIAN',
            'READY', 'BLOCKED', 'WITHDRAWN'
          )),
        rules_version TEXT NOT NULL,
        privacy_version TEXT NOT NULL,
        rules_accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK (
          guardian_required = (age_group <> 'ADULT')
        ),
        CHECK (
          status <> 'READY' OR contact_verified_at IS NOT NULL
        )
      );

      CREATE UNIQUE INDEX IF NOT EXISTS
        alo_hunt_players_alias_unique
      ON alo_hunt_players (event_slug, LOWER(alias));

      CREATE INDEX IF NOT EXISTS
        alo_hunt_players_event_status_idx
      ON alo_hunt_players (event_slug, status);

      CREATE TABLE IF NOT EXISTS alo_hunt_player_tokens (
        token_hash TEXT PRIMARY KEY
          CHECK (token_hash ~ '^[0-9a-f]{64}$'),
        player_id UUID NOT NULL
          REFERENCES alo_hunt_players(id) ON DELETE CASCADE,
        purpose TEXT NOT NULL
          CHECK (purpose IN (
            'VERIFY_CONTACT', 'VERIFY_GUARDIAN', 'SESSION'
          )),
        expires_at TIMESTAMPTZ NOT NULL,
        used_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK (expires_at > created_at)
      );

      CREATE INDEX IF NOT EXISTS
        alo_hunt_player_tokens_player_idx
      ON alo_hunt_player_tokens (player_id, purpose);

      CREATE TABLE IF NOT EXISTS alo_hunt_guardian_consents (
        player_id UUID PRIMARY KEY
          REFERENCES alo_hunt_players(id) ON DELETE CASCADE,
        guardian_name TEXT NOT NULL
          CHECK (char_length(guardian_name) BETWEEN 2 AND 120),
        guardian_email TEXT NOT NULL,
        guardian_email_verified_at TIMESTAMPTZ NOT NULL,
        declares_guardianship BOOLEAN NOT NULL
          CHECK (declares_guardianship = TRUE),
        approves_participation BOOLEAN NOT NULL
          CHECK (approves_participation = TRUE),
        confirms_adult_companion BOOLEAN NOT NULL DEFAULT FALSE,
        rules_version TEXT NOT NULL,
        privacy_version TEXT NOT NULL,
        accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        withdrawn_at TIMESTAMPTZ
      );
    `);

    await client.query("COMMIT");
    return { ok: true, tablesPrepared: 3 };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

import { db } from "../../database/db.js";
import {
  createHuntAccessCode,
  hashHuntAccessCode,
} from "../../database/cityHuntPlayers.js";
import { HuntRegistrationError } from "./registration.js";

// Manuell ausführen; keine Nachrichten, keine Anmeldung öffnen.
export async function initializeHuntLoginLinks() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS alo_hunt_login_links (
      token_hash TEXT PRIMARY KEY
        CHECK (token_hash ~ '^[0-9a-f]{64}$'),
      player_id UUID NOT NULL
        REFERENCES alo_hunt_players(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (expires_at > created_at)
    );
    CREATE INDEX IF NOT EXISTS alo_hunt_login_links_player_idx
      ON alo_hunt_login_links (player_id, created_at);
  `);
}

// Interner Dienst: delivery niemals als öffentliche API-Antwort ausgeben.
// Öffentliche Antwort später immer gleich, auch bei unbekannten Konten.
export async function requestHuntLoginLink(
  eventSlug: string,
  input: unknown
) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new HuntRegistrationError("INVALID_INPUT");
  }
  const data = input as Record<string, unknown>;
  const alias = typeof data.alias === "string" ? data.alias.trim() : "";
  const email = typeof data.contactEmail === "string"
    ? data.contactEmail.trim().toLowerCase()
    : "";

  if (
    typeof data.alias !== "string" ||
    data.alias.length > 24 ||
    !/^[A-Za-z0-9_-]{3,24}$/.test(alias) ||
    typeof data.contactEmail !== "string" ||
    data.contactEmail.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    /[\r\n]/.test(email)
  ) {
    throw new HuntRegistrationError("INVALID_INPUT");
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '15s'");

    const found = await client.query(`
      SELECT id
      FROM alo_hunt_players
      WHERE event_slug = $1
        AND lower(alias) = lower($2)
        AND lower(contact_email) = $3
        AND contact_verified_at IS NOT NULL
        AND status IN ('PENDING_GUARDIAN', 'READY')
      FOR UPDATE
    `, [eventSlug, alias, email]);

    const player = found.rows[0];
    if (!player) {
      await client.query("COMMIT");
      return { accepted: true as const, delivery: null };
    }

    const recent = await client.query(`
      SELECT 1 FROM alo_hunt_login_links
      WHERE player_id = $1
        AND created_at > clock_timestamp() - INTERVAL '1 minute'
      LIMIT 1
    `, [player.id]);

    if (recent.rowCount !== 0) {
      await client.query("COMMIT");
      return { accepted: true as const, delivery: null };
    }

    await client.query(`
      UPDATE alo_hunt_login_links
      SET revoked_at = clock_timestamp()
      WHERE player_id = $1
        AND used_at IS NULL
        AND revoked_at IS NULL
    `, [player.id]);

    const link = createHuntAccessCode();
    await client.query(`
      INSERT INTO alo_hunt_login_links (
        token_hash, player_id, expires_at
      ) VALUES ($1, $2, NOW() + INTERVAL '15 minutes')
    `, [link.hash, player.id]);

    await client.query("COMMIT");
    return {
      accepted: true as const,
      delivery: {
        recipient: email,
        verificationCode: link.code,
      },
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function consumeHuntLoginLink(input: unknown) {
  if (
    typeof input !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(input)
  ) {
    throw new HuntRegistrationError("INVALID_LOGIN_LINK");
  }
  const hash = hashHuntAccessCode(input);
  const client = await db.connect();

  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '15s'");

    const found = await client.query(`
      SELECT p.id, p.status
      FROM alo_hunt_login_links l
      JOIN alo_hunt_players p ON p.id = l.player_id
      WHERE l.token_hash = $1
        AND l.used_at IS NULL
        AND l.revoked_at IS NULL
        AND l.expires_at > clock_timestamp()
        AND p.contact_verified_at IS NOT NULL
        AND p.status IN ('PENDING_GUARDIAN', 'READY')
      FOR UPDATE OF p
    `, [hash]);

    const player = found.rows[0];
    if (!player) {
      throw new HuntRegistrationError("INVALID_LOGIN_LINK");
    }

    const consumed = await client.query(`
      UPDATE alo_hunt_login_links
      SET used_at = clock_timestamp()
      WHERE token_hash = $1
        AND used_at IS NULL
        AND revoked_at IS NULL
        AND expires_at > clock_timestamp()
      RETURNING player_id
    `, [hash]);

    if (consumed.rowCount !== 1) {
      throw new HuntRegistrationError("INVALID_LOGIN_LINK");
    }

    const session = createHuntAccessCode();
    await client.query(`
      INSERT INTO alo_hunt_player_tokens (
        token_hash, player_id, purpose, expires_at
      ) VALUES ($1, $2, 'SESSION', NOW() + INTERVAL '7 days')
    `, [session.hash, player.id]);

    await client.query("COMMIT");

    // Später per sicherem Sitzungscookie übergeben, niemals protokollieren.
    return {
      playerId: player.id as string,
      status: player.status as string,
      sessionCode: session.code,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

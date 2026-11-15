import { db } from "../../database/db.js";
import { hashHuntAccessCode } from "../../database/cityHuntPlayers.js";
import { HuntRegistrationError } from "./registration.js";

// Nur Teilnahme absagen, nicht Spielerpass löschen oder Sitzung beenden.
// Öffentlicher Endpunkt und Bedienoberfläche folgen separat.
export async function withdrawHuntParticipation(sessionCode: unknown) {
  if (
    typeof sessionCode !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(sessionCode)
  ) throw new HuntRegistrationError("INVALID_SESSION");

  const hash = hashHuntAccessCode(sessionCode);
  const client = await db.connect();

  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '15s'");

    // Gleiche Sperrreihenfolge wie Bestätigung und Spielaktionen.
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

    // Auch bei geschlossenem Event oder geänderten Regeln absagen können.
    const valid = await client.query(`
      SELECT TRUE AS valid
      FROM alo_hunt_player_tokens t
      JOIN alo_hunt_players p ON p.id = t.player_id
      WHERE t.token_hash = $1 AND t.purpose = 'SESSION'
        AND t.revoked_at IS NULL
        AND t.expires_at > clock_timestamp()
        AND p.contact_verified_at IS NOT NULL
    `, [hash]);

    if (valid.rowCount !== 1) {
      throw new HuntRegistrationError("INVALID_SESSION");
    }

    // Mit Platzvergaben synchronisieren, damit frei werdende Plätze
    // zuverlässig erst nach Abschluss der Absage gezählt werden.
    const event = await client.query(`
      SELECT slug FROM alo_hunt_events
      WHERE slug = $1
      FOR UPDATE
    `, [player.event_slug]);

    if (event.rowCount !== 1) {
      throw new HuntRegistrationError("EVENT_NOT_AVAILABLE");
    }

    // Nach möglicher Wartezeit Sitzung nochmals prüfen.
    const session = await client.query(`
      SELECT TRUE AS valid
      FROM alo_hunt_player_tokens
      WHERE token_hash = $1
        AND purpose = 'SESSION'
        AND revoked_at IS NULL
        AND expires_at > clock_timestamp()
    `, [hash]);

    if (session.rowCount !== 1) {
      throw new HuntRegistrationError("INVALID_SESSION");
    }

    const changed = await client.query(`
      UPDATE alo_hunt_participations
      SET withdrawn_at = clock_timestamp()
      WHERE player_id = $1 AND event_slug = $2
        AND withdrawn_at IS NULL
      RETURNING player_id
    `, [player.id, player.event_slug]);

    await client.query("COMMIT");
    return {
      ok: true as const,
      participationConfirmed: false as const,
      changed: changed.rowCount === 1,
    };

  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

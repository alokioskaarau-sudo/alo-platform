import { db } from "./db.js";

export async function initializeHuntParticipation() {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query(
      "SELECT pg_advisory_xact_lock($1)", [10611001]
    );

    await client.query(`
      ALTER TABLE alo_hunt_events
        ADD COLUMN IF NOT EXISTS participant_capacity INTEGER;

      DO $migration$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'alo_hunt_events'::regclass
            AND conname = 'alo_hunt_capacity_guard'
        ) THEN
          ALTER TABLE alo_hunt_events
            ADD CONSTRAINT alo_hunt_capacity_guard
            CHECK (
              participant_capacity IS NULL
              OR participant_capacity BETWEEN 1 AND 10000
            );
        END IF;
      END
      $migration$;

      CREATE TABLE IF NOT EXISTS alo_hunt_participations (
        player_id UUID NOT NULL,
        event_slug TEXT NOT NULL,
        confirmed_starts_at TIMESTAMPTZ NOT NULL,
        confirmed_ends_at TIMESTAMPTZ NOT NULL,
        rules_version TEXT NOT NULL,
        privacy_version TEXT NOT NULL,
        confirmed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        withdrawn_at TIMESTAMPTZ,
        PRIMARY KEY (player_id, event_slug),
        FOREIGN KEY (player_id, event_slug)
          REFERENCES alo_hunt_players(id, event_slug)
          ON DELETE CASCADE,
        CHECK (confirmed_ends_at > confirmed_starts_at),
        CHECK (length(btrim(rules_version)) > 0),
        CHECK (length(btrim(privacy_version)) > 0),
        CHECK (
          withdrawn_at IS NULL OR withdrawn_at >= confirmed_at
        )
      );

      CREATE INDEX IF NOT EXISTS alo_hunt_participations_event_idx
        ON alo_hunt_participations (
          event_slug, confirmed_starts_at, confirmed_ends_at
        )
        WHERE withdrawn_at IS NULL;
    `);

    await client.query("COMMIT");
    return { ok: true };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

import { db } from "./db.js";

// Explizite Migration. Nicht beim Import oder Serverstart ausführen.
export async function initializeHuntAttemptLimits() {
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
      ALTER TABLE alo_hunt_station_progress
        ADD COLUMN IF NOT EXISTS failed_answer_count
          INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS answer_blocked_until TIMESTAMPTZ;

      DO $migration$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'alo_hunt_station_progress'::regclass
            AND conname = 'alo_hunt_answer_attempts_guard'
        ) THEN
          ALTER TABLE alo_hunt_station_progress
            ADD CONSTRAINT alo_hunt_answer_attempts_guard
            CHECK (
              failed_answer_count BETWEEN 0 AND 5
              AND (
                (failed_answer_count < 5 AND answer_blocked_until IS NULL)
                OR
                (failed_answer_count = 5 AND answer_blocked_until IS NOT NULL)
              )
            );
        END IF;
      END
      $migration$;
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

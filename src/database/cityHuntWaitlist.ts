import { db } from "./db.js";

// Manuell ausführen. Öffnet keine Warteliste oder Anmeldung.
export async function initializeCityHuntWaitlist() {
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
      ALTER TABLE alo_hunt_events
      ADD COLUMN IF NOT EXISTS
        waitlist_open BOOLEAN NOT NULL DEFAULT FALSE
    `);

    const constraint = await client.query(`
      SELECT 1
      FROM pg_constraint
      WHERE conrelid = 'alo_hunt_events'::regclass
        AND conname = 'alo_hunt_events_waitlist_guard'
    `);

    if (constraint.rowCount === 0) {
      await client.query(`
        ALTER TABLE alo_hunt_events
        ADD CONSTRAINT alo_hunt_events_waitlist_guard CHECK (
          NOT waitlist_open OR (
            status = 'DRAFT'
            AND registration_open = FALSE
            AND starts_at IS NULL
            AND ends_at IS NULL
            AND rules_version IS NOT NULL
            AND privacy_version IS NOT NULL
            AND length(btrim(rules_version)) > 0
            AND length(btrim(privacy_version)) > 0
          )
        )
      `);
    }

    await client.query("COMMIT");
    return { ok: true };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

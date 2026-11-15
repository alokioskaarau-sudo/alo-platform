import { db } from "./db.js";

export async function initializeHuntObservationPublishSchema() {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SELECT pg_advisory_xact_lock(10611001)");

    const old = await client.query(`
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = 'public.alo_hunt_stations'::regclass
        AND conname = 'alo_hunt_stations_check1'
        AND contype = 'c'
    `);

    if (old.rowCount === 1) {
      const expected = "CHECK (((status <> 'PUBLISHED'::text) OR ((entry_code_hash IS NOT NULL) AND (answer_hash IS NOT NULL) AND (earned_digit IS NOT NULL))))";
      const compact = (value: string) => value.replace(/\s+/g, "");
      if (compact(old.rows[0].definition) !== compact(expected)) {
        throw new Error("UNEXPECTED_STATION_PUBLISH_RULE");
      }
      await client.query(`
        ALTER TABLE public.alo_hunt_stations
        DROP CONSTRAINT alo_hunt_stations_check1
      `);
    }

    // Bei Wiederholung wird dieselbe benannte Regel erneut gesetzt.
    // Alle DDL-Schritte sind Teil derselben Transaktion.
    await client.query(`
      ALTER TABLE public.alo_hunt_stations
      DROP CONSTRAINT IF EXISTS alo_hunt_station_publish_guard
    `);

    await client.query(`
      ALTER TABLE public.alo_hunt_stations
      ADD CONSTRAINT alo_hunt_station_publish_guard CHECK (
        status <> 'PUBLISHED'
        OR (
          answer_hash IS NOT NULL
          AND earned_digit IS NOT NULL
          AND (
            (access_mode = 'QR' AND entry_code_hash IS NOT NULL)
            OR (
              access_mode = 'OBSERVATION'
              AND area_latitude IS NOT NULL
              AND area_longitude IS NOT NULL
              AND area_radius_m IS NOT NULL
            )
          )
        )
      )
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

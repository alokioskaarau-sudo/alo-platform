import { db } from "../../database/db.js";

// ALO_NOW_GPS_RETENTION_V7
// Must be invoked by a separate, controlled scheduler.
// Never call automatically on module import.
export async function cleanupAloNowGpsLocations():
  Promise<number> {
  const client = await db.connect();

  try {
    await client.query("BEGIN");

    // ALO_NOW_GPS_LOCK_V8
    // Transaction-scoped lock shared by every backend instance.
    const lock = await client.query<{ acquired: boolean }>(`
      SELECT pg_try_advisory_xact_lock(224161, 701) AS acquired
    `);

    if (lock.rows[0]?.acquired !== true) {
      await client.query("ROLLBACK");
      return 0;
    }

    // ALO_NOW_GPS_RETENTION_LOCK_V9
    // Serialize cleanup with uploads and explicit GPS stops.
    // Lock the same delivery, profile and consent rows as uploads.
    await client.query(`
      SELECT d.id
      FROM alo_now_deliveries AS d
      JOIN alo_now_gps_consents AS c
        ON c.delivery_id = d.id
      JOIN alo_driver_profiles AS p
        ON p.staff_user_id = c.driver_user_id
      WHERE c.enabled IS TRUE
      ORDER BY d.id
      FOR UPDATE OF d, p, c
    `);

    // Revoke GPS sessions without a recent upload.
    await client.query(`
      UPDATE alo_now_gps_consents
      SET enabled = FALSE,
          updated_at = NOW()
      WHERE enabled = TRUE
        AND updated_at <= NOW() - INTERVAL '2 minutes'
    `);

    // Remove positions that are expired or no longer authorized.
    const result = await client.query(`
      DELETE FROM alo_now_driver_locations AS loc
      WHERE loc.received_at <= NOW() - INTERVAL '2 minutes'
         OR NOT EXISTS (
           SELECT 1
           FROM alo_now_gps_consents AS c
           JOIN alo_now_deliveries AS d
             ON d.id = c.delivery_id
           JOIN alo_driver_profiles AS p
             ON p.staff_user_id = c.driver_user_id
           WHERE c.delivery_id = loc.delivery_id
             AND c.driver_user_id = loc.driver_user_id
             AND c.enabled = TRUE
             AND c.updated_at > NOW() - INTERVAL '2 minutes'
             AND d.assigned_driver_user_id = loc.driver_user_id
             AND d.delivery_status IN (
               'PICKED_UP', 'ON_THE_WAY'
             )
             AND p.approved = TRUE
             AND p.availability_status = 'ONLINE'
         )
    `);

    await client.query("COMMIT");
    return result.rowCount ?? 0;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

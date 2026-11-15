import { Router } from "express";
import { db } from "../database/db.js";
import { getStaffUser, requireStaffAuth } from "../middleware/staffAuth.js";

// ALO_NOW_GPS_SESSIONS_V5: all writes are transactional and consent-bound.
const router = Router();
// GPS ingestion requires active retention cleanup.
const on = () =>
  process.env.ALO_NOW_GPS_INGEST_ENABLED === "true" &&
  process.env.ALO_NOW_GPS_CLEANUP_ENABLED === "true";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function validId(id: string) {
  return /^[0-9]{1,19}$/.test(id) && BigInt(id) > 0n && BigInt(id) <= 9223372036854775807n;
}
function gpsNumber(n: unknown, min: number, max: number): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= min && n <= max;
}

router.post("/deliveries/:deliveryId/location/start", requireStaffAuth, async (req, res) => {
  if (!on()) return res.status(503).json({ ok: false, error: "GPS_DISABLED" });
  const id = String(req.params.deliveryId ?? "");
  if (!validId(id)) return res.status(400).json({ ok: false, error: "INVALID_DELIVERY_ID" });
  const staff = getStaffUser(res);
  const client = await db.connect().catch(() => null);
  if (!client) return res.status(503).json({ ok: false, error: "GPS_DB_UNAVAILABLE" });
  try {
    await client.query("BEGIN");
    const auth = await client.query(`
      SELECT d.id FROM alo_now_deliveries d JOIN alo_driver_profiles p
        ON p.staff_user_id = $2::bigint
      WHERE d.id = $1::bigint AND d.assigned_driver_user_id = $2::bigint
        AND d.delivery_status IN ('PICKED_UP','ON_THE_WAY')
        AND p.approved IS TRUE AND p.availability_status = 'ONLINE'
      FOR UPDATE OF d, p`, [id, staff.id]);
    if (!auth.rowCount) {
      await client.query("ROLLBACK");
      return res.status(409).json({ ok: false, error: "DRIVER_NOT_AUTHORIZED" });
    }
    const consent = await client.query<{session_id: string}>(`
      INSERT INTO alo_now_gps_consents
        (delivery_id,driver_user_id,session_id,enabled,updated_at)
      VALUES ($1::bigint,$2::bigint,gen_random_uuid(),TRUE,NOW())
      ON CONFLICT (delivery_id) DO UPDATE SET
        driver_user_id=EXCLUDED.driver_user_id,
        session_id=gen_random_uuid(),enabled=TRUE,updated_at=NOW()
      RETURNING session_id`, [id, staff.id]);
    await client.query("DELETE FROM alo_now_driver_locations WHERE delivery_id=$1::bigint", [id]);
    await client.query("COMMIT");
    return res.json({ ok: true, sessionId: consent.rows[0].session_id });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("ALO NOW GPS START ERROR", e);
    return res.status(503).json({ok:false,error:"GPS_START_UNAVAILABLE"});
  } finally { client.release(); }
});

router.post("/deliveries/:deliveryId/location", requireStaffAuth, async (req, res) => {
  if (!on()) return res.status(503).json({ok:false,error:"GPS_DISABLED"});
  const id = String(req.params.deliveryId ?? "");
  const { sessionId, latitude, longitude, accuracyMeters } = req.body ?? {};
  if (!validId(id) || typeof sessionId !== "string" || !uuid.test(sessionId) ||
      !gpsNumber(latitude,45,48.5) || !gpsNumber(longitude,5,11) ||
      !gpsNumber(accuracyMeters,0,150)) {
    return res.status(400).json({ok:false,error:"INVALID_GPS_SAMPLE"});
  }
  const staff = getStaffUser(res);
  const client = await db.connect().catch(() => null);
  if (!client) return res.status(503).json({ok:false,error:"GPS_DB_UNAVAILABLE"});
  try {
    await client.query("BEGIN");
    const auth = await client.query(`
      SELECT c.delivery_id FROM alo_now_deliveries d
      JOIN alo_driver_profiles p ON p.staff_user_id=$2::bigint
      JOIN alo_now_gps_consents c ON c.delivery_id=d.id
      WHERE d.id=$1::bigint AND d.assigned_driver_user_id=$2::bigint
        AND d.delivery_status IN ('PICKED_UP','ON_THE_WAY')
        AND p.approved IS TRUE AND p.availability_status='ONLINE'
        AND c.driver_user_id=$2::bigint AND c.enabled IS TRUE
        AND c.session_id=$3::uuid
        -- ALO_NOW_GPS_SESSION_TIMEOUT_V6
        AND c.updated_at > NOW() - INTERVAL '2 minutes'
      FOR UPDATE OF d,p,c`, [id,staff.id,sessionId]);
    if (!auth.rowCount) {
      await client.query("ROLLBACK");
      return res.status(409).json({ok:false,error:"GPS_CONSENT_INACTIVE"});
    }
    await client.query(`
      INSERT INTO alo_now_driver_locations
        (delivery_id,driver_user_id,latitude,longitude,accuracy_meters,received_at)
      VALUES ($1::bigint,$2::bigint,$3,$4,$5,NOW())
      ON CONFLICT (delivery_id) DO UPDATE SET
        driver_user_id=EXCLUDED.driver_user_id,latitude=EXCLUDED.latitude,
        longitude=EXCLUDED.longitude,accuracy_meters=EXCLUDED.accuracy_meters,
        received_at=NOW()`, [id,staff.id,latitude,longitude,accuracyMeters]);
    await client.query("UPDATE alo_now_gps_consents SET updated_at=NOW() WHERE delivery_id=$1::bigint", [id]);
    await client.query("COMMIT");
    return res.json({ok:true});
  } catch(e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("ALO NOW GPS UPLOAD ERROR",e);
    return res.status(503).json({ok:false,error:"GPS_UPLOAD_UNAVAILABLE"});
  } finally { client.release(); }
});

// Consent withdrawal must remain available even when GPS ingestion is disabled.
// Authentication, session ownership and database checks still apply.
router.delete("/deliveries/:deliveryId/location", requireStaffAuth, async (req, res) => {
  const id = String(req.params.deliveryId ?? "");
  const sessionId: unknown = req.body?.sessionId;
  if (!validId(id) || typeof sessionId !== "string" || !uuid.test(sessionId)) {
    return res.status(400).json({ok:false,error:"INVALID_GPS_SESSION"});
  }
  const staff = getStaffUser(res);
  const client = await db.connect().catch(() => null);
  if (!client) return res.status(503).json({ok:false,error:"GPS_DB_UNAVAILABLE"});
  try {
    await client.query("BEGIN");
    const auth = await client.query(`
      SELECT c.delivery_id FROM alo_now_deliveries d
      JOIN alo_now_gps_consents c ON c.delivery_id=d.id
      WHERE d.id=$1::bigint AND d.assigned_driver_user_id=$2::bigint
        AND c.driver_user_id=$2::bigint AND c.session_id=$3::uuid
      FOR UPDATE OF d,c`, [id,staff.id,sessionId]);
    if (!auth.rowCount) {
      await client.query("ROLLBACK");
      return res.status(409).json({ok:false,error:"GPS_SESSION_NOT_CURRENT"});
    }
    await client.query("UPDATE alo_now_gps_consents SET enabled=FALSE,updated_at=NOW() WHERE delivery_id=$1::bigint",[id]);
    await client.query("DELETE FROM alo_now_driver_locations WHERE delivery_id=$1::bigint",[id]);
    await client.query("COMMIT");
    return res.json({ok:true});
  } catch(e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("ALO NOW GPS STOP ERROR",e);
    return res.status(503).json({ok:false,error:"GPS_STOP_UNAVAILABLE"});
  } finally { client.release(); }
});

export default router;

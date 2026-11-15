// ALO_DOOR_V1575_API
// Public QR doorbell + authenticated staff control.
// Requires aloDoor.v1574.sql migration.
// No automatic schema changes, deploys or Shopify writes.

import { Router } from "express";
import { db } from "../database/db.js";
import {
  requireStaffAuth,
  getStaffUser,
} from "../middleware/staffAuth.js";

import { sendAloDoorRingPushV1589 } from "../modules/staff/aloDoorPush.v1589.js";

const router = Router();

type Location = "AARAU" | "OLTEN";
type DoorStatus = "OPEN" | "BACK_SOON" | "CLOSED";

const locations = new Set(["AARAU", "OLTEN"]);
const states = new Set(["OPEN", "BACK_SOON", "CLOSED"]);

function locationOf(raw: unknown): Location | null {
  const value = String(raw ?? "").toUpperCase();
  return locations.has(value) ? value as Location : null;
}

function canAccess(staff: ReturnType<typeof getStaffUser>,
                   location: Location): boolean {
  return staff.role === "ADMIN" ||
    staff.allowedWorkspaces.includes(location);
}

const recent = new Map<string, number>();
function limited(req: any, location: string, action: string): boolean {
  const now = Date.now();
  if (recent.size > 5000) {
    for (const [key, time] of recent) {
      if (now - time > 120000) recent.delete(key);
    }
  }
  const key = `${req.ip ?? "unknown"}:${location}:${action}`;
  const last = recent.get(key) ?? 0;
  if (now - last < 30000) return true;
  recent.set(key, now);
  return false;
}


// ALO_DOOR_V1587_PUBLIC_CORS
// Public customer endpoints only. Staff endpoints remain protected.
router.use("/public", (req, res, next) => {
  const origin = req.headers.origin;

  const allowedOrigins = new Set([
    "https://alokiosk.ch",
    "https://www.alokiosk.ch",
  ]);

  res.setHeader("Vary", "Origin");

  if (origin && allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, POST, OPTIONS"
    );
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type"
    );
    res.setHeader("Access-Control-Max-Age", "600");
  }

  if (req.method === "OPTIONS") {
    return res.sendStatus(
      origin && allowedOrigins.has(origin) ? 204 : 403
    );
  }

  return next();
});

router.get("/public/:location", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const location = locationOf(req.params.location);
  if (!location) return res.status(404).json({ok:false});

  try {
    const result = await db.query(
      `SELECT location_id, door_status, return_at, updated_at
       FROM alo_door_locations WHERE location_id = $1`,
      [location]
    );
    if (!result.rows[0]) {
      return res.status(503).json({ok:false,error:"DOOR_NOT_READY"});
    }
    return res.json({
      ok:true,
      location,
      status:result.rows[0].door_status,
      returnAt:result.rows[0].return_at,
      updatedAt:result.rows[0].updated_at,
    });
  } catch {
    return res.status(503).json({ok:false,error:"DOOR_UNAVAILABLE"});
  }
});

router.post("/public/:location/ring", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const location = locationOf(req.params.location);
  if (!location) return res.status(404).json({ok:false});

  if (limited(req, location, "RING")) {
    return res.status(429).json({
      ok:false,error:"PLEASE_WAIT_BEFORE_RINGING"
    });
  }

  try {
    // Global location throttle also applies across backend instances.
    // This is an initial abuse limit, not a distributed
    // per-visitor rate limiter.
    const result = await db.query(
      `INSERT INTO alo_door_events(location_id,event_type)
       SELECT l.location_id, 'RING'
       FROM alo_door_locations l
       WHERE l.location_id = $1
         AND l.door_status IN ('OPEN','BACK_SOON')
         AND (
           SELECT COUNT(*) FROM alo_door_events e
           WHERE e.location_id = $1
             AND e.event_type = 'RING'
             AND e.created_at > NOW() - INTERVAL '1 minute'
         ) < 12
       RETURNING id,created_at`,
      [location]
    );

    if (!result.rows[0]) {
      return res.status(409).json({
        ok:false,error:"RING_NOT_AVAILABLE"
      });
    }


    // ALO_DOOR_V1589_PUSH_AFTER_RING
    // The ring is already committed in PostgreSQL.
    // Push failure must not erase the customer request.
    const doorEventId = String(result.rows[0].id);
    let pushAccepted = 0;

    try {
      const pushResult = await sendAloDoorRingPushV1589(
        location,
        doorEventId
      );
      pushAccepted = pushResult.accepted;
    } catch (pushError) {
      console.error("ALO DOOR PUSH DELIVERY ERROR", {
        location,
        eventId: doorEventId,
        reason:
          pushError instanceof Error
            ? pushError.message
            : "UNKNOWN"
      });
    }

    return res.status(201).json({
      ok:true,
      message:"KLINGEL_GESENDET",
        pushAccepted,
      id:String(result.rows[0].id),
    });
  } catch {
    return res.status(503).json({
      ok:false,error:"DOOR_UNAVAILABLE"
    });
  }
});

router.post("/public/:location/wish", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const location = locationOf(req.params.location);
  if (!location) return res.status(404).json({ok:false});

  const wish = typeof req.body?.wish === "string"
    ? req.body.wish.trim() : "";

  if (wish.length < 2 || wish.length > 500) {
    return res.status(400).json({
      ok:false,error:"INVALID_WISH_LENGTH"
    });
  }

  if (limited(req, location, "WISH")) {
    return res.status(429).json({
      ok:false,error:"PLEASE_WAIT_BEFORE_SENDING"
    });
  }

  try {
    const result = await db.query(
      `INSERT INTO alo_door_events
        (location_id,event_type,wish_text)
       SELECT location_id,'PRODUCT_WISH',$2
       FROM alo_door_locations
       WHERE location_id = $1 AND door_status = 'CLOSED'
         AND (
           SELECT COUNT(*) FROM alo_door_events
           WHERE location_id = $1
             AND event_type = 'PRODUCT_WISH'
             AND created_at > NOW() - INTERVAL '1 minute'
         ) < 10
       RETURNING id`,
      [location,wish]
    );

    if (!result.rows[0]) {
      return res.status(409).json({
        ok:false,error:"WISH_NOT_AVAILABLE"
      });
    }

    return res.status(201).json({
      ok:true,message:"DANKE_FUER_DEIN_FEEDBACK"
    });
  } catch {
    return res.status(503).json({
      ok:false,error:"DOOR_UNAVAILABLE"
    });
  }
});

// All staff endpoints require an authenticated session.
router.use("/staff",requireStaffAuth);

router.get("/staff/:location", async (req,res) => {
  res.setHeader("Cache-Control","no-store");
  const location = locationOf(req.params.location);
  if (!location) return res.status(404).json({ok:false});

  const staff = getStaffUser(res);
  if (!canAccess(staff,location)) {
    return res.status(403).json({ok:false,error:"FORBIDDEN"});
  }

  try {
    const state = await db.query(
      `SELECT door_status,return_at,updated_at
       FROM alo_door_locations WHERE location_id=$1`,
      [location]
    );

    const events = await db.query(
      `SELECT id,event_type,wish_text,event_status,
              created_at,acknowledged_at
       FROM alo_door_events
       WHERE location_id=$1
       ORDER BY created_at DESC LIMIT 50`,
      [location]
    );

    return res.json({
      ok:true,
      location,
      state:state.rows[0] ?? null,
      events:events.rows,
    });
  } catch {
    return res.status(503).json({ok:false,error:"DOOR_UNAVAILABLE"});
  }
});

router.patch("/staff/:location/status",async(req,res)=>{
  const location = locationOf(req.params.location);
  if (!location) return res.status(404).json({ok:false});

  const staff = getStaffUser(res);
  if (!canAccess(staff,location)) {
    return res.status(403).json({ok:false,error:"FORBIDDEN"});
  }

  const status = req.body?.status as DoorStatus;
  const minutes = req.body?.minutes;

  if (!states.has(status)) {
    return res.status(400).json({ok:false,error:"INVALID_STATUS"});
  }

  if (status === "BACK_SOON" &&
      (!Number.isInteger(minutes) || minutes < 1 || minutes > 60)) {
    return res.status(400).json({ok:false,error:"INVALID_MINUTES"});
  }

  try {
    const result = await db.query(
      `UPDATE alo_door_locations
       SET door_status=$2,
           return_at=CASE
             WHEN $2='BACK_SOON'
             THEN NOW()+($3::integer * INTERVAL '1 minute')
             ELSE NULL END,
           updated_by_staff_user_id=$4::bigint,
           updated_at=NOW()
       WHERE location_id=$1
       RETURNING door_status,return_at,updated_at`,
      [location,status,status==="BACK_SOON"?minutes:0,staff.id]
    );

    if (!result.rows[0]) {
      return res.status(503).json({ok:false,error:"DOOR_NOT_READY"});
    }

    return res.json({ok:true,location,state:result.rows[0]});
  } catch {
    return res.status(503).json({ok:false,error:"DOOR_UNAVAILABLE"});
  }
});

router.post("/staff/:location/events/:eventId/ack",async(req,res)=>{
  const location = locationOf(req.params.location);
  if (!location) return res.status(404).json({ok:false});

  const staff = getStaffUser(res);
  if (!canAccess(staff,location)) {
    return res.status(403).json({ok:false,error:"FORBIDDEN"});
  }

  const eventId = String(req.params.eventId ?? "");
  if (!/^[1-9]\d*$/.test(eventId)) {
    return res.status(400).json({ok:false,error:"INVALID_EVENT_ID"});
  }

  try {
    const result = await db.query(
      `UPDATE alo_door_events
       SET event_status='ACKNOWLEDGED',
           acknowledged_by_staff_user_id=$3::bigint,
           acknowledged_at=NOW()
       WHERE location_id=$1 AND id=$2::bigint
         AND event_status='NEW'
       RETURNING id,event_status,acknowledged_at`,
      [location,eventId,staff.id]
    );

    if (!result.rows[0]) {
      return res.status(409).json({
        ok:false,error:"EVENT_NOT_OPEN"
      });
    }

    return res.json({ok:true,event:result.rows[0]});
  } catch {
    return res.status(503).json({ok:false,error:"DOOR_UNAVAILABLE"});
  }
});

export default router;

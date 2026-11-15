import { Router } from "express";
import { requireStaffAuth, getStaffUser } from "../middleware/staffAuth.js";

/** TEST ONLY: authenticated Staff -> server-to-server routing, never real orders. */
export const aloNowRouteBridgeRouter = Router();
const nextAllowed = new Map<string, number>();

// V594: Optional production-session verification for TEST ROUTING only.
// OFF by default. Never grants access to real ALO NOW operations.
async function requireTestRoutingIdentity(
  req: import("express").Request,
  res: import("express").Response,
  next: import("express").NextFunction
) {
  if (req.get("X-ALO-NOW-SESSION-SOURCE") !== "production") {
    return requireStaffAuth(req, res, next);
  }

  if (
    process.env.ALO_NOW_PRODUCTION_SESSION_BRIDGE_ENABLED !== "true"
  ) {
    return res.status(404).json({
      ok:false,
      error:"PRODUCTION_TEST_SESSION_BRIDGE_DISABLED"
    });
  }

  const authorization = req.get("Authorization") ?? "";

  if (
    !authorization.startsWith("Bearer ") ||
    authorization.length < 40 ||
    authorization.length > 4096
  ) {
    return res.status(401).json({
      ok:false,
      error:"PRODUCTION_SESSION_REQUIRED"
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(
      "https://alo-platform-production.up.railway.app/api/staff-auth/me",
      {
        method:"GET",
        headers:{
          Authorization:authorization,
          Accept:"application/json"
        },
        redirect:"error",
        signal:controller.signal
      }
    );

    if (!response.ok) {
      return res.status(401).json({
        ok:false,
        error:"PRODUCTION_SESSION_INVALID"
      });
    }

    const data = await response.json() as {
      ok?:boolean;
      user?:{
        id?:string | number;
        active?:boolean;
      };
    };

    const userId = String(data.user?.id ?? "").trim();

    if (
      data.ok !== true ||
      !/^[0-9]+$/.test(userId) ||
      data.user?.active === false
    ) {
      return res.status(401).json({
        ok:false,
        error:"PRODUCTION_IDENTITY_INVALID"
      });
    }

    const allowedIds = (
      process.env.ALO_NOW_PRODUCTION_TEST_USER_IDS ?? ""
    )
      .split(",")
      .map(value => value.trim())
      .filter(Boolean);

    if (!allowedIds.includes(userId)) {
      return res.status(403).json({
        ok:false,
        error:"PRODUCTION_TEST_USER_NOT_ALLOWED"
      });
    }

    // Only this routing endpoint consumes this scoped identity.
    // The production token is not persisted or logged.
    res.locals.aloNowProductionTestIdentity = {
      id:"production:" + userId,
      active:true
    };

    return next();
  } catch {
    return res.status(503).json({
      ok:false,
      error:"PRODUCTION_SESSION_VERIFICATION_UNAVAILABLE"
    });
  } finally {
    clearTimeout(timeout);
  }
}

aloNowRouteBridgeRouter.post(
  "/plan",
  requireTestRoutingIdentity,
  async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (process.env.ALO_NOW_ROUTE_BRIDGE_ENABLED !== "true") {
    return res.status(404).json({ ok: false, error: "ROUTE_BRIDGE_DISABLED" });
  }
  const productionIdentity =
    res.locals.aloNowProductionTestIdentity as
      | {id:string;active:boolean}
      | undefined;

  const staff = productionIdentity ?? getStaffUser(res);

  const allowed = productionIdentity
    ? [productionIdentity.id]
    : (process.env.ALO_NOW_TEST_ROUTE_USER_IDS ?? "")
        .split(",")
        .map(value => value.trim())
        .filter(Boolean);

  if (!allowed.includes(String(staff.id)) || !staff.active) {
    return res.status(403).json({ ok: false, error: "TEST_DRIVER_NOT_ALLOWED" });
  }
  const body = req.body;

  const legRequested =
    !!body &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    ("toStopId" in body);

  // ALO_NOW_V634_GPS_BRIDGE
  const allowedPointIds = ["KIOSK", "A", "B", "C"];
  const allowedStopIds = ["A", "B", "C"];

  const gpsRequested =
    body?.fromStopId === "GPS";

  const gpsPosition = body?.fromPosition;

  const validGps =
    gpsRequested &&
    !!gpsPosition &&
    typeof gpsPosition === "object" &&
    !Array.isArray(gpsPosition) &&
    Object.keys(gpsPosition).every(key =>
      [
        "latitude",
        "longitude",
        "accuracyMeters",
        "measuredAtMs"
      ].includes(key)
    ) &&
    typeof gpsPosition.latitude === "number" &&
    typeof gpsPosition.longitude === "number" &&
    typeof gpsPosition.accuracyMeters === "number" &&
    typeof gpsPosition.measuredAtMs === "number" &&
    Number.isFinite(gpsPosition.latitude) &&
    Number.isFinite(gpsPosition.longitude) &&
    Number.isFinite(gpsPosition.accuracyMeters) &&
    Number.isFinite(gpsPosition.measuredAtMs) &&
    gpsPosition.latitude >= 46.9 &&
    gpsPosition.latitude <= 47.9 &&
    gpsPosition.longitude >= 7.3 &&
    gpsPosition.longitude <= 9.2 &&
    gpsPosition.accuracyMeters >= 0 &&
    gpsPosition.accuracyMeters <= 50 &&
    Number.isInteger(gpsPosition.measuredAtMs) &&
    Date.now() - gpsPosition.measuredAtMs <= 60000 &&
    Date.now() - gpsPosition.measuredAtMs >= -10000;

  const requestedStopIds =
    body?.stopIds === undefined
      ? ["A", "B", "C"]
      : body?.stopIds;

  const requestedOrigin =
    body?.fromStopId ?? "KIOSK";

  const invalid =
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some(key =>
      !(
        legRequested
          ? [
              "vehicle",
              "fromStopId",
              "toStopId",
              "fromPosition"
            ]
          : [
              "vehicle",
              "preferredNextStopId",
              "stopIds",
              "fromStopId",
              "fromPosition"
            ]
      ).includes(key)
    ) ||
    (body.vehicle !== "CAR" && body.vehicle !== "BICYCLE") ||
    (
      legRequested
        ? (
            !allowedPointIds.includes(body.toStopId) ||
            (
              gpsRequested
                ? !validGps
                : (
                    !allowedPointIds.includes(body.fromStopId) ||
                    body.fromStopId === body.toStopId ||
                    body.fromPosition !== undefined
                  )
            )
          )
        : (
          (
            gpsRequested
              ? !validGps
              : (
                  !allowedPointIds.includes(requestedOrigin) ||
                  body.fromPosition !== undefined
                )
          ) ||
          !Array.isArray(requestedStopIds) ||
          requestedStopIds.length < 1 ||
          requestedStopIds.length > 3 ||
          requestedStopIds.some(id =>
            !allowedStopIds.includes(id)
          ) ||
          new Set(requestedStopIds).size !==
            requestedStopIds.length ||
          requestedStopIds.includes(requestedOrigin) ||
          (
            body.preferredNextStopId != null &&
            !requestedStopIds.includes(
              body.preferredNextStopId
            )
          )
        )
    );

  if (invalid) {
    return res.status(400).json({
      ok: false,
      error: "INVALID_TEST_REQUEST"
    });
  }
  const now = Date.now();
  if ((nextAllowed.get(String(staff.id)) ?? 0) > now) {
    return res.status(429).json({ ok: false, error: "TEST_ROUTE_RATE_LIMIT" });
  }
  const token = process.env.ALO_NOW_ROUTING_SERVICE_TOKEN;
  const target = process.env.ALO_NOW_ROUTING_SERVICE_URL;
  if (!token || token.length < 32 ||
      target !== "https://alo-now-routing-staging.up.railway.app") {
    return res.status(503).json({ ok: false, error: "TEST_ROUTE_BRIDGE_NOT_CONFIGURED" });
  }
  nextAllowed.set(String(staff.id), now + 10000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 40000);
  try {
    const upstream = await fetch(target + "/api/alo-now/test-tour/plan", {
      method: "POST", signal: controller.signal,
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify(
        legRequested
          ? {
              vehicle: body.vehicle,
              fromStopId: body.fromStopId,
              toStopId: body.toStopId,
              ...(gpsRequested
                ? {
                    fromPosition: {
                      latitude: gpsPosition.latitude,
                      longitude: gpsPosition.longitude,
                      accuracyMeters: gpsPosition.accuracyMeters,
                      measuredAtMs: gpsPosition.measuredAtMs
                    }
                  }
                : {})
            }
          : {
              vehicle: body.vehicle,
              preferredNextStopId:
                body.preferredNextStopId ?? null,
              fromStopId: requestedOrigin,
              stopIds: requestedStopIds,
              ...(gpsRequested
                ? {
                    fromPosition: {
                      latitude: gpsPosition.latitude,
                      longitude: gpsPosition.longitude,
                      accuracyMeters: gpsPosition.accuracyMeters,
                      measuredAtMs: gpsPosition.measuredAtMs
                    }
                  }
                : {})
            }
      ),
    });
    if (!upstream.ok) return res.status(503).json({ ok: false, error: "TEST_ROUTE_UPSTREAM_UNAVAILABLE" });
    const response: unknown = await upstream.json();
    if (!response || typeof response !== "object" ||
        (response as {ok?: unknown}).ok !== true ||
        (response as {testMode?:unknown}).testMode !== true ||
        !Array.isArray((response as {geometry?: {coordinates?:unknown}}).geometry?.coordinates)) {
      return res.status(503).json({ ok: false, error: "TEST_ROUTE_UPSTREAM_INVALID" });
    }
    return res.json(response);
  } catch {
    return res.status(503).json({ ok: false, error: "TEST_ROUTE_UPSTREAM_UNAVAILABLE" });
  } finally { clearTimeout(timer); }
});

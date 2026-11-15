
import { Router } from "express";
import { getAloNowTourGeometry } from "../modules/aloNow/aloNowTourGeometry.service.js";
import {
  requireStaffAuth,
  getStaffUser,
} from "../middleware/staffAuth.js";
import {
  planVerifiedAloNowTour,
  type VerifiedTourStop,
} from "../modules/aloNow/aloNowTourPlanner.service.js";
import type {
  AloRoadPoint,
} from "../modules/aloNow/aloNowTourMatrix.service.js";

export const aloNowTestTourRouter = Router();

const lastRequest = new Map<string, number>();

const isPoint = (value: unknown): value is AloRoadPoint =>
  Array.isArray(value) &&
  value.length === 2 &&
  value.every(
    x => typeof x === "number" && Number.isFinite(x)
  ) &&
  value[0] >= 5.8 &&
  value[0] <= 10.6 &&
  value[1] >= 45.6 &&
  value[1] <= 47.9;

aloNowTestTourRouter.post(
  "/plan",
  requireStaffAuth,
  async (req, res) => {
    res.setHeader("Cache-Control", "no-store");

    // Disabled unless explicitly enabled later.
    if (process.env.ALO_NOW_TEST_ROUTING_ENABLED !== "true") {
      return res.status(404).json({
        ok: false,
        error: "TEST_ROUTING_DISABLED",
      });
    }

    const user = getStaffUser(res);
    const allowed = new Set(
      (process.env.ALO_NOW_TEST_ROUTE_USER_IDS ?? "")
        .split(",")
        .map(id => id.trim())
        .filter(Boolean)
    );

    if (!allowed.has(String(user.id))) {
      return res.status(403).json({
        ok: false,
        error: "TEST_DRIVER_NOT_ALLOWED",
      });
    }

    // Basic per-process throttle, in addition to the allowlist.
    const now = Date.now();
    const id = String(user.id);
    const previous = lastRequest.get(id) ?? 0;

    if (now - previous < 15000) {
      return res.status(429).json({
        ok: false,
        error: "TEST_ROUTE_RATE_LIMIT",
      });
    }

    const body = req.body ?? {};
    const rawStops = body.stops;

    if (
      !isPoint(body.origin) ||
      !isPoint(body.returnKiosk) ||
      !Array.isArray(rawStops) ||
      rawStops.length < 1 ||
      rawStops.length > 3 ||
      !["CAR", "BICYCLE"].includes(body.vehicle)
    ) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_TEST_ROUTE",
      });
    }

    const allowedLetters = ["A", "B", "C"];

    const stops: VerifiedTourStop[] = [];

    for (const stop of rawStops) {
      if (
        !stop ||
        typeof stop !== "object" ||
        !allowedLetters.includes(stop.id) ||
        !isPoint(stop.coordinates)
      ) {
        return res.status(400).json({
          ok: false,
          error: "INVALID_TEST_STOP",
        });
      }

      stops.push({
        id: stop.id,
        label: `Teststopp ${stop.id}`,
        coordinates: stop.coordinates,
      });
    }

    if (
      new Set(stops.map(stop => stop.id)).size !==
      stops.length
    ) {
      return res.status(400).json({
        ok: false,
        error: "DUPLICATE_TEST_STOP",
      });
    }

    const preferred =
      body.preferredNextStopId == null
        ? null
        : body.preferredNextStopId;

    if (
      preferred !== null &&
      !stops.some(stop => stop.id === preferred)
    ) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_PREFERRED_STOP",
      });
    }

    if (
      !process.env.ALO_NOW_ORS_API_KEY?.trim()
    ) {
      return res.status(503).json({
        ok: false,
        error: "TEST_ROUTING_PROVIDER_NOT_CONFIGURED",
      });
    }

    lastRequest.set(id, now);

    try {
      // Only explicitly supplied TEST coordinates.
      // No actual order lookup or mutation.
      const tour = await planVerifiedAloNowTour({
        origin: body.origin,
        returnKiosk: body.returnKiosk,
        stops,
        vehicle: body.vehicle,
        preferredNextStopId: preferred,
      });

      // Both route order and geometry must be provider-verified.
      // Failure returns 503; never pretend a straight line is a road route.
      const geometry = await getAloNowTourGeometry(tour);
      if (geometry.stopOrder.join("|") !== tour.stops.map(s => s.id).join("|")) {
        throw new Error("ROUTE_ORDER_MISMATCH");
      }
      return res.json({
        ok: true,
        testMode: true,
        routeCalculated: true,
        ...tour,
        // Waypoints use [longitude, latitude] (GeoJSON convention).
        geometry,
      });
    } catch {
      return res.status(503).json({
        ok: false,
        error: "TEST_ROUTE_CALCULATION_FAILED",
      });
    }
  }
);

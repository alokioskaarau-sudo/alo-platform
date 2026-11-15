
import express from "express";
import { timingSafeEqual } from "node:crypto";

import { planVerifiedAloNowTour }
  from "./modules/aloNow/aloNowTourPlanner.service.js";
import { getAloNowTourGeometry }
  from "./modules/aloNow/aloNowTourGeometry.service.js";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "8kb" }));

const fixedOrigin = [8.04458999633789, 47.39219284057617] as const;

const fixedStops = [
  {
    id: "A",
    label: "Test A · Hintere Bahnhofstrasse 12",
    coordinates: [8.051007270812988, 47.39057540893555] as const,
  },
  {
    id: "B",
    label: "Test B · Tellistrasse 67.1",
    coordinates: [8.058028221130371, 47.39776611328125] as const,
  },
  {
    id: "C",
    label: "Test C · Bachstrasse 111",
    coordinates: [8.056880950927734, 47.38673782348633] as const,
  },
];


type TestPointId = "KIOSK" | "A" | "B" | "C";

function pointCoordinates(id: TestPointId):
  readonly [number, number] {
  if (id === "KIOSK") return fixedOrigin;

  const stop = fixedStops.find(item => item.id === id);
  if (!stop) throw new Error("INVALID_TEST_POINT");

  return stop.coordinates;
}


// ALO_NOW_V633A_LIVE_ORIGIN
// Nur Navigations-Testgebiet; nie für echte Bestellungen
// oder die Berechnung von Fahrerprovisionen verwenden.
function parseTestGpsOrigin(
  raw: unknown
): readonly [number, number] | null {
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw)
  ) return null;

  const value = raw as Record<string, unknown>;

  if (
    Object.keys(value).some(key =>
      ![
        "latitude",
        "longitude",
        "accuracyMeters",
        "measuredAtMs"
      ].includes(key)
    )
  ) return null;

  const latitude = value.latitude;
  const longitude = value.longitude;
  const accuracy = value.accuracyMeters;
  const measuredAt = value.measuredAtMs;

  if (
    typeof latitude !== "number" ||
    typeof longitude !== "number" ||
    typeof accuracy !== "number" ||
    typeof measuredAt !== "number" ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    !Number.isFinite(accuracy) ||
    !Number.isFinite(measuredAt) ||
    accuracy < 0 ||
    accuracy > 50 ||
    !Number.isInteger(measuredAt)
  ) return null;

  const age = Date.now() - measuredAt;

  if (age < -10000 || age > 60000) return null;

  const toRadians = (degrees:number) =>
    degrees * Math.PI / 180;

  const latDelta = toRadians(
    latitude - fixedOrigin[1]
  );
  const lonDelta = toRadians(
    longitude - fixedOrigin[0]
  );

  const a =
    Math.sin(latDelta / 2) ** 2 +
    Math.cos(toRadians(fixedOrigin[1])) *
    Math.cos(toRadians(latitude)) *
    Math.sin(lonDelta / 2) ** 2;

  const kilometres =
    6371 * 2 *
    Math.atan2(
      Math.sqrt(a),
      Math.sqrt(Math.max(0, 1 - a))
    );

  if (
    !Number.isFinite(kilometres) ||
    kilometres > 80
  ) return null;

  return [longitude, latitude] as const;
}

async function calculateTestLeg(
  fromStopId: TestPointId | "GPS",
  toStopId: TestPointId,
  vehicle: "CAR" | "BICYCLE",
  liveOrigin?: readonly [number, number]
) {
  const apiKey = process.env.ALO_NOW_ORS_API_KEY;
  if (!apiKey) throw new Error("ORS_NOT_CONFIGURED");

  const originCoordinates =
    liveOrigin ??
    (
      fromStopId === "GPS"
        ? null
        : pointCoordinates(fromStopId)
    );

  if (!originCoordinates) {
    throw new Error("GPS_ORIGIN_REQUIRED");
  }

  const profile =
    vehicle === "CAR"
      ? "driving-car"
      : "cycling-regular";

  const response = await fetch(
    "https://api.openrouteservice.org/v2/directions/" +
      profile + "/geojson",
    {
      method: "POST",
      signal: AbortSignal.timeout(25000),
      headers: {
        Authorization: apiKey,
        "Content-Type": "application/json",
        Accept: "application/geo+json"
      },
      body: JSON.stringify({
        coordinates: [
          originCoordinates,
          pointCoordinates(toStopId)
        ],
        instructions: fromStopId === "GPS",
        ...(fromStopId === "GPS" ? { language: "de" } : {})
      })
    }
  );

  if (!response.ok) {
    throw new Error("ORS_SEGMENT_UNAVAILABLE");
  }

  const payload = await response.json() as {
    features?: Array<{
      geometry?: {
        coordinates?: Array<[number, number]>
      };
      properties?: {
        summary?: {
          distance?: number;
          duration?: number
        };
        segments?: Array<{
          steps?: Array<{
            instruction: string;
            type: number;
            distance: number;
            duration: number;
            way_points: [number, number];
          }>
        }>
      }
    }>
  };

  const feature = payload.features?.[0];
  const coordinates = feature?.geometry?.coordinates;
  const distance = feature?.properties?.summary?.distance;
  const duration = feature?.properties?.summary?.duration;
  const segments = feature?.properties?.segments;
  const steps =
    Array.isArray(segments) &&
    segments.every(segment => Array.isArray(segment?.steps))
      ? segments.flatMap(segment => segment.steps ?? [])
      : [];

  const valid =
    Array.isArray(coordinates) &&
    coordinates.length >= 2 &&
    coordinates.length <= 20000 &&
    coordinates.every(point =>
      Array.isArray(point) &&
      point.length === 2 &&
      Number.isFinite(point[0]) &&
      Number.isFinite(point[1]) &&
      point[0] >= 5.8 &&
      point[0] <= 10.6 &&
      point[1] >= 45.6 &&
      point[1] <= 47.9
    ) &&
    typeof distance === "number" &&
    Number.isFinite(distance) &&
    distance > 0 &&
    typeof duration === "number" &&
    Number.isFinite(duration) &&
    duration > 0;

  if (!valid) {
    throw new Error("INVALID_ORS_SEGMENT");
  }

  if (fromStopId === "GPS") {
    const pointCount = coordinates?.length ?? 0;
    const validSteps =
      steps.length >= 1 &&
      steps.length <= 200 &&
      steps.every(step =>
        !!step &&
        typeof step.instruction === "string" &&
        step.instruction.trim().length > 0 &&
        step.instruction.length <= 240 &&
        Number.isInteger(step.type) &&
        step.type >= 0 &&
        step.type <= 13 &&
        Number.isFinite(step.distance) &&
        step.distance >= 0 &&
        Number.isFinite(step.duration) &&
        step.duration >= 0 &&
        Array.isArray(step.way_points) &&
        step.way_points.length === 2 &&
        Number.isInteger(step.way_points[0]) &&
        Number.isInteger(step.way_points[1]) &&
        step.way_points[0] >= 0 &&
        step.way_points[0] <= step.way_points[1] &&
        step.way_points[1] < pointCount
      );

    if (!validSteps) {
      throw new Error("INVALID_ORS_INSTRUCTIONS");
    }
  }

  return {
    ok: true,
    testMode: true,
    routeCalculated: true,
    fromStopId,
    toStopId,
    geometry: {
      coordinates,
      distanceMetres: distance,
      durationSeconds: duration,
      stopOrder: [toStopId],
      includesReturnKiosk: toStopId === "KIOSK",
      provider: "OPENROUTESERVICE",
      vehicle,
      maneuvers: fromStopId === "GPS"
        ? steps.map(step => ({
            instruction: step.instruction.trim(),
            type: step.type,
            distanceMetres: step.distance,
            durationSeconds: step.duration,
            fromIndex: step.way_points[0],
            toIndex: step.way_points[1]
          }))
        : []
    }
  };
}

function authorized(header: string | undefined): boolean {
  const secret = process.env.ALO_STAGING_ROUTE_TOKEN;

  if (!secret || secret.length < 32) return false;

  const expected = Buffer.from("Bearer " + secret);
  const received = Buffer.from(header ?? "");

  return (
    expected.length === received.length &&
    timingSafeEqual(expected, received)
  );
}

app.get("/health", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({
    ok: true,
    service: "ALO_NOW_ROUTING_STAGING",
  });
});

app.post("/api/alo-now/test-tour/plan", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  if (!authorized(req.header("authorization"))) {
    return res.status(401).json({
      ok: false,
      error: "UNAUTHORIZED",
    });
  }

  const body = req.body;

  // V532: Fixed staging test legs only.
  const legRequested =
    !!body &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    ("toStopId" in body);

  if (legRequested) {
    const ids = ["KIOSK", "A", "B", "C"];
    const liveOrigin =
      body.fromStopId === "GPS"
        ? parseTestGpsOrigin(body.fromPosition)
        : null;

    const valid =
      Object.keys(body).every(key =>
        [
          "vehicle",
          "fromStopId",
          "toStopId",
          "fromPosition"
        ].includes(key)
      ) &&
      ["CAR", "BICYCLE"].includes(body.vehicle) &&
      ids.includes(body.toStopId) &&
      (
        body.fromStopId === "GPS"
          ? liveOrigin !== null
          : (
              body.fromPosition === undefined &&
              ids.includes(body.fromStopId) &&
              body.fromStopId !== body.toStopId
            )
      );

    if (!valid) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_TEST_LEG"
      });
    }

    try {
      const leg = await calculateTestLeg(
        body.fromStopId,
        body.toStopId,
        body.vehicle,
        liveOrigin ?? undefined
      );

      return res.json(leg);
    } catch {
      return res.status(503).json({
        ok: false,
        error: "TEST_LEG_ROUTING_UNAVAILABLE"
      });
    }
  }

  // V570: Nur verifizierte Staging-Testpunkte.
  // Beliebige Kundenadressen sind nicht erlaubt.
  const allowedStops = ["A", "B", "C"];
  const allowedOrigins = ["KIOSK", "A", "B", "C"];

  const selectedIds =
    body?.stopIds === undefined
      ? ["A", "B", "C"]
      : body.stopIds;

  const fromStopId = body?.fromStopId ?? "KIOSK";
  const liveTourOrigin =
    fromStopId === "GPS"
      ? parseTestGpsOrigin(body?.fromPosition)
      : null;

  const valid =
    !!body &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    Object.keys(body).every(key =>
      [
        "vehicle",
        "preferredNextStopId",
        "stopIds",
        "fromStopId",
        "fromPosition"
      ].includes(key)
    ) &&
    ["CAR", "BICYCLE"].includes(body.vehicle) &&
    (
      fromStopId === "GPS"
        ? liveTourOrigin !== null
        : (
            allowedOrigins.includes(fromStopId) &&
            body.fromPosition === undefined
          )
    ) &&
    Array.isArray(selectedIds) &&
    selectedIds.length >= 1 &&
    selectedIds.length <= 3 &&
    selectedIds.every(id =>
      allowedStops.includes(id)
    ) &&
    new Set(selectedIds).size === selectedIds.length &&
    !selectedIds.includes(fromStopId) &&
    (
      body.preferredNextStopId == null ||
      selectedIds.includes(body.preferredNextStopId)
    );

  if (!valid) {
    return res.status(400).json({
      ok: false,
      error: "INVALID_TEST_TOUR"
    });
  }

  try {
    const selectedStops = fixedStops.filter(
      stop => selectedIds.includes(stop.id)
    );

    const tour = await planVerifiedAloNowTour({
      origin: fromStopId === "GPS"
        ? liveTourOrigin!
        : pointCoordinates(fromStopId),
      returnKiosk: fixedOrigin,
      stops: selectedStops,
      vehicle: body.vehicle,
      preferredNextStopId:
        body.preferredNextStopId ?? null
    });

    const geometry = await getAloNowTourGeometry(
      tour,
      fromStopId === "GPS"
    );

    return res.json({
      ok: true,
      testMode: true,
      routeCalculated: true,
      fromStopId,
      ...tour,
      geometry,
    });
  } catch {
    return res.status(503).json({
      ok: false,
      error: "ROUTING_UNAVAILABLE",
    });
  }
});

// No Shopify, shipping, push or database routes.
app.use((_req, res) => {
  res.status(404).json({
    ok: false,
    error: "NOT_FOUND",
  });
});

function start() {
  if (
    process.env.ALO_RUNTIME_MODE !== "staging" ||
    process.env.RAILWAY_ENVIRONMENT_NAME !== "staging" ||
    !process.env.ALO_NOW_ORS_API_KEY ||
    (process.env.ALO_STAGING_ROUTE_TOKEN?.length ?? 0) < 32
  ) {
    throw new Error("STAGING_CONFIG_REQUIRED");
  }

  const port = Number(process.env.PORT ?? 3000);

  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new Error("INVALID_PORT");
  }

  app.listen(port, "0.0.0.0", () => {
    console.log("ALO NOW STAGING ROUTING READY");
  });
}

start();

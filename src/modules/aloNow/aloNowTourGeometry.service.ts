
import type {
  AloRoadPoint,
  AloRoutingVehicle,
} from "./aloNowTourMatrix.service.js";

import type {
  PlannedAloTour,
} from "./aloNowTourPlanner.service.js";

export type AloTourGeometry = {
  coordinates: AloRoadPoint[];
  distanceMetres: number;
  durationSeconds: number;
  provider: "OPENROUTESERVICE";
  vehicle: AloRoutingVehicle;
  stopOrder: string[];
  includesReturnKiosk: true;
  maneuvers?: Array<{
    instruction: string;
    type: number;
    distanceMetres: number;
    durationSeconds: number;
    fromIndex: number;
    toIndex: number;
  }>;
};

type OrsGeoJson = {
  features?: Array<{
    geometry?: {
      type?: string;
      coordinates?: unknown;
    };
    properties?: {
      summary?: {
        distance?: number;
        duration?: number;
      };
      segments?: Array<{
        steps?: Array<{
          instruction: string;
          type: number;
          distance: number;
          duration: number;
          way_points: [number, number];
        }>;
      }>;
    };
  }>;
};

function validPoint(
  value: unknown
): value is AloRoadPoint {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every(
      x => typeof x === "number" && Number.isFinite(x)
    ) &&
    value[0] >= 5.8 &&
    value[0] <= 10.6 &&
    value[1] >= 45.6 &&
    value[1] <= 47.9
  );
}

function routingProfile(vehicle: AloRoutingVehicle) {
  if (vehicle === "CAR") {
    return "driving-car";
  }

  if (vehicle === "BICYCLE") {
    return "cycling-regular";
  }

  throw new Error("SCOOTER_PROFILE_NOT_VERIFIED");
}

/**
 * Input must come from an authorized, server-verified tour.
 * This function must not receive arbitrary real-order coordinates
 * supplied by an untrusted mobile client.
 *
 * No order changes or customer notifications.
 */
export async function getAloNowTourGeometry(
  tour: PlannedAloTour,
  withInstructions = false
): Promise<AloTourGeometry> {
  if (
    !Array.isArray(tour.stops) ||
    tour.stops.length < 1 ||
    tour.stops.length > 6
  ) {
    throw new Error("INVALID_PLANNED_TOUR");
  }

  const ordered = [...tour.stops].sort(
    (a, b) => a.sequence - b.sequence
  );

  if (
    ordered.some(
      (stop, index) =>
        stop.sequence !== index + 1 ||
        !stop.id?.trim()
    ) ||
    new Set(ordered.map(stop => stop.id)).size !==
      ordered.length
  ) {
    throw new Error("INVALID_TOUR_SEQUENCE");
  }

  const locations: AloRoadPoint[] = [
    tour.origin,
    ...ordered.map(stop => stop.coordinates),
    tour.returnKiosk,
  ];

  if (!locations.every(validPoint)) {
    throw new Error("UNVERIFIED_ROUTE_COORDINATES");
  }

  const key =
    process.env.ALO_NOW_ORS_API_KEY?.trim();

  if (!key) {
    throw new Error("ORS_API_KEY_NOT_CONFIGURED");
  }

  const profile = routingProfile(tour.vehicle);

  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    15000
  );

  try {
    const response = await fetch(
      "https://api.openrouteservice.org/v2/directions/" +
        profile +
        "/geojson",
      {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: key,
          "Content-Type": "application/json",
          Accept: "application/geo+json",
        },
        body: JSON.stringify({
          coordinates: locations,
          instructions: withInstructions,
          ...(withInstructions ? { language: "de" } : {}),
          elevation: false,
        }),
      }
    );

    if (!response.ok) {
      throw new Error(
        "ORS_GEOMETRY_HTTP_" + response.status
      );
    }

    const payload =
      (await response.json()) as OrsGeoJson;

    const feature = payload.features?.[0];

    if (
      feature?.geometry?.type !== "LineString" ||
      !Array.isArray(feature.geometry.coordinates)
    ) {
      throw new Error("ORS_GEOMETRY_MISSING");
    }

    const rawCoordinates =
      feature.geometry.coordinates;

    if (
      rawCoordinates.length < 2 ||
      rawCoordinates.length > 20000 ||
      !rawCoordinates.every(validPoint)
    ) {
      throw new Error("ORS_GEOMETRY_INVALID");
    }

    const distance =
      feature.properties?.summary?.distance;

    const duration =
      feature.properties?.summary?.duration;

    if (
      typeof distance !== "number" ||
      !Number.isFinite(distance) ||
      distance <= 0 ||
      typeof duration !== "number" ||
      !Number.isFinite(duration) ||
      duration <= 0
    ) {
      throw new Error("ORS_GEOMETRY_SUMMARY_INVALID");
    }

    const segments = feature.properties?.segments;
    const steps =
      Array.isArray(segments) &&
      segments.every(segment => Array.isArray(segment?.steps))
        ? segments.flatMap(segment => segment.steps ?? [])
        : [];

    if (withInstructions) {
      const pointCount = rawCoordinates.length;
      const validSteps =
        steps.length >= 1 &&
        steps.length <= 600 &&
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
        throw new Error("ORS_TOUR_INSTRUCTIONS_INVALID");
      }
    }

    return {
      coordinates:
        rawCoordinates as AloRoadPoint[],
      distanceMetres: distance,
      durationSeconds: duration,
      provider: "OPENROUTESERVICE",
      vehicle: tour.vehicle,
      stopOrder: ordered.map(stop => stop.id),
      includesReturnKiosk: true,
      ...(withInstructions
        ? {
            maneuvers: steps.map(step => ({
              instruction: step.instruction.trim(),
              type: step.type,
              distanceMetres: step.distance,
              durationSeconds: step.duration,
              fromIndex: step.way_points[0],
              toIndex: step.way_points[1],
            })),
          }
        : {}),
    };
  } finally {
    clearTimeout(timeout);
  }
}


import {
  getAloNowRoadMatrix,
  type AloRoadPoint,
  type AloRoutingVehicle,
} from "./aloNowTourMatrix.service.js";

import {
  optimizeAloNowTour,
} from "./aloNowTourOptimizer.js";

export type VerifiedTourStop = {
  id: string;
  label: string;
  coordinates: AloRoadPoint;
};

export type VerifiedTourRequest = {
  origin: AloRoadPoint;
  returnKiosk: AloRoadPoint;
  stops: VerifiedTourStop[];
  vehicle: AloRoutingVehicle;
  preferredNextStopId?: string | null;
};

export type PlannedTourStop = {
  id: string;
  label: string;
  coordinates: AloRoadPoint;
  sequence: number;
};

export type PlannedAloTour = {
  stops: PlannedTourStop[];
  origin: AloRoadPoint;
  returnKiosk: AloRoadPoint;
  durationSeconds: number;
  distanceMetres: number;
  provider: "OPENROUTESERVICE";
  vehicle: AloRoutingVehicle;
  manuallyPrioritized: boolean;
};

/**
 * The caller MUST authenticate the driver and validate
 * that each stop belongs to an authorized tour.
 *
 * Coordinates MUST be server-verified before calling.
 * Never use arbitrary client coordinates for real orders.
 *
 * No order mutation, payment or customer notification.
 */
export async function planVerifiedAloNowTour(
  input: VerifiedTourRequest
): Promise<PlannedAloTour> {
  if (
    !Array.isArray(input.stops) ||
    input.stops.length < 1 ||
    input.stops.length > 6
  ) {
    throw new Error("INVALID_TOUR_STOP_COUNT");
  }

  const ids = input.stops.map(
    stop => String(stop.id || "").trim()
  );

  if (
    ids.some(id => !id) ||
    new Set(ids).size !== ids.length
  ) {
    throw new Error("INVALID_TOUR_STOP_IDS");
  }

  const preferred =
    input.preferredNextStopId ?? null;

  if (
    preferred !== null &&
    !ids.includes(preferred)
  ) {
    throw new Error("UNKNOWN_PREFERRED_STOP");
  }

  const matrix = await getAloNowRoadMatrix({
    origin: input.origin,
    stops: input.stops.map(
      stop => stop.coordinates
    ),
    returnKiosk: input.returnKiosk,
    vehicle: input.vehicle,
  });

  const optimized = optimizeAloNowTour({
    stops: input.stops.map(stop => ({
      id: stop.id,
      label: stop.label,
    })),
    durationMatrixSeconds:
      matrix.durationMatrixSeconds,
    distanceMatrixMetres:
      matrix.distanceMatrixMetres,
    preferredNextStopId: preferred,
  });

  const byId = new Map(
    input.stops.map(stop => [stop.id, stop])
  );

  const orderedStops: PlannedTourStop[] =
    optimized.stopOrder.map((id, index) => {
      const original = byId.get(id);

      if (!original) {
        throw new Error("TOUR_STOP_MAPPING_FAILED");
      }

      return {
        id: original.id,
        label: original.label,
        coordinates: original.coordinates,
        sequence: index + 1,
      };
    });

  if (orderedStops.length !== input.stops.length) {
    throw new Error("TOUR_INCOMPLETE");
  }

  return {
    stops: orderedStops,
    origin: input.origin,
    returnKiosk: input.returnKiosk,
    durationSeconds: optimized.durationSeconds,
    distanceMetres: optimized.distanceMetres,
    provider: "OPENROUTESERVICE",
    vehicle: input.vehicle,
    manuallyPrioritized:
      optimized.manuallyPrioritized,
  };
}

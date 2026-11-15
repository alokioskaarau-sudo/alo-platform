
/**
 * ALO NOW V89.5
 * Verified road-routing matrix for a delivery tour.
 *
 * Coordinates must be verified by the server before calling.
 * Never expose ORS credentials to the mobile app.
 */
export type AloRoadPoint = readonly [number, number];

export type AloRoutingVehicle = "CAR" | "BICYCLE" | "SCOOTER";

export type AloRoadMatrix = {
  durationMatrixSeconds: number[][];
  distanceMatrixMetres: number[][];
  vehicle: AloRoutingVehicle;
  provider: "OPENROUTESERVICE";
};

type MatrixResponse = {
  durations?: Array<Array<number | null>>;
  distances?: Array<Array<number | null>>;
};

function assertSwissCoordinate(
  point: AloRoadPoint
): void {
  if (
    !Array.isArray(point) ||
    point.length !== 2 ||
    !Number.isFinite(point[0]) ||
    !Number.isFinite(point[1]) ||
    point[0] < 5.8 ||
    point[0] > 10.6 ||
    point[1] < 45.6 ||
    point[1] > 47.9
  ) {
    throw new Error("INVALID_SWISS_COORDINATE");
  }
}

function getRoutingProfile(
  vehicle: AloRoutingVehicle
): string {
  if (vehicle === "CAR") return "driving-car";
  if (vehicle === "BICYCLE") return "cycling-regular";

  // Scooter classification must first be resolved:
  // kick scooter, e-scooter and motor scooter differ.
  throw new Error("SCOOTER_ROUTING_PROFILE_NOT_CONFIGURED");
}

function validateMatrix(
  rows: Array<Array<number | null>> | undefined,
  size: number,
  locations: readonly AloRoadPoint[]
): number[][] {
  const sameLocation = (a: number, b: number) =>
    locations[a]?.[0] === locations[b]?.[0] &&
    locations[a]?.[1] === locations[b]?.[1];
  if (
    !Array.isArray(rows) ||
    rows.length !== size
  ) {
    throw new Error("ORS_MATRIX_INVALID_DIMENSIONS");
  }

  return rows.map((row, i) => {
    if (!Array.isArray(row) || row.length !== size) {
      throw new Error("ORS_MATRIX_INVALID_ROW");
    }

    return row.map((value, j) => {
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < 0 ||
        (i !== j && value === 0 && !sameLocation(i, j))
      ) {
        throw new Error("ORS_ROUTE_UNAVAILABLE");
      }

      return value;
    });
  });
}

/**
 * Matrix positions:
 * 0 = driver position or kiosk departure
 * 1..N = delivery stops
 * N+1 = return kiosk
 *
 * The caller must provide verified coordinates.
 * This function does not geocode unverified addresses.
 */
export async function getAloNowRoadMatrix(input: {
  origin: AloRoadPoint;
  stops: AloRoadPoint[];
  returnKiosk: AloRoadPoint;
  vehicle: AloRoutingVehicle;
}): Promise<AloRoadMatrix> {
  if (
    input.stops.length < 1 ||
    input.stops.length > 6
  ) {
    throw new Error("INVALID_STOP_COUNT");
  }

  const points = [
    input.origin,
    ...input.stops,
    input.returnKiosk,
  ];

  points.forEach(assertSwissCoordinate);

  const key = process.env.ALO_NOW_ORS_API_KEY?.trim();

  if (!key) {
    throw new Error("ORS_API_KEY_NOT_CONFIGURED");
  }

  const profile = getRoutingProfile(input.vehicle);
  const url =
    "https://api.openrouteservice.org/v2/matrix/" +
    profile;

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    12000
  );

  try {
    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: key,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        locations: points,
        metrics: ["duration", "distance"],
        units: "m",
      }),
    });

    if (!response.ok) {
      throw new Error(
        "ORS_MATRIX_HTTP_" + response.status
      );
    }

    const payload =
      (await response.json()) as MatrixResponse;

    const durationMatrixSeconds = validateMatrix(
      payload.durations,
      points.length,
      points
    );

    const distanceMatrixMetres = validateMatrix(
      payload.distances,
      points.length,
      points
    );

    return {
      durationMatrixSeconds,
      distanceMatrixMetres,
      vehicle: input.vehicle,
      provider: "OPENROUTESERVICE",
    };
  } finally {
    clearTimeout(timeout);
  }
}

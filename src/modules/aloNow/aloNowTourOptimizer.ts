
/**
 * ALO NOW - Tour optimization core.
 *
 * Matrix values MUST come from a trusted road-routing provider.
 * This module performs no network requests and no mutations.
 */

export type AloTourStop = {
  id: string;
  label: string;
};

export type AloTourRequest = {
  stops: AloTourStop[];
  durationMatrixSeconds: number[][];
  distanceMatrixMetres: number[][];
  preferredNextStopId?: string | null;
};

export type AloTourResult = {
  stopOrder: string[];
  durationSeconds: number;
  distanceMetres: number;
  manuallyPrioritized: boolean;
};

export function optimizeAloNowTour(
  input: AloTourRequest
): AloTourResult {
  const { stops } = input;
  const count = stops.length;

  if (count < 1 || count > 6) {
    throw new Error("TOUR_STOP_COUNT_INVALID");
  }

  const ids = stops.map(s => s.id);

  if (
    ids.some(id => !id?.trim()) ||
    new Set(ids).size !== ids.length
  ) {
    throw new Error("TOUR_STOP_IDS_INVALID");
  }

  // Matrix convention:
  // 0 = current driver position
  // 1..N = customers in stops[] order
  // N+1 = return kiosk
  const size = count + 2;

  const validate = (matrix: number[][]) => {
    if (
      matrix.length !== size ||
      matrix.some(
        row =>
          !Array.isArray(row) ||
          row.length !== size ||
          row.some(
            value =>
              !Number.isFinite(value) ||
              value < 0
          )
      )
    ) {
      throw new Error("ROUTING_MATRIX_UNVERIFIED");
    }
  };

  validate(input.durationMatrixSeconds);
  validate(input.distanceMatrixMetres);

  const preferred = input.preferredNextStopId ?? null;

  if (preferred && !ids.includes(preferred)) {
    throw new Error("PREFERRED_STOP_NOT_FOUND");
  }

  const remaining = Array.from(
    { length: count },
    (_, index) => index + 1
  );

  let best:
    | {
        order: number[];
        seconds: number;
        metres: number;
      }
    | undefined;

  const visit = (
    position: number,
    unvisited: number[],
    order: number[],
    seconds: number,
    metres: number
  ) => {
    if (unvisited.length === 0) {
      const end = size - 1;

      const totalSeconds =
        seconds +
        input.durationMatrixSeconds[position][end];

      const totalMetres =
        metres +
        input.distanceMatrixMetres[position][end];

      if (
        !best ||
        totalSeconds < best.seconds ||
        (
          totalSeconds === best.seconds &&
          totalMetres < best.metres
        )
      ) {
        best = {
          order: [...order],
          seconds: totalSeconds,
          metres: totalMetres,
        };
      }
      return;
    }

    for (const next of unvisited) {
      if (
        position === 0 &&
        preferred &&
        ids[next - 1] !== preferred
      ) {
        continue;
      }

      visit(
        next,
        unvisited.filter(value => value !== next),
        [...order, next],
        seconds +
          input.durationMatrixSeconds[position][next],
        metres +
          input.distanceMatrixMetres[position][next]
      );
    }
  };

  visit(0, remaining, [], 0, 0);

  if (!best) {
    throw new Error("NO_VALID_TOUR");
  }

  const result = best as {
    order: number[];
    seconds: number;
    metres: number;
  };

  return {
    stopOrder: result.order.map(
      index => ids[index - 1]
    ),
    durationSeconds: result.seconds,
    distanceMetres: result.metres,
    manuallyPrioritized: preferred !== null,
  };
}

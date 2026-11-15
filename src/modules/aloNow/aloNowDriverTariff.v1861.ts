/**
 * ALO NOW V1861 - versionierter Fahrertarif.
 *
 * CHF 2.00 Grundprovision
 * CHF 0.50 pro verifiziertem Strassenkilometer
 * Aufrunden auf CHF 0.50
 * Maximum CHF 8.00
 *
 * Pure server calculation. No GPS lookup, SQL or payout.
 */

export const ALO_DRIVER_TARIFF_V1861 = Object.freeze({
  version: "ALO-DRIVER-2026-11-V1",
  currency: "CHF" as const,
  baseRappen: 200,
  rappenPerKm: 50,
  roundingRappen: 50,
  capRappen: 800,
});

export type DriverCommissionQuoteV1861 = Readonly<{
  tariffVersion: string;
  distanceMetres: number;
  quotedCommissionRappen: number;
  currency: "CHF";
}>;

export function quoteDriverCommissionV1861(
  verifiedRoadDistanceMetres: number
): DriverCommissionQuoteV1861 {
  if (
    !Number.isSafeInteger(verifiedRoadDistanceMetres) ||
    verifiedRoadDistanceMetres <= 0
  ) {
    throw new Error("VERIFIED_ROAD_DISTANCE_REQUIRED");
  }

  const tariff = ALO_DRIVER_TARIFF_V1861;

  // Work in integer numerator units to avoid CHF float errors.
  const numerator =
    tariff.baseRappen * 1000 +
    verifiedRoadDistanceMetres * tariff.rappenPerKm;

  if (!Number.isSafeInteger(numerator)) {
    throw new Error("COMMISSION_CALCULATION_OVERFLOW");
  }

  const rounded =
    Math.ceil(
      numerator / (1000 * tariff.roundingRappen)
    ) * tariff.roundingRappen;

  const commission = Math.min(
    tariff.capRappen,
    rounded
  );

  if (
    !Number.isSafeInteger(commission) ||
    commission <= 0 ||
    commission % 50 !== 0
  ) {
    throw new Error("INVALID_COMMISSION_RESULT");
  }

  return Object.freeze({
    tariffVersion: tariff.version,
    distanceMetres: verifiedRoadDistanceMetres,
    quotedCommissionRappen: commission,
    currency: tariff.currency,
  });
}

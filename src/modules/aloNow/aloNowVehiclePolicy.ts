/**
 * ALO NOW vehicle dispatch eligibility – V1, pure rules only.
 * Not yet wired to checkout/claim. No payment, order or DB writes.
 * Distances MUST be verified road-route kilometres from the dispatch origin.
 * Unknown data fails closed; a manual quote is NOT automatic permission.
 */
export type AloNowVehicle = "SCOOTER" | "CAR" | "BIKE" | "OTHER";
export type AloNowLoadClass = "COMPACT" | "BULKY" | "UNKNOWN";
export type AloNowDispatchReason =
  | "OK"
  | "UNKNOWN_ROUTE_DISTANCE"
  | "INVALID_ROUTE_DISTANCE"
  | "UNKNOWN_LOAD_CLASS"
  | "MANUAL_DISTANCE_REVIEW"
  | "CAR_REQUIRED"
  | "UNSUPPORTED_VEHICLE";

export interface AloNowDispatchInput {
  vehicle: AloNowVehicle | null;
  roadDistanceKm: number | null;
  loadClass: AloNowLoadClass;
  /** Explicit business-approved radius; default is pilot assumption (12 km). */
  standardRadiusKm?: number;
}

export interface AloNowDispatchDecision {
  eligible: boolean;
  reason: AloNowDispatchReason;
  requiresManualReview: boolean;
  suggestedVehicle: "SCOOTER_OR_CAR" | "CAR" | null;
}

const blocked = (
  reason: Exclude<AloNowDispatchReason, "OK">,
  requiresManualReview = false,
  suggestedVehicle: AloNowDispatchDecision["suggestedVehicle"] = null,
): AloNowDispatchDecision => ({ eligible: false, reason, requiresManualReview, suggestedVehicle });

export function evaluateAloNowDispatch(input: AloNowDispatchInput): AloNowDispatchDecision {
  const { vehicle, roadDistanceKm, loadClass } = input;
  const standardRadiusKm = input.standardRadiusKm ?? 12;
  if (!Number.isFinite(standardRadiusKm) || standardRadiusKm <= 0)
    throw new Error("INVALID_STANDARD_RADIUS_CONFIGURATION");
  if (roadDistanceKm === null)
    return blocked("UNKNOWN_ROUTE_DISTANCE", true);
  if (!Number.isFinite(roadDistanceKm) || roadDistanceKm < 0)
    return blocked("INVALID_ROUTE_DISTANCE");
  if (loadClass === "UNKNOWN")
    return blocked("UNKNOWN_LOAD_CLASS", true);
  if (roadDistanceKm > standardRadiusKm)
    return blocked("MANUAL_DISTANCE_REVIEW", true, loadClass === "BULKY" ? "CAR" : "SCOOTER_OR_CAR");
  if (loadClass === "BULKY" && vehicle !== "CAR")
    return blocked("CAR_REQUIRED", false, "CAR");
  if (vehicle !== "CAR" && vehicle !== "SCOOTER")
    return blocked("UNSUPPORTED_VEHICLE", false, loadClass === "BULKY" ? "CAR" : "SCOOTER_OR_CAR");
  return {
    eligible: true,
    reason: "OK",
    requiresManualReview: false,
    suggestedVehicle: loadClass === "BULKY" ? "CAR" : "SCOOTER_OR_CAR",
  };
}

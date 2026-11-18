/** ALO NOW DELIVERY QUOTE V1
 * Business rules only. Distance must come from a trusted server-side road router.
 * A client-supplied distance is NEVER a valid source for quote calculation.
 */
export const ALO_NOW_BASE_FEE_CHF = 12.90;
export const ALO_NOW_STANDARD_RADIUS_KM = 12;
export type AloNowQuoteDecision =
  | { status: "STANDARD"; deliveryFeeCHF: 12.90; distanceKm: number; approvalRequired: false }
  | { status: "MANUAL_APPROVAL"; deliveryFeeCHF: null; distanceKm: number; approvalRequired: true }
  | { status: "ROUTE_UNVERIFIED"; deliveryFeeCHF: null; distanceKm: null; approvalRequired: true };

/** Only call with a trusted, server-verified driving route distance. */
export function calculateAloNowDeliveryQuote(verifiedRoadDistanceKm: number | null): AloNowQuoteDecision {
  if (verifiedRoadDistanceKm === null || !Number.isFinite(verifiedRoadDistanceKm) || verifiedRoadDistanceKm < 0) {
    return {status: "ROUTE_UNVERIFIED", deliveryFeeCHF: null, distanceKm: null, approvalRequired: true};
  }
  if (verifiedRoadDistanceKm > ALO_NOW_STANDARD_RADIUS_KM) {
    return {status: "MANUAL_APPROVAL", deliveryFeeCHF: null, distanceKm: verifiedRoadDistanceKm, approvalRequired: true};
  }
  return {status: "STANDARD", deliveryFeeCHF: ALO_NOW_BASE_FEE_CHF, distanceKm: verifiedRoadDistanceKm, approvalRequired: false};
}

/**
 * ALO NOW order provenance policy.
 *
 * The inputs MUST come from independently authenticated sources:
 * - intent: a server-persisted checkout intent
 * - order: a fresh Shopify Admin API read
 *
 * This policy alone does not authenticate the inputs or authorize
 * payment confirmation / delivery dispatch.
 */

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ORDER =
  /^gid:\/\/shopify\/Order\/[1-9][0-9]*$/;

export type AloNowCheckoutIntent = {
  requestId: string;
  checkoutReference: string;
  shopifyOrderId: string;
};

export type AloNowOrderProvenance = {
  id: string;
  aloNowRequestId: string | null;
  aloNowCheckoutReference: string | null;
};

export type AloNowProvenanceResult =
  | { ok: true }
  | { ok: false; reason: string };

export function verifyAloNowOrderProvenance(
  requestId: string,
  intent: AloNowCheckoutIntent,
  order: AloNowOrderProvenance
): AloNowProvenanceResult {
  if (!UUID.test(requestId) || intent.requestId !== requestId) {
    return { ok: false, reason: "REQUEST_MISMATCH" };
  }

  if (
    !ORDER.test(intent.shopifyOrderId) ||
    intent.shopifyOrderId !== order.id
  ) {
    return { ok: false, reason: "SHOPIFY_ORDER_MISMATCH" };
  }

  if (
    !UUID.test(intent.checkoutReference) ||
    order.aloNowRequestId !== requestId ||
    order.aloNowCheckoutReference !== intent.checkoutReference
  ) {
    return { ok: false, reason: "PROVENANCE_MISMATCH" };
  }

  return { ok: true };
}

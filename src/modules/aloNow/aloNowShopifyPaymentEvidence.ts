
/**
 * ALO NOW Shopify payment evidence policy.
 *
 * IMPORTANT:
 * These values must be obtained from a trusted Shopify
 * Admin API response, never directly from a browser.
 * This module does not itself call Shopify or grant dispatch.
 */

export type ShopifyPaymentEvidence = {
  requestId: string;
  linkedRequestId: string;
  expectedOrderId: string;
  actualOrderId: string;
  financialStatus: string;
  currencyCode: string;
  expectedTotalChf: string;
  actualTotalChf: string;
  reservationValid: boolean;
};

export type ShopifyPaymentDecision =
  | { ok: true; action: "CONFIRM" | "RECONCILE" }
  | { ok: false; reason: string };

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SHOPIFY_ORDER =
  /^gid:\/\/shopify\/Order\/[1-9][0-9]*$/;

function parseChfCents(value: string): bigint | null {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9]\d{0,8})\.\d{2}$/.test(value)
  ) return null;

  const [francs, cents] = value.split(".");
  return BigInt(francs) * 100n + BigInt(cents);
}

export function evaluateAloNowShopifyPayment(
  evidence: ShopifyPaymentEvidence
): ShopifyPaymentDecision {
  if (
    !UUID.test(evidence.requestId) ||
    evidence.requestId !== evidence.linkedRequestId
  ) {
    return { ok: false, reason: "REQUEST_BINDING_MISMATCH" };
  }

  if (
    !SHOPIFY_ORDER.test(evidence.expectedOrderId) ||
    evidence.expectedOrderId !== evidence.actualOrderId
  ) {
    return { ok: false, reason: "SHOPIFY_ORDER_MISMATCH" };
  }

  if (
    String(evidence.financialStatus).toUpperCase() !== "PAID"
  ) {
    return { ok: false, reason: "SHOPIFY_NOT_PAID" };
  }

  if (evidence.currencyCode !== "CHF") {
    return { ok: false, reason: "CURRENCY_MISMATCH" };
  }

  const expected = parseChfCents(evidence.expectedTotalChf);
  const actual = parseChfCents(evidence.actualTotalChf);

  if (
    expected === null ||
    actual === null ||
    expected <= 0n ||
    expected !== actual
  ) {
    return { ok: false, reason: "TOTAL_MISMATCH" };
  }

  if (typeof evidence.reservationValid !== "boolean") {
    return { ok: false, reason: "RESERVATION_STATE_UNKNOWN" };
  }

  // A valid payment after reservation expiry is real money:
  // never silently discard or automatically dispatch it.
  return {
    ok: true,
    action: evidence.reservationValid
      ? "CONFIRM"
      : "RECONCILE",
  };
}

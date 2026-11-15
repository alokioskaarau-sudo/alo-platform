/**
 * ALO NOW V166
 *
 * Structural verification only.
 * Does NOT verify Shopify payment or authorize credit.
 *
 * One tip Shopify order per original delivery.
 */

export type TipOrderBindingV166 = {
  requestId: string;
  originalOrderId: string;
  tipOrderId: string;
  amountRappen: number;
  currency: string;
};

export type TipOrderBindingResultV166 =
  | { ok: true }
  | { ok: false; reason: string };

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const SHOPIFY_ORDER =
  /^gid:\/\/shopify\/Order\/[1-9][0-9]*$/;

export function validateTipOrderBindingV166(
  value: TipOrderBindingV166
): TipOrderBindingResultV166 {

  if (!UUID.test(value.requestId)) {
    return {
      ok: false,
      reason: "INVALID_REQUEST_ID"
    };
  }

  if (
    !SHOPIFY_ORDER.test(value.originalOrderId) ||
    !SHOPIFY_ORDER.test(value.tipOrderId)
  ) {
    return {
      ok: false,
      reason: "INVALID_SHOPIFY_ORDER"
    };
  }

  if (value.originalOrderId === value.tipOrderId) {
    return {
      ok: false,
      reason: "SAME_ORDER_NOT_ALLOWED"
    };
  }

  if (
    !Number.isSafeInteger(value.amountRappen) ||
    value.amountRappen <= 0 ||
    value.amountRappen > 50000 ||
    value.currency !== "CHF"
  ) {
    return {
      ok: false,
      reason: "INVALID_TIP_AMOUNT"
    };
  }

  return { ok: true };
}

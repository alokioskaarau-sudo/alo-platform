// ALO_NOW_V1648_PARTIAL_PAYMENT_GUARD
// Pure, fail-closed payment precheck.
// This is NOT final fulfillment authorization.
// Only trusted server-side callers may supply evidence.
// CASH remains blocked until durable receipt is verified.
// NO database, Shopify, HTTP or payment mutations.

export type PartialPaymentEvidenceV1648 = {
  expectedOrderId: string;
  shopify: {
    id: string;
    cancelledAt: string | null;
    displayFinancialStatus: string;
    currencyCode: string;
    outstandingRappen: number;
  } | null;
  paymentRows: Array<{
    shopifyOrderId: string;
    paymentMethod: string | null;
    phase: string;
  }>;
  packStatus: string | null;
  fulfillmentType: string;
};

export type PartialPaymentDecisionV1648 =
  | {
      allowed: true;
      status: "ONLINE_PAYMENT_PRECHECK_PASSED";
    }
  | {
      allowed: false;
      reason: string;
    };

export function evaluatePartialPaymentV1648(
  input: PartialPaymentEvidenceV1648
): PartialPaymentDecisionV1648 {
  const reject = (
    reason: string
  ): PartialPaymentDecisionV1648 => ({
    allowed: false,
    reason,
  });

  if (
    !input ||
    typeof input.expectedOrderId !== "string" ||
    !/^gid:\/\/shopify\/Order\/[1-9]\d*$/.test(
      input.expectedOrderId
    )
  ) {
    return reject("INVALID_PAYMENT_CONTEXT");
  }

  const order = input.shopify;

  if (
    !order ||
    order.id !== input.expectedOrderId
  ) {
    return reject("SHOPIFY_ORDER_MISMATCH");
  }

  if (order.cancelledAt !== null) {
    return reject("SHOPIFY_ORDER_CANCELLED");
  }

  if (input.fulfillmentType !== "ALO_NOW") {
    return reject("NOT_ALO_NOW_ORDER");
  }

  if (
    input.packStatus !== "PACKED" &&
    input.packStatus !== "COMPLETED"
  ) {
    return reject("ORDER_NOT_PACKED");
  }

  if (
    !Array.isArray(input.paymentRows) ||
    input.paymentRows.length !== 1
  ) {
    return reject("PAYMENT_BINDING_NOT_UNIQUE");
  }

  const payment = input.paymentRows[0];

  if (
    !payment ||
    payment.shopifyOrderId !== input.expectedOrderId
  ) {
    return reject("PAYMENT_ORDER_MISMATCH");
  }

  if (
    order.currencyCode !== "CHF" ||
    !Number.isSafeInteger(order.outstandingRappen) ||
    order.outstandingRappen < 0
  ) {
    return reject("INVALID_SHOPIFY_PAYMENT_AMOUNT");
  }

  if (payment.paymentMethod === "CASH") {
    if (
      payment.phase !== "CASH_CONFIRMED" ||
      order.displayFinancialStatus !== "PENDING"
    ) {
      return reject("CASH_AGREEMENT_NOT_VERIFIED");
    }

    // CASH_CONFIRMED = agreement, NOT collected money.
    // No receipt / settlement evidence is in this input.
    return reject("CASH_COLLECTION_EVIDENCE_REQUIRED");
  }

  if (payment.paymentMethod !== "ONLINE") {
    return reject("UNKNOWN_PAYMENT_METHOD");
  }

  if (
    payment.phase !== "PAYMENT_CONFIRMED" ||
    order.displayFinancialStatus !== "PAID" ||
    order.outstandingRappen !== 0
  ) {
    return reject("ONLINE_PAYMENT_NOT_FULLY_VERIFIED");
  }

  return {
    allowed: true,
    status: "ONLINE_PAYMENT_PRECHECK_PASSED",
  };
}

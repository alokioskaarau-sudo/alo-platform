// ALO_V1559_AGE_REFUSAL_SETTLEMENT
// Pure calculation only. No payment, refund or fulfillment writes.

export type AgeRefusalReason =
  | "NO_ID"
  | "UNDERAGE"
  | "IDENTITY_UNCLEAR"
  | "DOCUMENT_INVALID"
  | "TECHNICAL_FAILURE";

export type RefusedLine = {
  lineItemId: string;
  quantity: number;
  refundableTotalRappen: number;
};

export type AgeRefusalSettlementInput = {
  reason: AgeRefusalReason;
  refusedLines: RefusedLine[];
  feePolicyApproved: boolean;
  customerResponsibilityEstablished: boolean;
  documentedEligibleCostsRappen: number;
  approvedFeeCapRappen: number;
};

export type AgeRefusalSettlementPreview = {
  refusedSubtotalRappen: number;
  eligibleFeeRappen: number;
  proposedRefundRappen: number;
  currency: "CHF";
  requiresReview: true;
  canExecuteAutomatically: false;
  lines: RefusedLine[];
};

function nonnegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("INVALID_" + name);
  }
  return value;
}

export function calculateAgeRefusalSettlementV1559(
  input: AgeRefusalSettlementInput
): AgeRefusalSettlementPreview {
  if (!input.refusedLines.length) {
    throw new Error("NO_REFUSED_LINES");
  }

  const seen = new Set<string>();
  let subtotal = 0;

  for (const line of input.refusedLines) {
    const id = line.lineItemId.trim();
    if (!id || seen.has(id)) {
      throw new Error("INVALID_OR_DUPLICATE_LINE_ITEM");
    }
    seen.add(id);

    if (!Number.isSafeInteger(line.quantity) ||
        line.quantity < 1) {
      throw new Error("INVALID_QUANTITY");
    }

    const amount = nonnegativeInteger(
      line.refundableTotalRappen,
      "LINE_AMOUNT"
    );

    subtotal += amount;

    if (!Number.isSafeInteger(subtotal)) {
      throw new Error("AMOUNT_OVERFLOW");
    }
  }

  const costs = nonnegativeInteger(
    input.documentedEligibleCostsRappen,
    "DOCUMENTED_COSTS"
  );

  const cap = nonnegativeInteger(
    input.approvedFeeCapRappen,
    "FEE_CAP"
  );

  // Never apply fees without both approvals.
  // Technical failures are not presumed customer-caused.
  const eligibleFee =
    input.feePolicyApproved &&
    input.customerResponsibilityEstablished &&
    input.reason !== "TECHNICAL_FAILURE"
      ? Math.min(costs, cap, subtotal)
      : 0;

  return {
    refusedSubtotalRappen: subtotal,
    eligibleFeeRappen: eligibleFee,
    proposedRefundRappen: subtotal - eligibleFee,
    currency: "CHF",
    requiresReview: true,
    canExecuteAutomatically: false,
    lines: input.refusedLines.map(line => ({...line})),
  };
}

/**
 * ALO NOW V173
 *
 * Pure conflict decision.
 * No database access, Shopify request or wallet write.
 */

export type ExistingTipIntentV173 = {
  original_shopify_order_id: string;
  amount_rappen: string;
  taxable: boolean;
  status: string;
  draft_order_id: string | null;
};

export type TipConflictDecisionV173 =
  | { ok: true; action: "ALREADY_RESERVED" }
  | { ok: false; reason: string };

export function decideTipReservationConflictV173(
  existing: ExistingTipIntentV173[],
  expected: {
    originalOrderId: string;
    amountRappen: number;
    taxable: boolean;
  }
): TipConflictDecisionV173 {
  if (existing.length !== 1) {
    return {
      ok: false,
      reason: "RESERVATION_CONFLICT"
    };
  }

  const row = existing[0];

  if (
    !Number.isSafeInteger(expected.amountRappen) ||
    expected.amountRappen < 100 ||
    expected.amountRappen > 50000 ||
    typeof expected.taxable !== "boolean" ||
    row.original_shopify_order_id !==
      expected.originalOrderId ||
    row.amount_rappen !== String(expected.amountRappen) ||
    row.taxable !== expected.taxable
  ) {
    return {
      ok: false,
      reason: "RESERVATION_DETAILS_MISMATCH"
    };
  }

  if (
    row.status === "RESERVED" &&
    row.draft_order_id === null
  ) {
    return {
      ok: true,
      action: "ALREADY_RESERVED"
    };
  }

  if (
    row.status === "CREATE_UNCERTAIN" ||
    row.status === "DRAFT_CREATED"
  ) {
    return {
      ok: false,
      reason: "SHOPIFY_RECONCILIATION_REQUIRED"
    };
  }

  return {
    ok: false,
    reason: "RESERVATION_NOT_REUSABLE"
  };
}

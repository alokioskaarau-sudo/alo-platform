
/**
 * ALO NOW V1692
 * Strict, pure Shopify wallet payment precheck.
 *
 * This function NEVER fetches Shopify, verifies transport
 * provenance, books finance events or authorizes payouts.
 * Its input must eventually come from a trusted, fresh
 * server-side Shopify Admin API read.
 */

export type MoneyV1692 = {
  shopMoney: {
    amount: string;
    currencyCode: string;
  };
};

export type ShopifyWalletSnapshotV1692 = {
  id: string;
  displayFinancialStatus: string;
  cancelledAt: string | null;
  totalPriceSet: MoneyV1692;
  totalOutstandingSet: MoneyV1692;
  totalRefundedSet: MoneyV1692;
};

export type WalletPaymentDecisionV1692 = {
  status: "PAYMENT_PRECHECK_PASSED" | "BLOCKED";
  reason: string | null;
  orderId: string;
  orderTotalRappen: number | null;
  providerSourceAuthenticated: false;
  payoutEnabled: false;
  payableOutstandingRappen: null;
  readOnly: true;
};

const ORDER_ID = /^gid:\/\/shopify\/Order\/[1-9][0-9]*$/;

function chfRappen(value: unknown): number | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !("shopMoney" in value)
  ) return null;

  const money = (value as {
    shopMoney?: {
      amount?: unknown;
      currencyCode?: unknown;
    };
  }).shopMoney;

  if (
    money?.currencyCode !== "CHF" ||
    typeof money.amount !== "string" ||
    !/^(0|[1-9][0-9]{0,8})\.[0-9]{2}$/.test(money.amount)
  ) return null;

  const [francs, cents] = money.amount.split(".");
  const amount = Number(francs) * 100 + Number(cents);

  return Number.isSafeInteger(amount) ? amount : null;
}

export function inspectShopifyWalletPaymentV1692(
  expectedOrderId: string,
  snapshot: ShopifyWalletSnapshotV1692 | null
): WalletPaymentDecisionV1692 {
  const result = (
    reason: string | null,
    total: number | null = null
  ): WalletPaymentDecisionV1692 => ({
    status: reason === null
      ? "PAYMENT_PRECHECK_PASSED"
      : "BLOCKED",
    reason,
    orderId: expectedOrderId,
    orderTotalRappen: total,
    providerSourceAuthenticated: false,
    payoutEnabled: false,
    payableOutstandingRappen: null,
    readOnly: true
  });

  if (!ORDER_ID.test(expectedOrderId)) {
    return result("INVALID_EXPECTED_ORDER_ID");
  }

  if (
    !snapshot ||
    snapshot.id !== expectedOrderId
  ) {
    return result("SHOPIFY_ORDER_ID_MISMATCH");
  }

  if (snapshot.cancelledAt !== null) {
    return result("SHOPIFY_ORDER_CANCELLED");
  }

  if (snapshot.displayFinancialStatus !== "PAID") {
    return result("SHOPIFY_NOT_FULLY_PAID");
  }

  const total = chfRappen(snapshot.totalPriceSet);
  const outstanding = chfRappen(snapshot.totalOutstandingSet);
  const refunded = chfRappen(snapshot.totalRefundedSet);

  if (
    total === null ||
    outstanding === null ||
    refunded === null ||
    total <= 0
  ) {
    return result("INCOMPLETE_SHOPIFY_MONEY_EVIDENCE");
  }

  if (outstanding !== 0) {
    return result("SHOPIFY_OUTSTANDING_PAYMENT");
  }

  if (refunded !== 0) {
    return result("SHOPIFY_REFUND_DETECTED");
  }

  return result(null, total);
}

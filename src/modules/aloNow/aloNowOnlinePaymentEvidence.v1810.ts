/**
 * ALO NOW V1810B
 * Pure payment preflight. No DB, HTTP or secrets.
 * PAID does not prove absence of refunds or chargebacks.
 * This result never grants wallet entitlement or payout.
 */

export type PaymentSnapshotV1810 = {
  id?: string;
  cancelledAt?: string | null;
  displayFinancialStatus?: string;
  totalPriceSet?: {
    shopMoney?: { amount?: string; currencyCode?: string }
  };
  totalRefundedSet?: {
    shopMoney?: { amount?: string; currencyCode?: string }
  };
  totalOutstandingSet?: {
    shopMoney?: { amount?: string; currencyCode?: string }
  };
};

export type PaymentStateV1810 = {
  phase: string;
  payment_method: string | null;
};

export type OnlineEvidenceV1810 = {
  status: "MATCHED_REFUND_CHECK_PENDING" | "BLOCKED";
  shopifyPaymentMatched: boolean;
  refundVerificationCompleted: false;
  earningsAuthorized: false;
  payoutEnabled: false;
};

export type PaymentDependenciesV1810 = {
  shopify: (id: string) =>
    Promise<PaymentSnapshotV1810 | null>;
  paymentStates: (id: string) =>
    Promise<PaymentStateV1810[]>;
};

const ORDER = /^gid:\/\/shopify\/Order\/[1-9][0-9]*$/;

function blocked(): OnlineEvidenceV1810 {
  return {
    status: "BLOCKED",
    shopifyPaymentMatched: false,
    refundVerificationCompleted: false,
    earningsAuthorized: false,
    payoutEnabled: false
  };
}

function toRappen(value: unknown): number | null {
  if (typeof value !== "string") return null;

  const parts =
    /^(0|[1-9][0-9]{0,8})(?:\.([0-9]{1,2}))?$/
      .exec(value);

  if (!parts) return null;

  const amount =
    Number(parts[1]) * 100 +
    Number((parts[2] ?? "").padEnd(2, "0"));

  return Number.isSafeInteger(amount)
    ? amount
    : null;
}

export async function checkOnlinePaymentEvidenceV1810(
  orderId: string,
  deps: PaymentDependenciesV1810
): Promise<OnlineEvidenceV1810> {
  if (!ORDER.test(orderId)) return blocked();

  try {
    const [order, states] = await Promise.all([
      deps.shopify(orderId),
      deps.paymentStates(orderId)
    ]);

    if (
      !order ||
      order.id !== orderId ||
      order.cancelledAt !== null ||
      order.displayFinancialStatus !== "PAID" ||
      !Array.isArray(states) ||
      states.length !== 1 ||
      states[0]?.phase !== "PAYMENT_CONFIRMED" ||
      states[0]?.payment_method !== "ONLINE"
    ) {
      return blocked();
    }

    const total = order.totalPriceSet?.shopMoney;
    const outstanding =
      order.totalOutstandingSet?.shopMoney;

    // ALO_NOW_V1814_REFUND_CHECK
    const refunded = order.totalRefundedSet?.shopMoney;
    const refundedAmount = toRappen(refunded?.amount);

    const totalAmount = toRappen(total?.amount);
    const outstandingAmount =
      toRappen(outstanding?.amount);

    if (
      refunded?.currencyCode !== "CHF" ||
      refundedAmount !== 0 ||
      total?.currencyCode !== "CHF" ||
      outstanding?.currencyCode !== "CHF" ||
      totalAmount === null ||
      totalAmount <= 0 ||
      outstandingAmount !== 0
    ) {
      return blocked();
    }

    return {
      status: "MATCHED_REFUND_CHECK_PENDING",
      shopifyPaymentMatched: true,
      refundVerificationCompleted: false,
      earningsAuthorized: false,
      payoutEnabled: false
    };
  } catch {
    return blocked();
  }
}

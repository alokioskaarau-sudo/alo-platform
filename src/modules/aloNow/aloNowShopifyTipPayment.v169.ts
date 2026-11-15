
/**
 * Read-only examination of Shopify payment evidence.
 *
 * CANDIDATE is not wallet authorization:
 * The purpose and original-delivery binding must be
 * independently established before financial booking.
 */

type Money = {
  amount?: string;
  currencyCode?: string;
};

type MoneyBag = {
  shopMoney?: Money;
};

type Transaction = {
  id?: string;
  kind?: string;
  status?: string;
  manualPaymentGateway?: boolean;
  amountSet?: MoneyBag;
};

type Snapshot = {
  id?: string;
  test?: boolean;
  cancelledAt?: string | null;
  displayFinancialStatus?: string;
  totalPriceSet?: MoneyBag;
  totalReceivedSet?: MoneyBag;
  totalRefundedSet?: MoneyBag;
  transactions?: Transaction[];
};

export type TipPaymentCandidateV169 =
  | { ok: false; reason: string }
  | {
      ok: true;
      status: "PAYMENT_CANDIDATE_ONLY";
      orderId: string;
      captureId: string;
      amountRappen: number;
      currency: "CHF";
      purposeVerified: false;
      walletAuthorized: false;
    };

function blocked(reason: string): TipPaymentCandidateV169 {
  return { ok: false, reason };
}

function toRappen(money: MoneyBag | undefined): number | null {
  const amount = money?.shopMoney?.amount;

  if (
    money?.shopMoney?.currencyCode !== "CHF" ||
    typeof amount !== "string" ||
    !/^(0|[1-9][0-9]{0,8})(\.[0-9]{1,2})?$/.test(amount)
  ) {
    return null;
  }

  const [whole, cents = ""] = amount.split(".");
  const total =
    BigInt(whole) * 100n +
    BigInt(cents.padEnd(2, "0"));

  if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
    return null;
  }

  return Number(total);
}

export function inspectShopifyTipPaymentV169(
  expectedOrderId: string,
  expectedAmountRappen: number,
  snapshot: Snapshot | null
): TipPaymentCandidateV169 {
  if (
    !/^gid:\/\/shopify\/Order\/[1-9][0-9]*$/.test(
      expectedOrderId
    ) ||
    !Number.isSafeInteger(expectedAmountRappen) ||
    expectedAmountRappen <= 0 ||
    expectedAmountRappen > 50000
  ) {
    return blocked("INVALID_EXPECTATION");
  }

  if (
    !snapshot ||
    snapshot.id !== expectedOrderId ||
    snapshot.test !== false ||
    snapshot.cancelledAt != null ||
    snapshot.displayFinancialStatus !== "PAID"
  ) {
    return blocked("ORDER_NOT_ELIGIBLE");
  }

  const total = toRappen(snapshot.totalPriceSet);
  const received = toRappen(snapshot.totalReceivedSet);
  const refunded = toRappen(snapshot.totalRefundedSet);

  if (
    total !== expectedAmountRappen ||
    received !== expectedAmountRappen ||
    refunded !== 0
  ) {
    return blocked("AMOUNT_OR_REFUND_MISMATCH");
  }

  if (!Array.isArray(snapshot.transactions)) {
    return blocked("TRANSACTIONS_MISSING");
  }

  const transactions = snapshot.transactions;

  // Reject successful refunds or reversals, even if
  // the order aggregate appears unchanged.
  if (transactions.some(t =>
    t.status === "SUCCESS" &&
    ["REFUND", "VOID"].includes(t.kind ?? "")
  )) {
    return blocked("REFUND_OR_REVERSAL");
  }

  const captures = transactions.filter(t =>
    t.status === "SUCCESS" &&
    ["SALE", "CAPTURE"].includes(t.kind ?? "")
  );

  if (captures.length !== 1) {
    return blocked("AMBIGUOUS_CAPTURE");
  }

  const capture = captures[0];

  if (
    capture.manualPaymentGateway !== false ||
    typeof capture.id !== "string" ||
    !/^gid:\/\/shopify\/OrderTransaction\/[1-9][0-9]*$/.test(
      capture.id
    ) ||
    toRappen(capture.amountSet) !== expectedAmountRappen
  ) {
    return blocked("CAPTURE_NOT_ELIGIBLE");
  }

  return {
    ok: true,
    status: "PAYMENT_CANDIDATE_ONLY",
    orderId: expectedOrderId,
    captureId: capture.id,
    amountRappen: expectedAmountRappen,
    currency: "CHF",
    purposeVerified: false,
    walletAuthorized: false
  };
}

export async function readShopifyTipPaymentV169(
  orderId: string,
  amountRappen: number
): Promise<TipPaymentCandidateV169> {
  if (
    !/^gid:\/\/shopify\/Order\/[1-9][0-9]*$/.test(orderId) ||
    !Number.isSafeInteger(amountRappen) ||
    amountRappen <= 0 ||
    amountRappen > 50000
  ) {
    return blocked("INVALID_EXPECTATION");
  }

  // Load the authenticated Shopify client only when
  // a real provider lookup is requested.
  const { getAloNowTipOrderTransactionsV169 } =
    await import("../../integrations/shopify/orders.js");

  const snapshot =
    await getAloNowTipOrderTransactionsV169(orderId);

  return inspectShopifyTipPaymentV169(
    orderId,
    amountRappen,
    snapshot as Snapshot | null
  );
}

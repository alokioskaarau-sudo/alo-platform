// ALO_NOW_V1651_VERIFIED_QUOTE_BINDING
// Isolated, fail-closed original payment amount verification.
// Caller must hold the shared order lock.
// No database writes, HTTP route or Shopify mutations.
// The future Shopify adapter must return fresh payment evidence.

type QueryResult = {
  rows: any[];
  rowCount: number | null;
};

type Db = {
  query(
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult>;
};

export type QuoteShopifySnapshotV1651 = {
  id: string;
  cancelledAt: string | null;
  displayFinancialStatus: string;
  totalPriceSet?: {
    shopMoney: {
      amount: string;
      currencyCode: string;
    };
  };
  totalOutstandingSet?: {
    shopMoney: {
      amount: string;
      currencyCode: string;
    };
  };
};

type Dependencies = {
  db: Db;
  readShopifyPayment: (
    orderId: string
  ) => Promise<QuoteShopifySnapshotV1651 | null>;
};

function rappen(value: unknown): number {
  if (typeof value !== "string") {
    throw new Error("INVALID_CHF_DECIMAL");
  }

  const matched =
    /^(0|[1-9]\d{0,8})(?:\.(\d{1,2}))?$/
      .exec(value);

  if (!matched) {
    throw new Error("INVALID_CHF_DECIMAL");
  }

  const amount =
    Number(matched[1]) * 100 +
    Number((matched[2] ?? "").padEnd(2, "0"));

  if (!Number.isSafeInteger(amount)) {
    throw new Error("INVALID_CHF_DECIMAL");
  }

  return amount;
}

export async function verifyOriginalQuoteV1651(
  orderId: string,
  dependencies: Dependencies
): Promise<{
  ok: true;
  status: "ORIGINAL_ONLINE_QUOTE_VERIFIED";
  shopifyOrderId: string;
  requestId: string;
  expectedTotalRappen: number;
}> {
  const match =
    /^gid:\/\/shopify\/Order\/([1-9]\d*)$/
      .exec(orderId ?? "");

  if (
    !match ||
    !dependencies ||
    typeof dependencies.db?.query !== "function" ||
    typeof dependencies.readShopifyPayment !== "function"
  ) {
    throw new Error("INVALID_QUOTE_BINDING_REQUEST");
  }

  // The payment row must point to exactly one original
  // order request, not merely match an order number.
  const result = await dependencies.db.query(`
    SELECT
      p.shopify_order_id::text AS order_id,
      p.request_id::text AS payment_request_id,
      p.payment_method,
      p.phase,
      r.id::text AS request_id,
      r.quote_status,
      r.verified_at,
      r.verified_subtotal_chf::text AS subtotal,
      r.quoted_delivery_fee_chf::text AS fee
    FROM alo_now_payment_states p
    JOIN alo_now_order_requests r
      ON r.id = p.request_id
    WHERE p.shopify_order_id::text IN ($1, $2)
    LIMIT 2
  `, [orderId, match[1]]);

  if (result.rows.length !== 1) {
    throw new Error("QUOTE_BINDING_NOT_UNIQUE");
  }

  const row = result.rows[0];

  if (
    !row ||
    ![orderId, match[1]].includes(row.order_id) ||
    typeof row.request_id !== "string" ||
    row.request_id.length === 0 ||
    row.payment_request_id !== row.request_id
  ) {
    throw new Error("QUOTE_REQUEST_ID_MISMATCH");
  }

  if (
    row.payment_method !== "ONLINE" ||
    row.phase !== "PAYMENT_CONFIRMED"
  ) {
    throw new Error("ONLINE_PAYMENT_NOT_CONFIRMED");
  }

  if (
    row.quote_status !== "STANDARD" ||
    !row.verified_at ||
    row.subtotal === null ||
    row.fee === null
  ) {
    throw new Error("VERIFIED_ORIGINAL_QUOTE_MISSING");
  }

  const subtotal = rappen(row.subtotal);
  const fee = rappen(row.fee);
  const expected = subtotal + fee;

  if (
    !Number.isSafeInteger(expected) ||
    expected <= 0
  ) {
    throw new Error("INVALID_VERIFIED_QUOTE_TOTAL");
  }

  const order =
    await dependencies.readShopifyPayment(orderId);

  if (!order || order.id !== orderId) {
    throw new Error("QUOTE_SHOPIFY_ORDER_MISMATCH");
  }

  if (order.cancelledAt !== null) {
    throw new Error("QUOTE_SHOPIFY_ORDER_CANCELLED");
  }

  const total = order.totalPriceSet?.shopMoney;
  const outstanding =
    order.totalOutstandingSet?.shopMoney;

  if (
    !total ||
    !outstanding ||
    total.currencyCode !== "CHF" ||
    outstanding.currencyCode !== "CHF"
  ) {
    throw new Error("QUOTE_SHOPIFY_CURRENCY_OR_FIELDS_INVALID");
  }

  if (
    order.displayFinancialStatus !== "PAID" ||
    rappen(outstanding.amount) !== 0
  ) {
    throw new Error("QUOTE_SHOPIFY_NOT_FULLY_PAID");
  }

  if (rappen(total.amount) !== expected) {
    throw new Error("ORIGINAL_QUOTE_TOTAL_MISMATCH");
  }

  return {
    ok: true,
    status: "ORIGINAL_ONLINE_QUOTE_VERIFIED",
    shopifyOrderId: orderId,
    requestId: row.request_id,
    expectedTotalRappen: expected,
  };
}

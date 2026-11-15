// ALO_NOW_V1649_TRUSTED_PAYMENT_EVIDENCE
// Dependency-injected server-side reader.
// Does not authorize or execute Shopify fulfillment.
// Caller must hold shared order lock.
// Never inject request-body or cached client payment evidence.

import {
  evaluatePartialPaymentV1648,
} from "./aloNowPartialPaymentGuard.v1648.js";

type Db = {
  query(
    sql: string,
    params?: unknown[]
  ): Promise<{
    rows: any[];
    rowCount: number | null;
  }>;
};

type ShopifySnapshot = {
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
  readShopifyOrder:
    (orderId: string) => Promise<ShopifySnapshot | null>;
  readWorkflow:
    (orderId: string) => Promise<{
      pack_status: string;
    } | null>;
  classifyFulfillment:
    (order: ShopifySnapshot) => string;
};

function exactRappen(amount: unknown): number {
  if (typeof amount !== "string") {
    throw new Error("INVALID_SHOPIFY_AMOUNT");
  }

  const match =
    /^(0|[1-9][0-9]{0,8})(?:\.([0-9]{1,2}))?$/
      .exec(amount);

  if (!match) {
    throw new Error("INVALID_SHOPIFY_AMOUNT");
  }

  return Number(match[1]) * 100 +
    Number((match[2] ?? "").padEnd(2, "0"));
}

export async function inspectPartialPaymentV1649(
  orderId: string,
  dependencies: Dependencies
) {
  const match =
    /^gid:\/\/shopify\/Order\/([1-9]\d*)$/.exec(
      orderId ?? ""
    );

  if (
    !match ||
    !dependencies ||
    typeof dependencies.db?.query !== "function" ||
    typeof dependencies.readShopifyOrder !== "function" ||
    typeof dependencies.readWorkflow !== "function" ||
    typeof dependencies.classifyFulfillment !== "function"
  ) {
    throw new Error("INVALID_PAYMENT_READER_CONTEXT");
  }

  const numericId = match[1];

  // One or two rows: duplicates must fail closed.
  const result = await dependencies.db.query(`
    SELECT
      shopify_order_id::text AS shopify_order_id,
      payment_method,
      phase
    FROM alo_now_payment_states
    WHERE shopify_order_id::text IN ($1, $2)
    LIMIT 2
  `, [orderId, numericId]);

  if (result.rows.length !== 1) {
    throw new Error("PAYMENT_BINDING_NOT_UNIQUE");
  }

  const payment = result.rows[0];

  if (
    payment.shopify_order_id !== orderId &&
    payment.shopify_order_id !== numericId
  ) {
    throw new Error("PAYMENT_ORDER_MISMATCH");
  }

  const [order, workflow] = await Promise.all([
    dependencies.readShopifyOrder(orderId),
    dependencies.readWorkflow(orderId),
  ]);

  if (!order || order.id !== orderId) {
    throw new Error("SHOPIFY_ORDER_MISMATCH");
  }

  const total = order.totalPriceSet?.shopMoney;
  const outstanding =
    order.totalOutstandingSet?.shopMoney;

  if (
    !total ||
    !outstanding ||
    total.currencyCode !== outstanding.currencyCode
  ) {
    throw new Error("INCOMPLETE_SHOPIFY_PAYMENT_EVIDENCE");
  }

  const totalRappen = exactRappen(total.amount);
  const outstandingRappen =
    exactRappen(outstanding.amount);

  if (
    outstandingRappen > totalRappen ||
    totalRappen < 1
  ) {
    throw new Error("SHOPIFY_PAYMENT_TOTAL_MISMATCH");
  }

  const decision = evaluatePartialPaymentV1648({
    expectedOrderId: orderId,
    shopify: {
      id: order.id,
      cancelledAt: order.cancelledAt,
      displayFinancialStatus:
        order.displayFinancialStatus,
      currencyCode: total.currencyCode,
      outstandingRappen,
    },
    paymentRows: [{
      shopifyOrderId: orderId,
      paymentMethod: payment.payment_method,
      phase: payment.phase,
    }],
    packStatus: workflow?.pack_status ?? null,
    fulfillmentType:
      dependencies.classifyFulfillment(order),
  });

  if (!decision.allowed) {
    throw new Error(decision.reason);
  }

  return {
    ok: true as const,
    status: decision.status,
    shopifyOrderId: orderId,
    verifiedOutstandingRappen: outstandingRappen,
  };
}

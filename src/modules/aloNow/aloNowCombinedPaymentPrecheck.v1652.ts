// ALO_NOW_V1652_COMBINED_PAYMENT_PRECHECK
// Pure dependency composition. No production connector.
// Requires a fresh server-side Shopify snapshot.
// Both DB reads must use the same consistent DB context.
// NOT authorization to dispatch or complete delivery.

import {
  inspectPartialPaymentV1649,
} from "./aloNowPartialPaymentEvidence.v1649.js";

import {
  verifyOriginalQuoteV1651,
  type QuoteShopifySnapshotV1651,
} from "./aloNowVerifiedQuoteBinding.v1651.js";

type DbV1652 = {
  query(
    sql: string,
    params?: unknown[]
  ): Promise<{
    rows: any[];
    rowCount: number | null;
  }>;
};

export type PaymentDependenciesV1652 = {
  db: DbV1652;
  readShopifyPayment: (
    orderId: string
  ) => Promise<QuoteShopifySnapshotV1651 | null>;
  readWorkflow: (
    orderId: string
  ) => Promise<{pack_status: string} | null>;
  classifyFulfillment: (
    order: QuoteShopifySnapshotV1651
  ) => string;
};

export async function inspectCombinedPaymentV1652(
  orderId: string,
  dependencies: PaymentDependenciesV1652
): Promise<{
  ok: true;
  status: "ONLINE_PAYMENT_AND_QUOTE_PRECHECK_PASSED";
  shopifyOrderId: string;
  requestId: string;
  expectedTotalRappen: number;
}> {
  if (
    !/^gid:\/\/shopify\/Order\/[1-9]\d*$/.test(
      orderId ?? ""
    ) ||
    !dependencies ||
    typeof dependencies.db?.query !== "function" ||
    typeof dependencies.readShopifyPayment !== "function" ||
    typeof dependencies.readWorkflow !== "function" ||
    typeof dependencies.classifyFulfillment !== "function"
  ) {
    throw new Error("INVALID_COMBINED_PAYMENT_CONTEXT");
  }

  // Exactly one Shopify read for both guards.
  const order =
    await dependencies.readShopifyPayment(orderId);

  if (!order || order.id !== orderId) {
    throw new Error("COMBINED_SHOPIFY_ORDER_MISMATCH");
  }

  // No new Shopify request inside either existing guard.
  const sameSnapshot = async (_orderId: string) => {
    if (_orderId !== orderId) {
      throw new Error("COMBINED_ORDER_ID_CHANGED");
    }
    return order;
  };

  const payment = await inspectPartialPaymentV1649(
    orderId,
    {
      db: dependencies.db,
      readShopifyOrder: sameSnapshot,
      readWorkflow: dependencies.readWorkflow,
      classifyFulfillment:
        dependencies.classifyFulfillment,
    }
  );

  if (
    payment.status !==
      "ONLINE_PAYMENT_PRECHECK_PASSED" ||
    payment.verifiedOutstandingRappen !== 0
  ) {
    throw new Error("COMBINED_PAYMENT_PRECHECK_FAILED");
  }

  const quote = await verifyOriginalQuoteV1651(
    orderId,
    {
      db: dependencies.db,
      readShopifyPayment: sameSnapshot,
    }
  );

  if (
    quote.shopifyOrderId !== orderId ||
    !quote.requestId ||
    quote.expectedTotalRappen < 1
  ) {
    throw new Error("COMBINED_QUOTE_MISMATCH");
  }

  return {
    ok: true,
    status:
      "ONLINE_PAYMENT_AND_QUOTE_PRECHECK_PASSED",
    shopifyOrderId: orderId,
    requestId: quote.requestId,
    expectedTotalRappen:
      quote.expectedTotalRappen,
  };
}

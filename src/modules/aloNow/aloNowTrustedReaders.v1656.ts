// ALO_NOW_V1656_TRUSTED_READERS
// Strict dependency-injected backend reader connector.
// NO HTTP route, Shopify mutation, DB mutation or deployment.
// DB reader is explicitly bound to the supplied session client.
// Shopify payment and full-order data must come from trusted,
// fresh, server-side readers under the caller's order lock.

import {
  getStaffOrderChannel,
} from "../orders/orderFulfillmentType.js";

import type {
  QuoteShopifySnapshotV1651,
} from "./aloNowVerifiedQuoteBinding.v1651.js";

export type ReaderClientV1656 = {
  query(
    sql: string,
    params?: unknown[]
  ): Promise<{
    rows: any[];
    rowCount: number | null;
  }>;
};

export type ShopifyOrderReaderV1656 = {
  id: string;
  fulfillmentOrders?: {
    edges?: Array<{
      node?: {
        deliveryMethod?: {
          presentedName?: string | null;
          methodType?: string | null;
        } | null;
      } | null;
    }>;
    pageInfo?: {
      hasNextPage?: boolean;
    };
  };
};

export type TrustedShopifyReadersV1656 = {
  readPayment: (
    orderId: string
  ) => Promise<QuoteShopifySnapshotV1651 | null>;
  readFullOrder: (
    orderId: string
  ) => Promise<ShopifyOrderReaderV1656 | null>;
};

export function bindTrustedReadersV1656(
  client: ReaderClientV1656,
  shopify: TrustedShopifyReadersV1656
) {
  if (
    !client ||
    typeof client.query !== "function" ||
    !shopify ||
    typeof shopify.readPayment !== "function" ||
    typeof shopify.readFullOrder !== "function"
  ) {
    throw new Error("INVALID_TRUSTED_READER_DEPENDENCIES");
  }

  return {
    async readWorkflow(orderId: string) {
      if (
        !/^gid:\/\/shopify\/Order\/[1-9]\d*$/.test(
          orderId ?? ""
        )
      ) {
        throw new Error("INVALID_WORKFLOW_ORDER_ID");
      }

      const result = await client.query(`
        SELECT shopify_order_id, pack_status
        FROM order_fulfillment_workflow
        WHERE shopify_order_id = $1
        LIMIT 2
      `, [orderId]);

      if (result.rows.length > 1) {
        throw new Error("DUPLICATE_WORKFLOW");
      }

      const row = result.rows[0];

      if (!row) {
        return null;
      }

      if (row.shopify_order_id !== orderId) {
        throw new Error("WORKFLOW_ORDER_MISMATCH");
      }

      return {
        pack_status: row.pack_status as string,
      };
    },

    async readPaymentAndChannel(orderId: string) {
      if (
        !/^gid:\/\/shopify\/Order\/[1-9]\d*$/.test(
          orderId ?? ""
        )
      ) {
        throw new Error("INVALID_SHOPIFY_ORDER_ID");
      }

      // Both results must be freshly loaded for this request.
      // Do not accept a client-side or cached channel.
      const payment = await shopify.readPayment(orderId);

      if (!payment || payment.id !== orderId) {
        throw new Error("PAYMENT_ORDER_MISMATCH");
      }

      const fullOrder =
        await shopify.readFullOrder(orderId);

      if (!fullOrder || fullOrder.id !== orderId) {
        throw new Error("FULL_ORDER_MISMATCH");
      }

      const orders =
        fullOrder.fulfillmentOrders;

      if (
        orders?.pageInfo?.hasNextPage !== false ||
        !Array.isArray(orders?.edges) ||
        orders.edges.length === 0 ||
        orders.edges.some(
          edge =>
            !edge?.node ||
            !edge.node.deliveryMethod
        )
      ) {
        throw new Error("INCOMPLETE_FULFILLMENT_CHANNEL");
      }

      const channel =
        getStaffOrderChannel(fullOrder);

      if (channel !== "ALO_NOW") {
        throw new Error("ORDER_CHANNEL_NOT_ALO_NOW");
      }

      return {
        payment,
        channel: "ALO_NOW" as const,
      };
    },
  };
}

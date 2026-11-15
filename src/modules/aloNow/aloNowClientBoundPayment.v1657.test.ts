import test from "node:test";
import assert from "node:assert/strict";

import {
  createClientBoundPaymentV1657,
} from "./aloNowClientBoundPayment.v1657.js";

const id = "gid://shopify/Order/123";

function harness(
  options: {
    channel?: string;
    wrongId?: boolean;
    mixed?: boolean;
    truncated?: boolean;
  } = {}
) {
  const sql: string[] = [];
  let paymentReads = 0;
  let orderReads = 0;

  const client = {
    async query(query: string, params?: unknown[]) {
      sql.push(query);
      assert.deepEqual(params, [id]);
      return {
        rows: [{
          shopify_order_id: id,
          pack_status: "PACKED",
        }],
        rowCount: 1,
      };
    },
  };

  const shopify = {
    async readPayment(orderId: string) {
      assert.equal(orderId, id);
      paymentReads++;
      return {
        id,
        cancelledAt: null,
        displayFinancialStatus: "PAID",
        totalPriceSet: {
          shopMoney: {
            amount: "32.50",
            currencyCode: "CHF",
          },
        },
        totalOutstandingSet: {
          shopMoney: {
            amount: "0.00",
            currencyCode: "CHF",
          },
        },
      };
    },

    async readFullOrder(orderId: string) {
      assert.equal(orderId, id);
      orderReads++;

      const node = (presentedName: string) => ({
        node: {
          deliveryMethod: {
            presentedName,
            methodType: "LOCAL",
          },
        },
      });

      return {
        id: options.wrongId
          ? "gid://shopify/Order/999"
          : id,
        fulfillmentOrders: {
          edges: [
            node(options.channel ?? "ALO NOW"),
            ...(options.mixed
              ? [node("Versand")]
              : []),
          ],
          pageInfo: {
            hasNextPage: options.truncated ?? false,
          },
        },
      };
    },
  };

  return {
    client,
    deps: createClientBoundPaymentV1657(client, shopify),
    sql,
    counts: () => ({paymentReads, orderReads}),
  };
}

test("Workflow nutzt denselben Client", async () => {
  const h = harness();
  const result = await h.deps.readWorkflow(id);
  assert.equal(result?.pack_status, "PACKED");
  assert.equal(h.sql.length, 1);
  assert.match(
    h.sql[0],
    /FROM order_fulfillment_workflow/
  );
});

test("Gültige ALO-NOW-Bestellung wird erkannt", async () => {
  const h = harness();
  const order = await h.deps.readShopifyPayment(id);
  assert.ok(order);
  assert.equal(
    h.deps.classifyFulfillment(order!),
    "ALO_NOW"
  );
  assert.deepEqual(h.counts(), {
    paymentReads: 1,
    orderReads: 1,
  });
});

test("Anderer Snapshot darf Klassifikation nicht erben", async () => {
  const h = harness();
  const order = await h.deps.readShopifyPayment(id);
  assert.ok(order);
  assert.equal(
    h.deps.classifyFulfillment({...order!}),
    "UNKNOWN"
  );
});

test("Gemischter Kanal wird blockiert", async () => {
  const h = harness({mixed: true});
  await assert.rejects(
    h.deps.readShopifyPayment(id),
    /ORDER_CHANNEL_NOT_ALO_NOW/
  );
});

test("Unvollständige Pagination wird blockiert", async () => {
  const h = harness({truncated: true});
  await assert.rejects(
    h.deps.readShopifyPayment(id),
    /INCOMPLETE_FULFILLMENT_CHANNEL/
  );
});

test("Fremde Shopify-ID wird blockiert", async () => {
  const h = harness({wrongId: true});
  await assert.rejects(
    h.deps.readShopifyPayment(id),
    /FULL_ORDER_MISMATCH/
  );
});

test("Versandbestellung wird blockiert", async () => {
  const h = harness({channel: "Versand"});
  await assert.rejects(
    h.deps.readShopifyPayment(id),
    /ORDER_CHANNEL_NOT_ALO_NOW/
  );
});

test("Ungültige ID wird vor Shopify blockiert", async () => {
  const h = harness();
  await assert.rejects(
    h.deps.readShopifyPayment("123"),
    /INVALID_SHOPIFY_ORDER_ID/
  );
  assert.deepEqual(h.counts(), {
    paymentReads: 0,
    orderReads: 0,
  });
});

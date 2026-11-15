import test from "node:test";
import assert from "node:assert/strict";

import {
  bindTrustedReadersV1656,
} from "./aloNowTrustedReaders.v1656.js";

const id = "gid://shopify/Order/123";

function fixture(options: {
  channel?: string;
  partialPage?: boolean;
  wrongPayment?: boolean;
  wrongFullOrder?: boolean;
  mixed?: boolean;
  duplicateWorkflow?: boolean;
  missingWorkflow?: boolean;
  missingMethod?: boolean;
} = {}) {
  const queries: Array<{
    sql: string;
    params: unknown[] | undefined;
  }> = [];

  let paymentCalls = 0;
  let fullOrderCalls = 0;

  const client = {
    async query(sql: string, params?: unknown[]) {
      queries.push({sql, params});

      if (!sql.includes("FROM order_fulfillment_workflow")) {
        throw new Error("UNEXPECTED_SQL");
      }

      return {
        rows: options.duplicateWorkflow
          ? [
              {shopify_order_id: id, pack_status: "PACKED"},
              {shopify_order_id: id, pack_status: "PACKED"},
            ]
          : options.missingWorkflow
            ? []
            : [{
                shopify_order_id: id,
                pack_status: "PACKED",
              }],
        rowCount: options.duplicateWorkflow ? 2 : 1,
      };
    },
  };

  const shopify = {
    async readPayment(orderId: string) {
      paymentCalls++;
      assert.equal(orderId, id);

      return {
        id: options.wrongPayment
          ? "gid://shopify/Order/999"
          : id,
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
      fullOrderCalls++;
      assert.equal(orderId, id);

      const presentedName =
        options.channel ?? "ALO NOW";

      return {
        id: options.wrongFullOrder
          ? "gid://shopify/Order/999"
          : id,
        fulfillmentOrders: {
          edges: [
            {
              node: {
                deliveryMethod: options.missingMethod
                  ? undefined
                  : {
                      presentedName,
                      methodType: "LOCAL",
                    },
              },
            },
            ...(options.mixed ? [{
              node: {
                deliveryMethod: {
                  presentedName: "Versand",
                  methodType: "SHIPPING",
                },
              },
            }] : []),
          ],
          pageInfo: {
            hasNextPage:
              options.partialPage ?? false,
          },
        },
      };
    },
  };

  return {
    readers: bindTrustedReadersV1656(client, shopify),
    queries,
    paymentCalls: () => paymentCalls,
    fullOrderCalls: () => fullOrderCalls,
  };
}

test("Workflow verwendet den gebundenen Client", async () => {
  const f = fixture();

  const workflow = await f.readers.readWorkflow(id);

  assert.equal(workflow?.pack_status, "PACKED");
  assert.equal(f.queries.length, 1);
  assert.deepEqual(f.queries[0].params, [id]);
  assert.match(
    f.queries[0].sql,
    /FROM order_fulfillment_workflow/
  );
});

test("ALO NOW wird streng erkannt", async () => {
  const f = fixture();

  const result =
    await f.readers.readPaymentAndChannel(id);

  assert.equal(result.channel, "ALO_NOW");
  assert.equal(result.payment.id, id);
  assert.equal(f.paymentCalls(), 1);
  assert.equal(f.fullOrderCalls(), 1);
});

test("Fremde Zahlung wird sofort blockiert", async () => {
  const f = fixture({wrongPayment: true});

  await assert.rejects(
    f.readers.readPaymentAndChannel(id),
    /PAYMENT_ORDER_MISMATCH/
  );

  assert.equal(f.fullOrderCalls(), 0);
});

test("Fremde Gesamtbestellung wird blockiert", async () => {
  const f = fixture({wrongFullOrder: true});

  await assert.rejects(
    f.readers.readPaymentAndChannel(id),
    /FULL_ORDER_MISMATCH/
  );
});

test("Gemischte Lieferkanäle werden blockiert", async () => {
  const f = fixture({mixed: true});

  await assert.rejects(
    f.readers.readPaymentAndChannel(id),
    /ORDER_CHANNEL_NOT_ALO_NOW/
  );
});

test("Unvollständige Shopify-Seite wird blockiert", async () => {
  const f = fixture({partialPage: true});

  await assert.rejects(
    f.readers.readPaymentAndChannel(id),
    /INCOMPLETE_FULFILLMENT_CHANNEL/
  );
});

test("Versandbestellung wird blockiert", async () => {
  const f = fixture({channel: "Versand"});

  await assert.rejects(
    f.readers.readPaymentAndChannel(id),
    /ORDER_CHANNEL_NOT_ALO_NOW/
  );
});

test("Doppelter Workflow wird blockiert", async () => {
  const f = fixture({duplicateWorkflow: true});

  await assert.rejects(
    f.readers.readWorkflow(id),
    /DUPLICATE_WORKFLOW/
  );
});

test("Fehlender Workflow bleibt null", async () => {
  const f = fixture({missingWorkflow: true});

  assert.equal(
    await f.readers.readWorkflow(id),
    null
  );
});

test("Fehlende Liefermethode wird blockiert", async () => {
  const f = fixture({missingMethod: true});

  await assert.rejects(
    f.readers.readPaymentAndChannel(id),
    /INCOMPLETE_FULFILLMENT_CHANNEL/
  );
});

test("Ungültige Bestellung löst keinen Query aus", async () => {
  const f = fixture();

  await assert.rejects(
    f.readers.readWorkflow("123"),
    /INVALID_WORKFLOW_ORDER_ID/
  );

  assert.equal(f.queries.length, 0);
});

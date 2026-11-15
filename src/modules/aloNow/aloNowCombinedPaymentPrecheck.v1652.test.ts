import test from "node:test";
import assert from "node:assert/strict";

import {
  inspectCombinedPaymentV1652,
} from "./aloNowCombinedPaymentPrecheck.v1652.js";

const id = "gid://shopify/Order/123";

function harness(options: {
  changedTotal?: boolean;
  pending?: boolean;
  duplicate?: boolean;
  cash?: boolean;
  unpacked?: boolean;
  wrongOrder?: boolean;
} = {}) {
  let shopifyReads = 0;
  let workflowReads = 0;
  let paymentReads = 0;
  let quoteReads = 0;

  const dependencies = {
    db: {
      async query(sql: string, params?: unknown[]) {
        assert.deepEqual(params, [id, "123"]);

        if (
          sql.includes("JOIN alo_now_order_requests")
        ) {
          quoteReads++;
          const row = {
            order_id: id,
            payment_request_id: "request-1",
            request_id: "request-1",
            payment_method:
              options.cash ? "CASH" : "ONLINE",
            phase: options.cash
              ? "CASH_CONFIRMED"
              : "PAYMENT_CONFIRMED",
            quote_status: "STANDARD",
            verified_at: "2026-11-03T18:00:00Z",
            subtotal: "29.50",
            fee: "3.00",
          };
          return {
            rows: options.duplicate ? [row, row] : [row],
            rowCount: options.duplicate ? 2 : 1,
          };
        }

        if (
          sql.includes("FROM alo_now_payment_states")
        ) {
          paymentReads++;
          const row = {
            shopify_order_id: "123",
            payment_method:
              options.cash ? "CASH" : "ONLINE",
            phase: options.cash
              ? "CASH_CONFIRMED"
              : "PAYMENT_CONFIRMED",
          };
          return {
            rows: options.duplicate ? [row, row] : [row],
            rowCount: options.duplicate ? 2 : 1,
          };
        }

        throw new Error("UNEXPECTED_PAYMENT_SQL");
      },
    },

    async readShopifyPayment(orderId: string) {
      assert.equal(orderId, id);
      shopifyReads++;

      return {
        id: options.wrongOrder
          ? "gid://shopify/Order/999"
          : id,
        cancelledAt: null,
        displayFinancialStatus:
          options.pending || options.cash
            ? "PENDING"
            : "PAID",
        totalPriceSet: {
          shopMoney: {
            amount: options.changedTotal
              ? "27.50"
              : "32.50",
            currencyCode: "CHF",
          },
        },
        totalOutstandingSet: {
          shopMoney: {
            amount: options.cash
              ? "32.50"
              : "0.00",
            currencyCode: "CHF",
          },
        },
      };
    },

    async readWorkflow(orderId: string) {
      assert.equal(orderId, id);
      workflowReads++;
      return {
        pack_status: options.unpacked
          ? "PACKING"
          : "PACKED",
      };
    },

    classifyFulfillment() {
      return "ALO_NOW";
    },
  };

  return {
    dependencies,
    counts: () => ({
      shopifyReads,
      workflowReads,
      paymentReads,
      quoteReads,
    }),
  };
}

test("Beide Onlineprüfungen bestehen", async () => {
  const h = harness();

  const result = await inspectCombinedPaymentV1652(
    id, h.dependencies
  );

  assert.equal(
    result.status,
    "ONLINE_PAYMENT_AND_QUOTE_PRECHECK_PASSED"
  );
  assert.equal(result.expectedTotalRappen, 3250);
  assert.equal(result.requestId, "request-1");
  assert.deepEqual(h.counts(), {
    shopifyReads: 1,
    workflowReads: 1,
    paymentReads: 1,
    quoteReads: 1,
  });
});

test("Geänderte Originalsumme wird blockiert", async () => {
  const h = harness({changedTotal: true});

  await assert.rejects(
    inspectCombinedPaymentV1652(id, h.dependencies),
    /ORIGINAL_QUOTE_TOTAL_MISMATCH/
  );

  assert.equal(h.counts().shopifyReads, 1);
});

test("Offene Onlinezahlung wird blockiert", async () => {
  const h = harness({pending: true});

  await assert.rejects(
    inspectCombinedPaymentV1652(id, h.dependencies),
    /ONLINE_PAYMENT_NOT_FULLY_VERIFIED/
  );

  assert.equal(h.counts().quoteReads, 0);
});

test("Barzahlung wird nicht freigegeben", async () => {
  const h = harness({cash: true});

  await assert.rejects(
    inspectCombinedPaymentV1652(id, h.dependencies),
    /CASH_COLLECTION_EVIDENCE_REQUIRED/
  );
});

test("Unverpackte Bestellung wird blockiert", async () => {
  const h = harness({unpacked: true});

  await assert.rejects(
    inspectCombinedPaymentV1652(id, h.dependencies),
    /ORDER_NOT_PACKED/
  );
});

test("Fremde Shopify-Bestellung wird blockiert", async () => {
  const h = harness({wrongOrder: true});

  await assert.rejects(
    inspectCombinedPaymentV1652(id, h.dependencies),
    /COMBINED_SHOPIFY_ORDER_MISMATCH/
  );

  assert.equal(h.counts().paymentReads, 0);
  assert.equal(h.counts().quoteReads, 0);
});

test("Doppelte Zahlungszuordnung wird blockiert", async () => {
  const h = harness({duplicate: true});

  await assert.rejects(
    inspectCombinedPaymentV1652(id, h.dependencies),
    /PAYMENT_BINDING_NOT_UNIQUE/
  );

  assert.equal(h.counts().quoteReads, 0);
});

test("Ungültige Bestellung liest keine Daten", async () => {
  const h = harness();

  await assert.rejects(
    inspectCombinedPaymentV1652("123", h.dependencies),
    /INVALID_COMBINED_PAYMENT_CONTEXT/
  );

  assert.equal(h.counts().shopifyReads, 0);
});

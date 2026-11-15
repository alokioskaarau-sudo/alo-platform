import test from "node:test";
import assert from "node:assert/strict";

import {
  inspectPartialPaymentV1649,
} from "./aloNowPartialPaymentEvidence.v1649.js";

const id = "gid://shopify/Order/123";

function harness(options: {
  duplicate?: boolean;
  phase?: string;
  method?: string;
  status?: string;
  outstanding?: string;
  currency?: string;
  cancelled?: boolean;
  packed?: boolean;
  wrongOrder?: boolean;
  malformedAmount?: boolean;
} = {}) {
  let shopifyCalls = 0;
  let workflowCalls = 0;

  const dependencies = {
    db: {
      async query(sql: string, params?: unknown[]) {
        assert.ok(
          sql.includes("FROM alo_now_payment_states")
        );
        assert.deepEqual(params, [id, "123"]);

        const row = {
          shopify_order_id: "123",
          payment_method: options.method ?? "ONLINE",
          phase: options.phase ?? "PAYMENT_CONFIRMED",
        };

        return {
          rows: options.duplicate ? [row, row] : [row],
          rowCount: options.duplicate ? 2 : 1,
        };
      },
    },

    async readShopifyOrder(orderId: string) {
      shopifyCalls++;
      assert.equal(orderId, id);

      return {
        id: options.wrongOrder
          ? "gid://shopify/Order/999"
          : id,
        cancelledAt: options.cancelled
          ? "2026-11-03T12:00:00Z"
          : null,
        displayFinancialStatus:
          options.status ?? "PAID",
        totalPriceSet: {
          shopMoney: {
            amount: options.malformedAmount
              ? "invalid"
              : "20.00",
            currencyCode: options.currency ?? "CHF",
          },
        },
        totalOutstandingSet: {
          shopMoney: {
            amount: options.outstanding ?? "0.00",
            currencyCode: options.currency ?? "CHF",
          },
        },
      };
    },

    async readWorkflow(orderId: string) {
      workflowCalls++;
      assert.equal(orderId, id);
      return {
        pack_status: options.packed === false
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
    shopifyCalls: () => shopifyCalls,
    workflowCalls: () => workflowCalls,
  };
}

test("ONLINE: echte Quellen ergeben Vorprüfung", async () => {
  const h = harness();
  const result = await inspectPartialPaymentV1649(
    id, h.dependencies
  );

  assert.equal(
    result.status,
    "ONLINE_PAYMENT_PRECHECK_PASSED"
  );
  assert.equal(result.verifiedOutstandingRappen, 0);
  assert.equal(h.shopifyCalls(), 1);
  assert.equal(h.workflowCalls(), 1);
});

test("Doppelte Bindung stoppt vor Shopify", async () => {
  const h = harness({duplicate: true});

  await assert.rejects(
    inspectPartialPaymentV1649(id, h.dependencies),
    /PAYMENT_BINDING_NOT_UNIQUE/
  );

  assert.equal(h.shopifyCalls(), 0);
});

test("PENDING wird blockiert", async () => {
  const h = harness({status: "PENDING"});

  await assert.rejects(
    inspectPartialPaymentV1649(id, h.dependencies),
    /ONLINE_PAYMENT_NOT_FULLY_VERIFIED/
  );
});

test("Restbetrag blockiert", async () => {
  const h = harness({outstanding: "5.00"});

  await assert.rejects(
    inspectPartialPaymentV1649(id, h.dependencies),
    /ONLINE_PAYMENT_NOT_FULLY_VERIFIED/
  );
});

test("CASH bleibt ohne Kassennachweis gesperrt", async () => {
  const h = harness({
    method: "CASH",
    phase: "CASH_CONFIRMED",
    status: "PENDING",
    outstanding: "20.00",
  });

  await assert.rejects(
    inspectPartialPaymentV1649(id, h.dependencies),
    /CASH_COLLECTION_EVIDENCE_REQUIRED/
  );
});

test("Stornierte Bestellung blockiert", async () => {
  const h = harness({cancelled: true});

  await assert.rejects(
    inspectPartialPaymentV1649(id, h.dependencies),
    /SHOPIFY_ORDER_CANCELLED/
  );
});

test("Unverpackt wird blockiert", async () => {
  const h = harness({packed: false});

  await assert.rejects(
    inspectPartialPaymentV1649(id, h.dependencies),
    /ORDER_NOT_PACKED/
  );
});

test("Falsche Shopify-ID blockiert", async () => {
  const h = harness({wrongOrder: true});

  await assert.rejects(
    inspectPartialPaymentV1649(id, h.dependencies),
    /SHOPIFY_ORDER_MISMATCH/
  );
});

test("Ungültiger Betrag wird blockiert", async () => {
  const h = harness({malformedAmount: true});

  await assert.rejects(
    inspectPartialPaymentV1649(id, h.dependencies),
    /INVALID_SHOPIFY_AMOUNT/
  );
});

test("Ungültiger Request greift auf nichts zu", async () => {
  const h = harness();

  await assert.rejects(
    inspectPartialPaymentV1649(
      "123",
      h.dependencies
    ),
    /INVALID_PAYMENT_READER_CONTEXT/
  );

  assert.equal(h.shopifyCalls(), 0);
  assert.equal(h.workflowCalls(), 0);
});

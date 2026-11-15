import test from "node:test";
import assert from "node:assert/strict";

import {
  inspectTrustedLockedPreflightV1658,
} from "./aloNowTrustedLockedPreflight.v1658.js";

import {
  fingerprintJournalPayloadV1586,
} from "./aloNowFulfillmentJournal.v1586.js";

const id = "gid://shopify/Order/123";
const fo = "gid://shopify/FulfillmentOrder/456";
const fol = "gid://shopify/FulfillmentOrderLineItem/789";
const li = "gid://shopify/LineItem/100";
const hash = "a".repeat(64);

const manifest = [{
  fulfillmentOrderId: fo,
  fulfillmentOrderLineItems: [{
    id: fol,
    quantity: 2,
    shopifyLineItemId: li,
  }],
}];

const payloadHash = fingerprintJournalPayloadV1586({
  shopifyOrderId: id,
  fulfillmentOrderId: fo,
  selectionHash: hash,
  lines: [{id: fol, quantity: 2}],
});

function harness(options: {
  wrongDriver?: boolean;
  changedTotal?: boolean;
  pending?: boolean;
  mixed?: boolean;
  truncated?: boolean;
  cash?: boolean;
} = {}) {
  const events: string[] = [];
  let locked = false;
  let transaction = false;
  let releaseDestroy: boolean | undefined;
  let paymentReads = 0;
  let fullOrderReads = 0;
  let connections = 0;

  const client = {
    async query(sql: string, params?: unknown[]) {
      const q = sql.trim();

      if (q.includes("pg_advisory_unlock")) {
        assert.equal(locked, true);
        locked = false;
        events.push("UNLOCK");
        return {
          rows: [{released: true}],
          rowCount: 1,
        };
      }

      if (q.includes("pg_advisory_lock")) {
        assert.equal(locked, false);
        locked = true;
        events.push("LOCK");
        return {rows: [{}], rowCount: 1};
      }

      if (q.startsWith("BEGIN")) {
        assert.equal(locked, true);
        assert.equal(transaction, false);
        transaction = true;
        events.push("BEGIN");
        return {rows: [], rowCount: null};
      }

      if (q === "COMMIT" || q === "ROLLBACK") {
        assert.equal(transaction, true);
        transaction = false;
        events.push(q);
        return {rows: [], rowCount: null};
      }

      assert.equal(locked, true);
      assert.equal(transaction, true);

      if (q.includes("to_regclass(")) {
        return {
          rows: [{
            handoff: "alo_now_handoff_ledger",
            selections:
              "alo_now_partial_selections_v1586",
            journal:
              "alo_now_fulfillment_journal_v1586",
          }],
          rowCount: 1,
        };
      }

      if (q.includes("FROM alo_now_deliveries")) {
        return {
          rows: [{
            assigned_driver_user_id:
              options.wrongDriver ? "8" : "7",
            delivery_status: "ON_THE_WAY",
            age_verification_status: "NOT_VERIFIED",
          }],
          rowCount: 1,
        };
      }

      if (q.includes("FROM alo_now_handoff_ledger")) {
        return {
          rows: [{
            assigned_driver_user_id: "7",
            handoff_state: "PREPARED",
            delivered_lines: [{
              lineItemId: li,
              quantity: 2,
            }],
            withheld_lines: [{
              lineItemId:
                "gid://shopify/LineItem/101",
              quantity: 1,
            }],
          }],
          rowCount: 1,
        };
      }

      if (
        q.includes(
          "FROM alo_now_partial_selections_v1586"
        )
      ) {
        return {
          rows: [{
            driver_user_id: "7",
            selection_hash: hash,
            state: "PREPARED",
            expected_fulfillments: manifest,
            selected_lines: [{
              lineItemId: li,
              quantity: 2,
            }],
            withheld_lines: [{
              lineItemId:
                "gid://shopify/LineItem/101",
              quantity: 1,
            }],
          }],
          rowCount: 1,
        };
      }

      if (
        q.includes(
          "FROM alo_now_fulfillment_journal_v1586"
        )
      ) {
        return {
          rows: [{
            fulfillment_order_id: fo,
            selection_hash: hash,
            payload_hash: payloadHash,
            fulfillment_lines:
              manifest[0].fulfillmentOrderLineItems,
            state: "PREPARED",
            shopify_fulfillment_id: null,
          }],
          rowCount: 1,
        };
      }

      if (q.includes("FROM order_fulfillment_workflow")) {
        assert.deepEqual(params, [id]);
        events.push("WORKFLOW");
        return {
          rows: [{
            shopify_order_id: id,
            pack_status: "PACKED",
          }],
          rowCount: 1,
        };
      }

      if (
        q.includes("JOIN alo_now_order_requests")
      ) {
        events.push("QUOTE");
        return {
          rows: [{
            order_id: id,
            payment_request_id: "request-1",
            request_id: "request-1",
            payment_method:
              options.cash ? "CASH" : "ONLINE",
            phase: options.cash
              ? "CASH_CONFIRMED"
              : "PAYMENT_CONFIRMED",
            quote_status: "STANDARD",
            verified_at:
              "2026-11-03T18:00:00Z",
            subtotal: "29.50",
            fee: "3.00",
          }],
          rowCount: 1,
        };
      }

      if (
        q.includes("FROM alo_now_payment_states")
      ) {
        events.push("PAYMENT_DB");
        return {
          rows: [{
            shopify_order_id: id,
            payment_method:
              options.cash ? "CASH" : "ONLINE",
            phase: options.cash
              ? "CASH_CONFIRMED"
              : "PAYMENT_CONFIRMED",
          }],
          rowCount: 1,
        };
      }

      throw new Error("UNEXPECTED_SQL_V1658");
    },

    release(destroy?: boolean) {
      releaseDestroy = destroy;
      events.push("RELEASE");
    },
  };

  const shopify = {
    async readPayment(orderId: string) {
      assert.equal(orderId, id);
      assert.equal(locked, true);
      paymentReads++;
      events.push("SHOPIFY_PAYMENT");

      return {
        id,
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

    async readFullOrder(orderId: string) {
      assert.equal(orderId, id);
      assert.equal(locked, true);
      fullOrderReads++;
      events.push("SHOPIFY_FULL_ORDER");

      const channel = (name: string) => ({
        node: {
          deliveryMethod: {
            presentedName: name,
            methodType: "LOCAL",
          },
        },
      });

      return {
        id,
        fulfillmentOrders: {
          edges: [
            channel("ALO NOW"),
            ...(options.mixed
              ? [channel("Versand")]
              : []),
          ],
          pageInfo: {
            hasNextPage:
              options.truncated ?? false,
          },
        },
      };
    },
  };

  return {
    dependencies: {
      pool: {
        async connect() {
          connections++;
          events.push("CONNECT");
          return client;
        },
      },
      shopify,
    },
    events,
    releaseDestroy: () => releaseDestroy,
    counts: () => ({
      connections,
      paymentReads,
      fullOrderReads,
    }),
  };
}

async function execute(
  h: ReturnType<typeof harness>
) {
  return inspectTrustedLockedPreflightV1658(
    {
      shopifyOrderId: id,
      staffUserId: "7",
    },
    h.dependencies as any
  );
}

test("Vollständige Vorprüfung funktioniert unter einem Lock",
  async () => {
    const h = harness();
    const result = await execute(h);

    assert.equal(
      result.status,
      "PREFLIGHT_PASSED_NOT_AUTHORIZED"
    );
    assert.equal(result.expectedTotalRappen, 3250);

    assert.deepEqual(h.counts(), {
      connections: 1,
      paymentReads: 1,
      fullOrderReads: 1,
    });

    assert.equal(h.releaseDestroy(), false);
    assert.equal(
      h.events.filter(x => x === "BEGIN").length,
      2
    );
    assert.equal(
      h.events.filter(x => x === "COMMIT").length,
      2
    );
    assert.ok(
      h.events.indexOf("LOCK") <
      h.events.indexOf("SHOPIFY_PAYMENT")
    );
    assert.ok(
      h.events.indexOf("WORKFLOW") <
      h.events.indexOf("UNLOCK")
    );
  }
);

test("Fremder Fahrer stoppt vor Shopify", async () => {
  const h = harness({wrongDriver: true});

  await assert.rejects(
    execute(h),
    /NOT_ASSIGNED_TO_DRIVER/
  );

  assert.equal(h.counts().paymentReads, 0);
  assert.equal(h.releaseDestroy(), false);
});

test("Geänderter Bestellbetrag stoppt", async () => {
  const h = harness({changedTotal: true});

  await assert.rejects(
    execute(h),
    /ORIGINAL_QUOTE_TOTAL_MISMATCH/
  );

  assert.ok(h.events.includes("ROLLBACK"));
  assert.equal(h.releaseDestroy(), false);
});

test("Gemischte Versandarten stoppen", async () => {
  const h = harness({mixed: true});

  await assert.rejects(
    execute(h),
    /ORDER_CHANNEL_NOT_ALO_NOW/
  );

  assert.equal(h.counts().paymentReads, 1);
  assert.equal(h.counts().fullOrderReads, 1);
});

test("Unvollständige Shopify-Pagination stoppt",
  async () => {
    const h = harness({truncated: true});

    await assert.rejects(
      execute(h),
      /INCOMPLETE_FULFILLMENT_CHANNEL/
    );
  }
);

test("Unbestätigte Onlinezahlung stoppt", async () => {
  const h = harness({pending: true});

  await assert.rejects(
    execute(h),
    /ONLINE_PAYMENT_NOT_FULLY_VERIFIED/
  );
});

test("CASH wird nicht als ONLINE freigegeben", async () => {
  const h = harness({cash: true});

  await assert.rejects(
    execute(h),
    /CASH_COLLECTION_EVIDENCE_REQUIRED/
  );
});

test("Ungültige Bestellung öffnet keinen Client",
  async () => {
    const h = harness();

    await assert.rejects(
      inspectTrustedLockedPreflightV1658(
        {
          shopifyOrderId: "123",
          staffUserId: "7",
        },
        h.dependencies as any
      ),
      /INVALID_LOCKED_PREFLIGHT_REQUEST/
    );

    assert.equal(h.counts().connections, 0);
  }
);

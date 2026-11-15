import test from "node:test";
import assert from "node:assert/strict";

import {
  inspectLockedPreflightV1653,
} from "./aloNowLockedPreflight.v1653.js";

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
  paymentPending?: boolean;
  changedTotal?: boolean;
  lockFailure?: boolean;
  unlockFailure?: boolean;
  rollbackFailure?: boolean;
} = {}) {
  const events: string[] = [];
  let released: boolean | undefined;
  let shopifyReads = 0;
  let insideTransaction = false;
  let lockHeld = false;
  let connects = 0;

  const client = {
    async query(sql: string, params?: unknown[]) {
      const q = sql.trim();

      if (q.includes("pg_advisory_unlock")) {
        events.push("UNLOCK");
        if (options.unlockFailure) {
          throw new Error("UNLOCK_FAILURE");
        }
        lockHeld = false;
        return {
          rows: [{released: true}],
          rowCount: 1,
        };
      }

      if (q.includes("pg_advisory_lock")) {
        events.push("LOCK");
        if (options.lockFailure) {
          throw new Error("LOCK_FAILURE");
        }
        assert.equal(params?.length, 1);
        lockHeld = true;
        return {rows: [{}], rowCount: 1};
      }

      if (q.startsWith("BEGIN")) {
        assert.equal(lockHeld, true);
        assert.equal(insideTransaction, false);
        insideTransaction = true;
        events.push("BEGIN");
        return {rows: [], rowCount: null};
      }

      if (q === "COMMIT") {
        assert.equal(insideTransaction, true);
        insideTransaction = false;
        events.push("COMMIT");
        return {rows: [], rowCount: null};
      }

      if (q === "ROLLBACK") {
        events.push("ROLLBACK");
        if (options.rollbackFailure) {
          throw new Error("ROLLBACK_FAILURE");
        }
        insideTransaction = false;
        return {rows: [], rowCount: null};
      }

      assert.equal(lockHeld, true);
      assert.equal(insideTransaction, true);
      assert.deepEqual(
        params ?? [],
        q.includes("to_regclass(") ? [] :
        q.includes("alo_now_payment_states")
          ? [id, "123"] : [id]
      );

      if (q.includes("to_regclass(")) {
        return {
          rows: [{
            handoff: "alo_now_handoff_ledger",
            selections: "alo_now_partial_selections_v1586",
            journal: "alo_now_fulfillment_journal_v1586",
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
            delivered_lines: [
              {lineItemId: li, quantity: 2},
            ],
            withheld_lines: [
              {
                lineItemId:
                  "gid://shopify/LineItem/101",
                quantity: 1,
              },
            ],
          }],
          rowCount: 1,
        };
      }

      if (
        q.includes("FROM alo_now_partial_selections_v1586")
      ) {
        return {
          rows: [{
            driver_user_id: "7",
            selection_hash: hash,
            state: "PREPARED",
            expected_fulfillments: manifest,
            selected_lines: [
              {lineItemId: li, quantity: 2},
            ],
            withheld_lines: [
              {
                lineItemId:
                  "gid://shopify/LineItem/101",
                quantity: 1,
              },
            ],
          }],
          rowCount: 1,
        };
      }

      if (
        q.includes("FROM alo_now_fulfillment_journal_v1586")
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

      if (q.includes("JOIN alo_now_order_requests")) {
        events.push("QUOTE_READ");
        return {
          rows: [{
            order_id: id,
            payment_request_id: "request-1",
            request_id: "request-1",
            payment_method: "ONLINE",
            phase: "PAYMENT_CONFIRMED",
            quote_status: "STANDARD",
            verified_at: "2026-11-03T18:00:00Z",
            subtotal: "29.50",
            fee: "3.00",
          }],
          rowCount: 1,
        };
      }

      if (q.includes("FROM alo_now_payment_states")) {
        events.push("PAYMENT_READ");
        return {
          rows: [{
            shopify_order_id: "123",
            payment_method: "ONLINE",
            phase: "PAYMENT_CONFIRMED",
          }],
          rowCount: 1,
        };
      }

      throw new Error("UNEXPECTED_SQL");
    },

    release(destroy?: boolean) {
      released = destroy;
      events.push("RELEASE");
    },
  };

  const dependencies = {
    pool: {
      async connect() {
        connects++;
        events.push("CONNECT");
        return client;
      },
    },
    payment: {
      async readShopifyPayment(orderId: string) {
        assert.equal(orderId, id);
        assert.equal(lockHeld, true);
        shopifyReads++;
        events.push("SHOPIFY_READ");
        return {
          id,
          cancelledAt: null,
          displayFinancialStatus:
            options.paymentPending ? "PENDING" : "PAID",
          totalPriceSet: {
            shopMoney: {
              amount: options.changedTotal
                ? "27.50" : "32.50",
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
      async readWorkflow(orderId: string) {
        assert.equal(orderId, id);
        assert.equal(lockHeld, true);
        events.push("WORKFLOW_READ");
        return {pack_status: "PACKED"};
      },
      classifyFulfillment() {
        return "ALO_NOW";
      },
    },
  };

  return {
    dependencies,
    events,
    released: () => released,
    shopifyReads: () => shopifyReads,
    connects: () => connects,
  };
}

test("Snapshot und Zahlung unter einem Lock", async () => {
  const h = harness();

  const result = await inspectLockedPreflightV1653(
    {shopifyOrderId: id, staffUserId: "7"},
    h.dependencies
  );

  assert.equal(
    result.status,
    "PREFLIGHT_PASSED_NOT_AUTHORIZED"
  );
  assert.equal(result.expectedTotalRappen, 3250);
  assert.equal(h.shopifyReads(), 1);
  assert.equal(h.connects(), 1);
  assert.equal(h.released(), false);
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
    h.events.indexOf("SHOPIFY_READ")
  );
  assert.ok(
    h.events.indexOf("SHOPIFY_READ") <
    h.events.indexOf("UNLOCK")
  );
});

test("Fremder Fahrer: keine Shopify-Abfrage", async () => {
  const h = harness({wrongDriver: true});

  await assert.rejects(
    inspectLockedPreflightV1653(
      {shopifyOrderId: id, staffUserId: "7"},
      h.dependencies
    ),
    /NOT_ASSIGNED_TO_DRIVER/
  );

  assert.equal(h.shopifyReads(), 0);
  assert.equal(h.released(), false);
});

test("Offene Zahlung: Transaktion zurückrollen", async () => {
  const h = harness({paymentPending: true});

  await assert.rejects(
    inspectLockedPreflightV1653(
      {shopifyOrderId: id, staffUserId: "7"},
      h.dependencies
    ),
    /ONLINE_PAYMENT_NOT_FULLY_VERIFIED/
  );

  assert.ok(h.events.includes("ROLLBACK"));
  assert.equal(h.released(), false);
});

test("Geänderte Summe wird blockiert", async () => {
  const h = harness({changedTotal: true});

  await assert.rejects(
    inspectLockedPreflightV1653(
      {shopifyOrderId: id, staffUserId: "7"},
      h.dependencies
    ),
    /ORIGINAL_QUOTE_TOTAL_MISMATCH/
  );

  assert.equal(h.shopifyReads(), 1);
});

test("Fehler bei Lock-Akquisition verwirft Client", async () => {
  const h = harness({lockFailure: true});

  await assert.rejects(
    inspectLockedPreflightV1653(
      {shopifyOrderId: id, staffUserId: "7"},
      h.dependencies
    ),
    /LOCK_FAILURE/
  );

  assert.equal(h.released(), true);
  assert.equal(h.shopifyReads(), 0);
});

test("Fehler bei Unlock verwirft Client", async () => {
  const h = harness({unlockFailure: true});

  await assert.rejects(
    inspectLockedPreflightV1653(
      {shopifyOrderId: id, staffUserId: "7"},
      h.dependencies
    ),
    /PREFLIGHT_LOCK_RELEASE_UNCERTAIN/
  );

  assert.equal(h.released(), true);
});

test("Unsicherer Rollback verwirft Client", async () => {
  const h = harness({
    paymentPending: true,
    rollbackFailure: true,
  });

  await assert.rejects(
    inspectLockedPreflightV1653(
      {shopifyOrderId: id, staffUserId: "7"},
      h.dependencies
    ),
    /PREFLIGHT_ROLLBACK_UNCERTAIN/
  );

  assert.equal(h.released(), true);
});

test("Ungültiger Request öffnet keine Verbindung", async () => {
  const h = harness();

  await assert.rejects(
    inspectLockedPreflightV1653(
      {shopifyOrderId: "123", staffUserId: "7"},
      h.dependencies
    ),
    /INVALID_LOCKED_PREFLIGHT_REQUEST/
  );

  assert.equal(h.connects(), 0);
});

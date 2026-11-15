import test from "node:test";
import assert from "node:assert/strict";

import {
  readReservedSnapshotV1645,
} from "./aloNowReservedSnapshot.v1645.js";

import {
  fingerprintJournalPayloadV1586,
} from "./aloNowFulfillmentJournal.v1586.js";

const order = "gid://shopify/Order/123";
const fulfillmentOrder =
  "gid://shopify/FulfillmentOrder/456";
const selectionHash = "a".repeat(64);

const lines = [{
  id: "gid://shopify/FulfillmentOrderLineItem/789",
  quantity: 2,
  shopifyLineItemId:
    "gid://shopify/LineItem/100",
}];

const payloadHash = fingerprintJournalPayloadV1586({
  shopifyOrderId: order,
  fulfillmentOrderId: fulfillmentOrder,
  selectionHash,
  lines: lines.map(({id, quantity}) => ({
    id, quantity
  })),
});

const delivered = [{
  lineItemId: "gid://shopify/LineItem/100",
  quantity: 2,
}];

const withheld = [{
  lineItemId: "gid://shopify/LineItem/101",
  quantity: 1,
}];

function harness(options: {
  wrongDriver?: boolean;
  wrongStatus?: boolean;
  changedLedger?: boolean;
  uncertainJournal?: boolean;
  missingSchema?: boolean;
} = {}) {
  const queries: string[] = [];
  let committed = false;
  let rolledBack = false;

  const db = {
    async query(sql: string) {
      const q = sql.trim();
      queries.push(q);

      if (q.startsWith("BEGIN")) {
        return {rows: [], rowCount: null};
      }

      if (q === "COMMIT") {
        committed = true;
        return {rows: [], rowCount: null};
      }

      if (q === "ROLLBACK") {
        rolledBack = true;
        return {rows: [], rowCount: null};
      }

      if (q.includes("to_regclass(")) {
        return {
          rows: [{
            handoff: options.missingSchema ? null : "a",
            selections: "b",
            journal: "c",
          }],
          rowCount: 1,
        };
      }

      if (q.includes("FROM alo_now_deliveries")) {
        return {
          rows: [{
            assigned_driver_user_id:
              options.wrongDriver ? "8" : "7",
            delivery_status:
              options.wrongStatus
                ? "CANCELLED"
                : "ON_THE_WAY",
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
            delivered_lines:
              options.changedLedger
                ? [{...delivered[0], quantity: 99}]
                : delivered,
            withheld_lines: withheld,
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
            selection_hash: selectionHash,
            state: "PREPARED",
            expected_fulfillments: [{
              fulfillmentOrderId: fulfillmentOrder,
              fulfillmentOrderLineItems: lines,
            }],
            selected_lines: delivered,
            withheld_lines: withheld,
          }],
          rowCount: 1,
        };
      }

      if (
        q.includes("FROM alo_now_fulfillment_journal_v1586")
      ) {
        return {
          rows: [{
            fulfillment_order_id: fulfillmentOrder,
            selection_hash: selectionHash,
            payload_hash: payloadHash,
            fulfillment_lines: lines,
            state: options.uncertainJournal
              ? "RECONCILE_REQUIRED"
              : "PREPARED",
            shopify_fulfillment_id: null,
          }],
          rowCount: 1,
        };
      }

      throw new Error("UNEXPECTED_SQL");
    },
  };

  return {
    db,
    queries,
    committed: () => committed,
    rolledBack: () => rolledBack,
  };
}

test("Gültiger Snapshot wird konsistent geladen", async () => {
  const h = harness();

  const snapshot = await readReservedSnapshotV1645(
    h.db, order, "7"
  );

  assert.equal(snapshot.shopifyOrderId, order);
  assert.equal(snapshot.journal.length, 1);
  assert.equal(h.committed(), true);
  assert.equal(h.rolledBack(), false);
  assert.ok(h.queries[0].includes("REPEATABLE READ"));
});

test("Falscher Fahrer wird blockiert", async () => {
  const h = harness({wrongDriver: true});

  await assert.rejects(
    readReservedSnapshotV1645(h.db, order, "7"),
    /NOT_ASSIGNED_TO_DRIVER/
  );

  assert.equal(h.rolledBack(), true);
});

test("Stornierte Lieferung wird blockiert", async () => {
  const h = harness({wrongStatus: true});

  await assert.rejects(
    readReservedSnapshotV1645(h.db, order, "7"),
    /DELIVERY_NOT_ON_THE_WAY/
  );

  assert.equal(h.rolledBack(), true);
});

test("Verändertes Handoff-Ledger wird blockiert", async () => {
  const h = harness({changedLedger: true});

  await assert.rejects(
    readReservedSnapshotV1645(h.db, order, "7"),
    /LEDGER_SELECTION_MISMATCH/
  );

  assert.equal(h.rolledBack(), true);
});

test("Ungeklärter Journalstatus wird blockiert", async () => {
  const h = harness({uncertainJournal: true});

  await assert.rejects(
    readReservedSnapshotV1645(h.db, order, "7"),
    /JOURNAL_RECONCILIATION_REQUIRED/
  );

  assert.equal(h.rolledBack(), true);
});

test("Fehlende Datenbankmigration blockiert", async () => {
  const h = harness({missingSchema: true});

  await assert.rejects(
    readReservedSnapshotV1645(h.db, order, "7"),
    /PARTIAL_SCHEMA_MISSING/
  );

  assert.equal(h.rolledBack(), true);
});

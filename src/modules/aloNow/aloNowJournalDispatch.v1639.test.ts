import test from "node:test";
import assert from "node:assert/strict";

import {
  dispatchJournalEntryV1592,
  type JournalDbV1592,
} from "./aloNowJournalDispatch.v1592.js";

const payload = {
  shopifyOrderId: "123456789",
  fulfillmentOrderId: "gid://shopify/FulfillmentOrder/999",
  selectionHash: "a".repeat(64),
  lines: [
    {
      id: "gid://shopify/FulfillmentOrderLineItem/111",
      quantity: 2,
    },
  ],
};

const fulfillment = {
  id: "gid://shopify/Fulfillment/555",
  status: "SUCCESS",
};

type State =
  | "PREPARED"
  | "DISPATCHING"
  | "CONFIRMED"
  | "RECONCILE_REQUIRED";

function fakeDb(options: {
  failConfirm?: boolean;
  failReconcile?: boolean;
  failCommit?: boolean;
} = {}) {
  let state: State = "PREPARED";
  const queries: string[] = [];

  const db: JournalDbV1592 = {
    async query(sql) {
      const normalized = sql.trim();
      queries.push(normalized);

      if (normalized === "BEGIN" ||
          normalized === "ROLLBACK") {
        return { rows: [], rowCount: null };
      }

      if (normalized === "COMMIT") {
        if (options.failCommit) {
          throw new Error("SIMULATED_COMMIT_FAILURE");
        }
        return { rows: [], rowCount: null };
      }

      if (
        normalized.includes("SET state = 'DISPATCHING'")
      ) {
        if (state !== "PREPARED") {
          return { rows: [], rowCount: 0 };
        }
        state = "DISPATCHING";
        return {
          rows: [{ fulfillment_order_id: payload.fulfillmentOrderId }],
          rowCount: 1,
        };
      }

      if (
        normalized.includes("SET state = 'RECONCILE_REQUIRED'")
      ) {
        if (options.failReconcile) {
          throw new Error("SIMULATED_RECONCILE_FAILURE");
        }
        if (state !== "DISPATCHING") {
          return { rows: [], rowCount: 0 };
        }
        state = "RECONCILE_REQUIRED";
        return {
          rows: [{ fulfillment_order_id: payload.fulfillmentOrderId }],
          rowCount: 1,
        };
      }

      if (
        normalized.includes("SET state = 'CONFIRMED'")
      ) {
        if (options.failConfirm) {
          throw new Error("SIMULATED_CONFIRM_FAILURE");
        }
        if (state !== "DISPATCHING") {
          return { rows: [], rowCount: 0 };
        }
        state = "CONFIRMED";
        return {
          rows: [{ fulfillment_order_id: payload.fulfillmentOrderId }],
          rowCount: 1,
        };
      }

      throw new Error("UNEXPECTED_SQL_IN_MOCK");
    },
  };

  return {
    db,
    queries,
    getState: () => state,
  };
}

test("Erfolg: claim, COMMIT, Shopify, CONFIRMED", async () => {
  const mock = fakeDb();
  let calls = 0;

  const result = await dispatchJournalEntryV1592({
    payload,
    db: mock.db,
    createFulfillment: async input => {
      calls++;
      assert.equal(mock.getState(), "DISPATCHING");
      assert.ok(mock.queries.some(q => q === "COMMIT"));
      assert.deepEqual(input, {
        fulfillmentOrderId: payload.fulfillmentOrderId,
        fulfillmentOrderLineItems: payload.lines,
      });
      return fulfillment;
    },
  });

  assert.equal(result.mode, "FULFILLMENT_CONFIRMED");
  assert.equal(result.shopifyFulfillmentId, fulfillment.id);
  assert.equal(mock.getState(), "CONFIRMED");
  assert.equal(calls, 1);
});

test("Timeout: Abgleich statt zweitem Shopify-Aufruf", async () => {
  const mock = fakeDb();
  let calls = 0;

  const run = () => dispatchJournalEntryV1592({
    payload,
    db: mock.db,
    createFulfillment: async () => {
      calls++;
      throw new Error("SIMULATED_NETWORK_TIMEOUT");
    },
  });

  await assert.rejects(
    run(),
    /SHOPIFY_RESULT_UNCERTAIN_RECONCILIATION_REQUIRED/
  );

  assert.equal(mock.getState(), "RECONCILE_REQUIRED");

  await assert.rejects(
    run(),
    /JOURNAL_NOT_PREPARED_OR_ALREADY_DISPATCHED/
  );

  assert.equal(calls, 1);
});

test("Doppelaufruf: nur eine Shopify-Mutation", async () => {
  const mock = fakeDb();
  let calls = 0;

  const run = () => dispatchJournalEntryV1592({
    payload,
    db: mock.db,
    createFulfillment: async () => {
      calls++;
      return fulfillment;
    },
  });

  const results = await Promise.allSettled([run(), run()]);

  assert.equal(
    results.filter(r => r.status === "fulfilled").length,
    1
  );
  assert.equal(
    results.filter(r => r.status === "rejected").length,
    1
  );
  assert.equal(calls, 1);
  assert.equal(mock.getState(), "CONFIRMED");
});

test("Shopify-Erfolg, Journal-Fehler: kein Retry", async () => {
  const mock = fakeDb({ failConfirm: true });
  let calls = 0;

  const run = () => dispatchJournalEntryV1592({
    payload,
    db: mock.db,
    createFulfillment: async () => {
      calls++;
      return fulfillment;
    },
  });

  await assert.rejects(
    run(),
    /SHOPIFY_SUCCEEDED_JOURNAL_CONFIRMATION_UNCERTAIN/
  );

  await assert.rejects(
    run(),
    /JOURNAL_NOT_PREPARED_OR_ALREADY_DISPATCHED/
  );

  assert.equal(calls, 1);
  assert.equal(mock.getState(), "DISPATCHING");
});

test("Fehlerhafte Shopify-Antwort: Abgleich", async () => {
  const mock = fakeDb();

  await assert.rejects(
    dispatchJournalEntryV1592({
      payload,
      db: mock.db,
      createFulfillment: async () => ({
        id: "",
        status: "",
      }),
    }),
    /SHOPIFY_RESULT_UNCERTAIN_RECONCILIATION_REQUIRED/
  );

  assert.equal(mock.getState(), "RECONCILE_REQUIRED");
});

test("Unklarer COMMIT: kein Shopify-Aufruf", async () => {
  const mock = fakeDb({ failCommit: true });
  let calls = 0;

  await assert.rejects(
    dispatchJournalEntryV1592({
      payload,
      db: mock.db,
      createFulfillment: async () => {
        calls++;
        return fulfillment;
      },
    }),
    /SIMULATED_COMMIT_FAILURE/
  );

  assert.equal(calls, 0);
});

test("Timeout und Journal-Fehler: unsicherer Zustand", async () => {
  const mock = fakeDb({ failReconcile: true });
  let calls = 0;

  await assert.rejects(
    dispatchJournalEntryV1592({
      payload,
      db: mock.db,
      createFulfillment: async () => {
        calls++;
        throw new Error("SIMULATED_TIMEOUT");
      },
    }),
    /SHOPIFY_RESULT_UNCERTAIN_AND_JOURNAL_UNCERTAIN/
  );

  assert.equal(calls, 1);
  assert.equal(mock.getState(), "DISPATCHING");
});

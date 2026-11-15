import test from "node:test";
import assert from "node:assert/strict";

import {
  executePartialDispatchV1642,
} from "./aloNowPartialOrchestrator.v1642.js";

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
}];

const payload = {
  shopifyOrderId: order,
  fulfillmentOrderId: fulfillmentOrder,
  selectionHash,
  lines,
};

const payloadHash =
  fingerprintJournalPayloadV1586(payload);

function makeHarness(options: {
  confirmed?: boolean;
  timeout?: boolean;
  wrongOrder?: boolean;
  wrongQuantity?: boolean;
  denied?: boolean;
} = {}) {
  let locked = false;
  let state = options.confirmed
    ? "CONFIRMED"
    : "PREPARED";
  let mutations = 0;
  let loads = 0;

  const dependencies = {
    async withOrderLock<T>(
      id: string,
      operation: () => Promise<T>
    ): Promise<T> {
      assert.equal(id, order);
      assert.equal(locked, false);
      locked = true;
      try {
        return await operation();
      } finally {
        locked = false;
      }
    },

    async loadReservedSnapshot(
      id: string,
      staffUserId: string
    ) {
      assert.equal(locked, true);
      assert.equal(id, order);
      assert.equal(staffUserId, "7");

      loads++;

      if (options.denied) {
        throw new Error("NOT_ASSIGNED_TO_DRIVER");
      }

      const selectedLines = options.wrongQuantity
        ? [{...lines[0], quantity: 99}]
        : lines;

      return {
        shopifyOrderId: options.wrongOrder
          ? "gid://shopify/Order/999"
          : order,
        selectionHash,
        selectionState: "PREPARED",
        manifest: [{
          fulfillmentOrderId: fulfillmentOrder,
          fulfillmentOrderLineItems: lines,
        }],
        journal: [{
          fulfillmentOrderId: fulfillmentOrder,
          selectionHash,
          payloadHash,
          fulfillmentLines: selectedLines,
          state: state as
            "PREPARED" | "CONFIRMED",
          shopifyFulfillmentId:
            options.confirmed
              ? "gid://shopify/Fulfillment/555"
              : null,
        }],
      };
    },

    db: {
      async query(sql: string) {
        assert.equal(locked, true);
        const q = sql.trim();

        if (
          q === "BEGIN" ||
          q === "COMMIT" ||
          q === "ROLLBACK"
        ) {
          return {rows: [], rowCount: null};
        }

        if (q.includes("SET state = 'DISPATCHING'")) {
          if (state !== "PREPARED") {
            return {rows: [], rowCount: 0};
          }
          state = "DISPATCHING";
          return {rows: [{}], rowCount: 1};
        }

        if (
          q.includes("SET state = 'RECONCILE_REQUIRED'")
        ) {
          state = "RECONCILE_REQUIRED";
          return {rows: [{}], rowCount: 1};
        }

        if (q.includes("SET state = 'CONFIRMED'")) {
          state = "CONFIRMED";
          return {rows: [{}], rowCount: 1};
        }

        throw new Error("UNEXPECTED_MOCK_QUERY");
      },
    },

    async createFulfillment(input: {
      fulfillmentOrderId: string;
      fulfillmentOrderLineItems:
        Array<{id: string; quantity: number}>;
    }) {
      assert.equal(locked, true);
      assert.equal(
        input.fulfillmentOrderId,
        fulfillmentOrder
      );
      assert.deepEqual(
        input.fulfillmentOrderLineItems,
        lines
      );

      mutations++;

      if (options.timeout) {
        throw new Error("SIMULATED_TIMEOUT");
      }

      return {
        id: "gid://shopify/Fulfillment/555",
        status: "SUCCESS",
      };
    },
  };

  return {
    dependencies,
    mutations: () => mutations,
    loads: () => loads,
    state: () => state,
    locked: () => locked,
  };
}

const request = {
  shopifyOrderId: order,
  staffUserId: "7",
};

test("Gültige Reservierung: ein Fulfillment", async () => {
  const h = makeHarness();
  const result = await executePartialDispatchV1642(
    request, h.dependencies
  );

  assert.equal(result.mode, "DISPATCHED");
  assert.equal(result.dispatchedCount, 1);
  assert.equal(h.mutations(), 1);
  assert.equal(h.loads(), 1);
  assert.equal(h.state(), "CONFIRMED");
  assert.equal(h.locked(), false);
});

test("Bereits bestätigt: kein erneutes Shopify", async () => {
  const h = makeHarness({confirmed: true});
  const result = await executePartialDispatchV1642(
    request, h.dependencies
  );
  assert.equal(result.mode, "ALREADY_CONFIRMED");
  assert.equal(h.mutations(), 0);
});

test("Falsche Bestellung wird blockiert", async () => {
  const h = makeHarness({wrongOrder: true});
  await assert.rejects(
    executePartialDispatchV1642(request, h.dependencies),
    /DISPATCH_ORDER_MISMATCH/
  );
  assert.equal(h.mutations(), 0);
  assert.equal(h.locked(), false);
});

test("Manipulierte Menge wird blockiert", async () => {
  const h = makeHarness({wrongQuantity: true});
  await assert.rejects(
    executePartialDispatchV1642(request, h.dependencies),
    /JOURNAL_LINES_CHANGED/
  );
  assert.equal(h.mutations(), 0);
});

test("Nicht berechtigter Fahrer wird blockiert", async () => {
  const h = makeHarness({denied: true});
  await assert.rejects(
    executePartialDispatchV1642(request, h.dependencies),
    /NOT_ASSIGNED_TO_DRIVER/
  );
  assert.equal(h.mutations(), 0);
});

test("Timeout sperrt erneuten Dispatch", async () => {
  const h = makeHarness({timeout: true});

  await assert.rejects(
    executePartialDispatchV1642(request, h.dependencies),
    /SHOPIFY_RESULT_UNCERTAIN_RECONCILIATION_REQUIRED/
  );

  assert.equal(h.state(), "RECONCILE_REQUIRED");
  assert.equal(h.mutations(), 1);
  assert.equal(h.locked(), false);
});

test("Ungültiger Request wird sofort blockiert", async () => {
  const h = makeHarness();

  await assert.rejects(
    executePartialDispatchV1642({
      shopifyOrderId: order,
      staffUserId: "INVALID",
    }, h.dependencies),
    /INVALID_PARTIAL_DISPATCH_REQUEST/
  );

  assert.equal(h.loads(), 0);
  assert.equal(h.mutations(), 0);
});

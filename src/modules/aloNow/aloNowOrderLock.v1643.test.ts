import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";

import {
  orderLockKeyV1643,
  withOrderLockV1643,
} from "./aloNowOrderLock.v1643.js";

const order = "gid://shopify/Order/123";

function harness(options: {
  failAcquire?: boolean;
  failUnlock?: boolean;
  negativeUnlock?: boolean;
} = {}) {
  let locked = false;
  let destroyed: boolean | undefined;
  let usedKey = "";
  const events: string[] = [];

  const pool = {
    async connect() {
      events.push("CONNECT");

      return {
        async query(sql: string, params?: unknown[]) {
          if (sql.includes("pg_advisory_unlock")) {
            events.push("UNLOCK");

            if (options.failUnlock) {
              throw new Error("UNLOCK_FAILED");
            }

            locked = false;

            return {
              rows: [{
                released: !options.negativeUnlock,
              }],
              rowCount: 1,
            };
          }

          if (sql.includes("pg_advisory_lock")) {
            events.push("LOCK");

            if (options.failAcquire) {
              throw new Error("ACQUIRE_FAILED");
            }

            usedKey = String(params?.[0]);
            locked = true;

            return {
              rows: [{}],
              rowCount: 1,
            };
          }

          throw new Error("UNEXPECTED_SQL");
        },

        release(destroy?: boolean) {
          events.push("RELEASE");
          destroyed = destroy;
        },
      };
    },
  };

  return {
    pool,
    events,
    locked: () => locked,
    destroyed: () => destroyed,
    usedKey: () => usedKey,
  };
}

test("Schlüssel entspricht dem bestehenden Algorithmus", () => {
  const expected = createHash("sha256")
    .update("ALO_NOW_DELIVERY_COMPLETION_V1:")
    .update(order)
    .digest()
    .readBigInt64BE(0)
    .toString();

  assert.equal(orderLockKeyV1643(order), expected);
});

test("Lock umfasst die gesamte Operation", async () => {
  const h = harness();

  const result = await withOrderLockV1643(
    order,
    h.pool,
    async () => {
      assert.equal(h.locked(), true);
      h.events.push("OPERATION");
      return 42;
    }
  );

  assert.equal(result, 42);
  assert.equal(h.usedKey(), orderLockKeyV1643(order));
  assert.deepEqual(h.events, [
    "CONNECT",
    "LOCK",
    "OPERATION",
    "UNLOCK",
    "RELEASE",
  ]);
  assert.equal(h.destroyed(), false);
});

test("Operationsfehler gibt die Sperre frei", async () => {
  const h = harness();

  await assert.rejects(
    withOrderLockV1643(order, h.pool, async () => {
      throw new Error("OPERATION_FAILED");
    }),
    /OPERATION_FAILED/
  );

  assert.equal(h.locked(), false);
  assert.equal(h.destroyed(), false);
});

test("Fehler beim Lock-Abruf verhindert die Operation", async () => {
  const h = harness({failAcquire: true});
  let called = false;

  await assert.rejects(
    withOrderLockV1643(order, h.pool, async () => {
      called = true;
    }),
    /ACQUIRE_FAILED/
  );

  assert.equal(called, false);
  assert.equal(h.destroyed(), true);
});

test("Unlock-Fehler zerstört die Verbindung", async () => {
  const h = harness({failUnlock: true});

  await assert.rejects(
    withOrderLockV1643(order, h.pool, async () => 1),
    /ALO_NOW_ORDER_LOCK_RELEASE_UNCERTAIN/
  );

  assert.equal(h.destroyed(), true);
});

test("Negatives Unlock-Ergebnis zerstört Verbindung", async () => {
  const h = harness({negativeUnlock: true});

  await assert.rejects(
    withOrderLockV1643(order, h.pool, async () => 1),
    /ALO_NOW_ORDER_LOCK_RELEASE_UNCERTAIN/
  );

  assert.equal(h.destroyed(), true);
});

test("Ungültige Bestellung verbindet sich nicht", async () => {
  const h = harness();

  await assert.rejects(
    withOrderLockV1643(" ", h.pool, async () => 1),
    /INVALID_SHOPIFY_ORDER_ID/
  );

  assert.equal(h.events.length, 0);
});

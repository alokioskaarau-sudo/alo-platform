import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(
  "src/database/aloNowDeliveries.ts",
  "utf8"
);

const start = source.indexOf(
  "export async function claimAloNowDelivery("
);
const end = source.indexOf(
  "export type CompleteAloNowDeliveryResult",
  start
);

assert.ok(start >= 0 && end > start);

const functionSource = source
  .slice(start, end)
  .replace(
    /export async function claimAloNowDelivery\([\s\S]*?\): Promise<ClaimAloNowDeliveryResult> \{/,
    "async function claimAloNowDelivery(shopifyOrderId, staffUserId) {"
  )
  .replace(/client\.query<[\s\S]*?>\(/g, "client.query(");

const makeDb = ({
  driverOnline = true,
  heartbeatFresh = true,
  assigned = false,
  activeCount = 0,
} = {}) => {
  const queries = [];

  const delivery = {
    shopify_order_id: "TEST_ORDER",
    fulfillment_workspace: "AARAU",
    delivery_status: assigned
      ? "DRIVER_ASSIGNED"
      : "WAITING_FOR_DRIVER",
    assigned_driver_user_id: assigned
      ? "OTHER_DRIVER"
      : null,
  };

  const client = {
    async query(sql) {
      const q = String(sql).trim();
      queries.push(q);

      if (q === "BEGIN" || q === "COMMIT" || q === "ROLLBACK")
        return { rows: [] };

      if (q.includes("FROM alo_driver_profiles") &&
          q.includes("FOR UPDATE"))
        return {
          rows: [{
            staff_user_id: "DRIVER_1",
            approved: true,
            availability_status: driverOnline
              ? "ONLINE" : "OFFLINE",
            heartbeat_fresh: heartbeatFresh,
            home_workspace: "AARAU",
            max_active_deliveries: 2,
          }],
        };

      if (q.includes("FROM alo_now_deliveries") &&
          q.includes("FOR UPDATE"))
        return { rows: [delivery] };

      if (q.includes("COUNT(*)"))
        return { rows: [{ active_count: activeCount }] };

      if (q.includes("UPDATE alo_now_deliveries"))
        return {
          rows: [{
            ...delivery,
            delivery_status: "DRIVER_ASSIGNED",
            assigned_driver_user_id: "DRIVER_1",
          }],
        };

      return { rows: [] };
    },
    release() {},
  };

  return {
    db: { async connect() { return client; } },
    queries,
  };
};

function loadClaim(db) {
  const context = vm.createContext({ db });
  vm.runInContext(functionSource, context);
  return context.claimAloNowDelivery;
}

test("Online-Fahrer übernimmt Auftrag", async () => {
  const env = makeDb();
  const result = await loadClaim(env.db)(
    "TEST_ORDER", "DRIVER_1"
  );
  assert.equal(result.ok, true);
  assert.ok(env.queries.includes("COMMIT"));
});

test("Offline-Fahrer wird abgewiesen", async () => {
  const env = makeDb({ driverOnline: false });
  const result = await loadClaim(env.db)(
    "TEST_ORDER", "DRIVER_1"
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "DRIVER_NOT_AVAILABLE");
});

test("Abgelaufener Heartbeat wird abgewiesen", async () => {
  const env = makeDb({ heartbeatFresh: false });
  const result = await loadClaim(env.db)(
    "TEST_ORDER", "DRIVER_1"
  );
  assert.equal(result.ok, false);
});

test("Bereits vergebener Auftrag wird abgewiesen", async () => {
  const env = makeDb({ assigned: true });
  const result = await loadClaim(env.db)(
    "TEST_ORDER", "DRIVER_1"
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "ALREADY_ASSIGNED");
});

test("Volle Fahrerkapazität wird abgewiesen", async () => {
  const env = makeDb({ activeCount: 2 });
  const result = await loadClaim(env.db)(
    "TEST_ORDER", "DRIVER_1"
  );
  assert.equal(result.ok, false);
});

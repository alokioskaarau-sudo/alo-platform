
import test from "node:test";
import assert from "node:assert/strict";
import {
  inspectWalletDbEvidenceV1689
} from "./aloNowWalletDbPreflight.v1689.js";

const scope = {
  driverUserId: "101",
  workspace: "AARAU" as const,
  orderId: "gid://shopify/Order/101"
};

function fixture() {
  return {
    shopify_order_id: scope.orderId,
    fulfillment_workspace: "AARAU",
    driver_user_id: "101",
    delivery_status: "DELIVERED",
    delivered_at: "2026-11-04T12:00:00Z",
    cancelled_at: null,
    handoff_count: "1",
    handoff_state: "FULL_HANDOFF",
    settlement_state: "COMPLETED",
    handoff_driver_id: "101",
    payment_count: "1",
    payment_method: "CARD",
    open_reconciliations: "0",
    commission_count: "1",
    online_tip_count: "1",
    wrong_finance_count: "0"
  };
}

async function run(rows: Record<string, unknown>[]) {
  return inspectWalletDbEvidenceV1689(
    async (sql, params) => {
      assert.match(sql, /^\s*SELECT\b/i);
      assert.match(sql, /assigned_driver_user_id::text=\$2/i);
      assert.match(sql, /fulfillment_workspace=\$3/i);
      assert.deepEqual(params, [
        scope.orderId, "101", "AARAU"
      ]);
      return { rows };
    },
    scope
  );
}

test("complete database evidence still requires Shopify", async () => {
  const r = await run([fixture()]);
  assert.equal(r.status, "AWAITING_PROVIDER_VERIFICATION");
  assert.equal(r.providerConfirmed, false);
  assert.equal(r.sourceVerified, false);
  assert.equal(r.payableOutstandingRappen, null);
  assert.equal(r.payoutEnabled, false);
});

test("missing delivery blocks", async () => {
  assert.equal((await run([])).status, "BLOCKED");
});

test("duplicate delivery blocks", async () => {
  assert.equal(
    (await run([fixture(), fixture()])).status,
    "BLOCKED"
  );
});

test("wrong driver blocks", async () => {
  const row = fixture();
  row.driver_user_id = "202";
  assert.equal((await run([row])).status, "BLOCKED");
});

test("unfinished delivery blocks", async () => {
  const row = fixture();
  row.delivery_status = "ON_THE_WAY";
  assert.equal((await run([row])).status, "BLOCKED");
});

test("missing handoff blocks", async () => {
  const row = fixture();
  row.handoff_count = "0";
  assert.equal((await run([row])).status, "BLOCKED");
});

test("open reconciliation blocks", async () => {
  const row = fixture();
  row.open_reconciliations = "1";
  assert.equal((await run([row])).status, "BLOCKED");
});

test("duplicate commission blocks", async () => {
  const row = fixture();
  row.commission_count = "2";
  assert.equal((await run([row])).status, "BLOCKED");
});

test("wrong finance owner blocks", async () => {
  const row = fixture();
  row.wrong_finance_count = "1";
  assert.equal((await run([row])).status, "BLOCKED");
});

test("database outage fails closed", async () => {
  const r = await inspectWalletDbEvidenceV1689(
    async () => { throw new Error("DB_UNAVAILABLE"); },
    scope
  );
  assert.equal(r.status, "BLOCKED");
  assert.equal(r.dbEvidenceChecked, false);
  assert.equal(r.payableOutstandingRappen, null);
});

test("invalid driver scope rejected before query", async () => {
  await assert.rejects(
    inspectWalletDbEvidenceV1689(
      async () => { throw new Error("MUST_NOT_QUERY"); },
      { ...scope, driverUserId: "invalid" }
    ),
    /INVALID_WALLET_SCOPE/
  );
});

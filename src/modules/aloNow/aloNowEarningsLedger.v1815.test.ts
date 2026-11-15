import test from "node:test";
import assert from "node:assert/strict";

import {
  readEarningsLedgerV1815
} from "./aloNowEarningsLedger.v1815.js";

const scope = {
  orderId: "gid://shopify/Order/12345",
  driverUserId: "101",
  workspace: "AARAU" as const
};

function commission() {
  return {
    event_key: "ALO-COMMISSION:12345",
    event_type: "COMMISSION_EARNED",
    driver_user_id: "101",
    workspace: "AARAU",
    order_id: scope.orderId,
    amount_rappen: "450",
    source_reference: "verified-booking-reference"
  };
}

function tip() {
  return {
    ...commission(),
    event_key: "ALO-ONLINE-TIP:12345",
    event_type: "ONLINE_TIP_EARNED",
    amount_rappen: "150"
  };
}

const run = (rows: ReturnType<typeof commission>[]) =>
  readEarningsLedgerV1815(
    scope, async () => ({ rows })
  );

test("V1815: vorhandene Buchungen bleiben unverifiziert", async () => {
  const r = await run([commission(), tip()]);
  assert.equal(r.status, "BOOKINGS_PRESENT_UNVERIFIED");
  assert.equal(r.commissionCount, 1);
  assert.equal(r.tipCount, 1);
  assert.equal(r.sourceVerified, false);
  assert.equal(r.earningsAuthorized, false);
  assert.equal(r.payoutEnabled, false);
});

test("V1815: fehlende Buchung", async () => {
  assert.equal((await run([])).status, "PENDING_BOOKING");
});

test("V1815: Provision ohne Trinkgeld", async () => {
  assert.equal(
    (await run([commission()])).status,
    "BOOKINGS_PRESENT_UNVERIFIED"
  );
});

test("V1815: doppelte Provision gesperrt", async () => {
  const second = {
    ...commission(),
    event_key: "OTHER-COMMISSION"
  };
  assert.equal(
    (await run([commission(), second])).status,
    "BLOCKED"
  );
});

test("V1815: falscher Fahrer gesperrt", async () => {
  assert.equal(
    (await run([{...commission(), driver_user_id: "999"}])).status,
    "BLOCKED"
  );
});

test("V1815: falscher Standort gesperrt", async () => {
  assert.equal(
    (await run([{...commission(), workspace: "OLTEN"}])).status,
    "BLOCKED"
  );
});

test("V1815: ungültiger Betrag gesperrt", async () => {
  assert.equal(
    (await run([{...commission(), amount_rappen: "-50"}])).status,
    "BLOCKED"
  );
});

test("V1815: fehlende Referenz gesperrt", async () => {
  assert.equal(
    (await run([{...commission(), source_reference: ""}])).status,
    "BLOCKED"
  );
});

test("V1815: doppelte Ereignisse gesperrt", async () => {
  assert.equal(
    (await run([commission(), tip(), tip()])).status,
    "BLOCKED"
  );
});

test("V1815: nur Trinkgeld ist keine Provision", async () => {
  assert.equal((await run([tip()])).status, "BLOCKED");
});

test("V1815: Datenbankausfall blockiert", async () => {
  const r = await readEarningsLedgerV1815(
    scope,
    async () => { throw new Error("DB_OFFLINE"); }
  );
  assert.equal(r.status, "BLOCKED");
});

test("V1815: falsche Order-ID vor DB gesperrt", async () => {
  let called = false;
  const r = await readEarningsLedgerV1815(
    {...scope, orderId: "invalid"},
    async () => {
      called = true;
      return { rows: [] };
    }
  );
  assert.equal(r.status, "BLOCKED");
  assert.equal(called, false);
});

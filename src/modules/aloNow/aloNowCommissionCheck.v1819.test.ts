import test from "node:test";
import assert from "node:assert/strict";

import {
  checkCommissionV1819
} from "./aloNowCommissionCheck.v1819.js";

import type {
  CommissionCheckInputV1819
} from "./aloNowCommissionCheck.v1819.js";

function fixture(): CommissionCheckInputV1819 {
  // All numbers are synthetic test fixtures, NOT ALO tariffs.
  return {
    orderId: "gid://shopify/Order/12345",
    driverUserId: "101",
    workspace: "AARAU",
    tariffVersion: "TEST-ONLY-V1",
    tariffEffectiveFrom: "2026-11-01T00:00:00.000Z",
    deliveryCompletedAt: "2026-11-07T12:00:00.000Z",
    distanceMetres: 2500,
    baseRappen: 200,
    rappenPerKm: 100,
    capRappen: 700,
    bookedCommissionRappen: 450
  };
}

function denied(x: CommissionCheckInputV1819) {
  const r = checkCommissionV1819(x);
  assert.equal(r.status, "BLOCKED");
  assert.equal(r.earningsAuthorized, false);
  assert.equal(r.payoutEnabled, false);
}

test("V1819: matching arithmetic never releases money", () => {
  const r = checkCommissionV1819(fixture());
  assert.equal(
    r.status,
    "MATCHED_SOURCE_VERIFICATION_PENDING"
  );
  assert.equal(r.arithmeticMatched, true);
  assert.equal(r.sourceVerified, false);
  assert.equal(r.earningsAuthorized, false);
  assert.equal(r.payoutEnabled, false);
  assert.equal(r.payableOutstandingRappen, null);
});

test("V1819: booked amount mismatch blocked", () => {
  denied({...fixture(), bookedCommissionRappen: 451});
});

test("V1819: old tariff invalid for completed delivery", () => {
  denied({
    ...fixture(),
    tariffEffectiveFrom: "2026-11-08T00:00:00.000Z"
  });
});

test("V1819: missing tariff version blocked", () => {
  denied({...fixture(), tariffVersion: ""});
});

test("V1819: invalid date blocked", () => {
  denied({...fixture(), deliveryCompletedAt: "not-a-date"});
});

test("V1819: wrong order format blocked", () => {
  denied({...fixture(), orderId: "12345"});
});

test("V1819: zero distance blocked", () => {
  denied({...fixture(), distanceMetres: 0});
});

test("V1819: zero booking blocked", () => {
  denied({...fixture(), bookedCommissionRappen: 0});
});

test("V1819: capped commission matches", () => {
  const r = checkCommissionV1819({
    ...fixture(),
    capRappen: 300,
    bookedCommissionRappen: 300
  });
  assert.equal(
    r.status,
    "MATCHED_SOURCE_VERIFICATION_PENDING"
  );
});

test("V1819: wrong cap blocks mismatch", () => {
  denied({
    ...fixture(),
    capRappen: 300,
    bookedCommissionRappen: 450
  });
});

test("V1819: invalid driver blocked", () => {
  denied({...fixture(), driverUserId: "someone"});
});

test("V1819: unsafe money amount blocked", () => {
  denied({
    ...fixture(),
    bookedCommissionRappen: Number.MAX_SAFE_INTEGER + 1
  });
});

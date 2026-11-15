
import assert from "node:assert/strict";
import test from "node:test";

import {
  projectCardWalletEvidenceV1688
} from "./aloNowWalletBridge.v1688.js";

import type {
  EvidenceV1676
} from "./aloNowWalletEvidence.v1676.js";

function fixture(
  orderId = "gid://shopify/Order/101"
): EvidenceV1676 {
  return {
    orderId,
    workspace: "AARAU",
    driverUserId: "101",
    delivery: {
      orderId,
      workspace: "AARAU",
      driverUserId: "101",
      status: "DELIVERED",
      deliveredAt: "2026-11-04T12:00:00Z",
      cancelledAt: null
    },
    payment: {
      orderId,
      method: "CARD",
      providerConfirmed: true,
      reconciliationOpen: false,
      reversedOrRefunded: false
    },
    handoff: {
      orderId,
      driverUserId: "101",
      finalVerified: true,
      settlementFinal: true
    },
    financeEvents: [
      {
        orderId,
        driverUserId: "101",
        workspace: "AARAU",
        type: "COMMISSION_EARNED",
        amountRappen: 350,
        sourceVerified: true
      },
      {
        orderId,
        driverUserId: "101",
        workspace: "AARAU",
        type: "ONLINE_TIP_EARNED",
        amountRappen: 200,
        sourceVerified: true
      }
    ],
    orderRappen: 2500,
    orderTotalVerified: true
  };
}

function project(items: EvidenceV1676[]) {
  return projectCardWalletEvidenceV1688(
    "101",
    "AARAU",
    items
  );
}

test("positive evidence produces diagnostic values only", () => {
  const r = project([fixture()]);

  assert.equal(r.status, "DIAGNOSTIC_ONLY");
  assert.equal(r.acceptedReceipts, 1);
  assert.equal(r.diagnosticCardCommissionRappen, 350);
  assert.equal(r.diagnosticCardTipsRappen, 200);
  assert.equal(r.payableOutstandingRappen, null);
  assert.equal(r.payoutEnabled, false);
  assert.equal(r.sourceVerificationPerformed, false);
});

test("empty sources never invent money", () => {
  const r = project([]);

  assert.equal(r.status, "EMPTY");
  assert.equal(r.diagnosticCardCommissionRappen, null);
  assert.equal(r.payableOutstandingRappen, null);
});

test("unverified payment blocks all monetary diagnostics", () => {
  const bad = fixture();
  bad.payment.providerConfirmed = false;

  const r = project([bad]);

  assert.equal(r.status, "BLOCKED");
  assert.equal(r.diagnosticCardCommissionRappen, null);
  assert.equal(r.payableOutstandingRappen, null);
});

test("duplicate order cannot be counted twice", () => {
  const r = project([fixture(), fixture()]);

  assert.equal(r.status, "BLOCKED");
  assert.ok(
    r.blockedReasons.includes("DUPLICATE_OR_INVALID_ORDER")
  );
  assert.equal(r.diagnosticCardTipsRappen, null);
});

test("wrong driver or workspace is blocked", () => {
  const bad = fixture();
  bad.driverUserId = "202";

  const r = project([bad]);

  assert.equal(r.status, "BLOCKED");
  assert.ok(
    r.blockedReasons.includes("DRIVER_OR_WORKSPACE_MISMATCH")
  );
});

test("blocked second order prevents partial balance", () => {
  const second = fixture("gid://shopify/Order/102");
  second.payment.reversedOrRefunded = true;

  const r = project([fixture(), second]);

  assert.equal(r.status, "BLOCKED");
  assert.equal(r.acceptedReceipts, 1);
  assert.equal(r.diagnosticCardCommissionRappen, null);
  assert.equal(r.payableOutstandingRappen, null);
});

test("cash tip is not treated as an online tip", () => {
  const bad = fixture();
  bad.financeEvents[1].type = "CASH_TIP_COLLECTED";

  const r = project([bad]);

  assert.equal(r.status, "BLOCKED");
  assert.equal(r.diagnosticCardTipsRappen, null);
});

test("two distinct verified inputs aggregate in diagnostics", () => {
  const r = project([
    fixture("gid://shopify/Order/101"),
    fixture("gid://shopify/Order/102")
  ]);

  assert.equal(r.status, "DIAGNOSTIC_ONLY");
  assert.equal(r.diagnosticCardCommissionRappen, 700);
  assert.equal(r.diagnosticCardTipsRappen, 400);
  assert.equal(r.payableOutstandingRappen, null);
  assert.equal(r.payoutEnabled, false);
});

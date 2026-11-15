
import test from "node:test";
import assert from "node:assert/strict";

import {
  quoteDriverWalletV961
} from "./aloNowDriverWallet.v961.js";

import {
  planAdminPayoutV1665
} from "./aloNowPayoutPlan.v1665.js";

import type {
  PayoutContextV1665,
  PayoutRequestV1665
} from "./aloNowPayoutPlan.v1665.js";

const wallet = quoteDriverWalletV961({
  receipts: [
    {
      orderId: "cash-1",
      payment: "CASH",
      orderRappen: 5000,
      commissionRappen: 600,
      cardTipRappen: 0,
      reportedCashTipRappen: 300
    },
    {
      orderId: "card-1",
      payment: "CARD",
      orderRappen: 4500,
      commissionRappen: 800,
      cardTipRappen: 400
    }
  ],
  openingFloatRappen: 5000,
  confirmedEnvelopeRappen: 4400,
  confirmedPayoutRappen: 0
});

const context: PayoutContextV1665 = {
  adminUserId: "admin-1",
  adminActive: true,
  adminApproved: true,
  adminRole: "ADMIN",
  allowedWorkspaces: ["AARAU"],
  workspace: "AARAU",
  driverUserId: "driver-1",
  driverWorkspace: "AARAU",
  payoutShiftId: "shift-1",
  payoutShiftWorkspace: "AARAU",
  payoutShiftOpen: true,
  availableCashRappen: 10000,
  verifiedSources: true,
  reconciliationComplete: true,
  priorPaidCardCommissionRappen: 0,
  priorPaidCardTipsRappen: 0,
  priorPaidCashCarryoverRappen: 0,
  existingPayoutKeys: []
};

const request: PayoutRequestV1665 = {
  amountRappen: 1200,
  payoutKey: "payout-test-0001"
};

function run(
  overrides: Partial<PayoutContextV1665> = {},
  req: PayoutRequestV1665 = request
) {
  return planAdminPayoutV1665(
    wallet,
    {...context, ...overrides},
    req
  );
}

test("Volle Kartenauszahlung korrekt", () => {
  const p = run();
  assert.equal(p.cardTipRappen, 400);
  assert.equal(p.cardCommissionRappen, 800);
  assert.equal(p.cashCarryoverRappen, 0);
  assert.equal(p.balanceAfterRappen, 0);
  assert.equal(p.status, "PLAN_ONLY_NOT_BOOKED");
});

test("Teilauszahlung nur aus Kartentrinkgeld", () => {
  const p = run({}, {...request, amountRappen: 250});
  assert.equal(p.cardTipRappen, 250);
  assert.equal(p.cardCommissionRappen, 0);
  assert.equal(p.balanceAfterRappen, 950);
});

test("Doppelte Referenz gesperrt", () => {
  assert.throws(
    () => run({existingPayoutKeys: [request.payoutKey]}),
    /DUPLICATE_PAYOUT_KEY/
  );
});

test("Fremder Standort gesperrt", () => {
  assert.throws(
    () => run({driverWorkspace: "OLTEN"}),
    /PAYOUT_WORKSPACE_MISMATCH/
  );
});

test("Fahrer als Admin gesperrt", () => {
  assert.throws(
    () => run({adminRole: "DRIVER"}),
    /PAYOUT_ADMIN_REQUIRED/
  );
});

test("Selbstauszahlung gesperrt", () => {
  assert.throws(
    () => run({adminUserId: "driver-1"}),
    /PAYOUT_ADMIN_REQUIRED/
  );
});

test("Ungeprüfte Quellen gesperrt", () => {
  assert.throws(
    () => run({verifiedSources: false}),
    /PAYOUT_EVIDENCE_NOT_VERIFIED/
  );
});

test("Ungeklärte Abrechnung gesperrt", () => {
  assert.throws(
    () => run({reconciliationComplete: false}),
    /PAYOUT_EVIDENCE_NOT_VERIFIED/
  );
});

test("Geschlossene Schicht gesperrt", () => {
  assert.throws(
    () => run({payoutShiftOpen: false}),
    /PAYOUT_SHIFT_NOT_OPEN/
  );
});

test("Zu wenig Bargeld gesperrt", () => {
  assert.throws(
    () => run({availableCashRappen: 100}),
    /PAYOUT_CASH_INSUFFICIENT/
  );
});

test("Überzahlung gesperrt", () => {
  assert.throws(
    () => run({}, {...request, amountRappen: 1201}),
    /PAYOUT_EXCEEDS_BALANCE/
  );
});

test("Falsche Auszahlungshistorie gesperrt", () => {
  assert.throws(
    () => run({priorPaidCardTipsRappen: 100}),
    /PAYOUT_HISTORY_MISMATCH/
  );
});

test("Nullbetrag gesperrt", () => {
  assert.throws(
    () => run({}, {...request, amountRappen: 0}),
    /ZERO_PAYOUT_FORBIDDEN/
  );
});

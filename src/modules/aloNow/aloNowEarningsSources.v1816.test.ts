import test from "node:test";
import assert from "node:assert/strict";

import {
  combineEarningsSourcesV1816
} from "./aloNowEarningsSources.v1816.js";

import type {
  OnlineEvidenceV1810
} from "./aloNowOnlinePaymentEvidence.v1810.js";

import type {
  LedgerResultV1815
} from "./aloNowEarningsLedger.v1815.js";

const payment: OnlineEvidenceV1810 = {
  status: "MATCHED_REFUND_CHECK_PENDING",
  shopifyPaymentMatched: true,
  refundVerificationCompleted: false,
  earningsAuthorized: false,
  payoutEnabled: false
};

const ledger: LedgerResultV1815 = {
  status: "BOOKINGS_PRESENT_UNVERIFIED",
  commissionCount: 1,
  tipCount: 1,
  sourceVerified: false,
  earningsAuthorized: false,
  payoutEnabled: false
};

function assertNoMoney(
  value: ReturnType<typeof combineEarningsSourcesV1816>
) {
  assert.equal(value.commissionRappen, null);
  assert.equal(value.tipRappen, null);
  assert.equal(value.sourceVerified, false);
  assert.equal(value.earningsAuthorized, false);
  assert.equal(value.payoutEnabled, false);
}

test("V1816: beide Quellen vorhanden, keine Finanzfreigabe", () => {
  const r = combineEarningsSourcesV1816(payment, ledger);
  assert.equal(r.status, "AWAITING_FINAL_VERIFICATION");
  assert.equal(r.paymentMatched, true);
  assert.equal(r.bookingPresent, true);
  assertNoMoney(r);
});

test("V1816: fehlende Provisionsbuchung", () => {
  const r = combineEarningsSourcesV1816(payment, {
    ...ledger,
    status: "PENDING_BOOKING",
    commissionCount: 0,
    tipCount: 0
  });
  assert.equal(r.status, "AWAITING_BOOKING");
  assertNoMoney(r);
});

test("V1816: blockierte Zahlung blockiert Gesamtprüfung", () => {
  const r = combineEarningsSourcesV1816({
    ...payment,
    status: "BLOCKED",
    shopifyPaymentMatched: false
  }, ledger);
  assert.equal(r.status, "BLOCKED");
  assertNoMoney(r);
});

test("V1816: fehlerhaftes Ledger blockiert", () => {
  const r = combineEarningsSourcesV1816(payment, {
    ...ledger,
    status: "BLOCKED"
  });
  assert.equal(r.status, "BLOCKED");
  assertNoMoney(r);
});

test("V1816: doppelte Provision nicht akzeptiert", () => {
  const r = combineEarningsSourcesV1816(payment, {
    ...ledger,
    commissionCount: 2
  });
  assert.equal(r.status, "BLOCKED");
  assertNoMoney(r);
});

test("V1816: fehlender Zahlungsnachweis blockiert", () => {
  const r = combineEarningsSourcesV1816({
    ...payment,
    shopifyPaymentMatched: false
  }, ledger);
  assert.equal(r.status, "BLOCKED");
  assertNoMoney(r);
});

test("V1816: keine Provision ohne Trinkgeld ist möglich", () => {
  const r = combineEarningsSourcesV1816(payment, {
    ...ledger,
    tipCount: 0
  });
  assert.equal(r.status, "AWAITING_FINAL_VERIFICATION");
  assertNoMoney(r);
});

test("V1817B: widersprüchlicher Buchungsstatus blockiert", () => {
  const r = combineEarningsSourcesV1816(payment, {
    ...ledger,
    status: "PENDING_BOOKING",
    commissionCount: 1
  });
  assert.equal(r.status, "BLOCKED");
  assertNoMoney(r);
});

test("V1817B: wartende Buchung mit Trinkgeld blockiert", () => {
  const r = combineEarningsSourcesV1816(payment, {
    ...ledger,
    status: "PENDING_BOOKING",
    commissionCount: 0,
    tipCount: 1
  });
  assert.equal(r.status, "BLOCKED");
  assertNoMoney(r);
});

test("V1817B: unerlaubte Finanzfreigabe blockiert", () => {
  // Ausschliesslich ein absichtlich fehlerhafter Testwert.
  // Keine Änderung am Finanzdatentyp oder Produktionscode.
  const unsafe = {
    ...ledger,
    earningsAuthorized: true
  } as unknown as typeof ledger;

  const r = combineEarningsSourcesV1816(payment, unsafe);
  assert.equal(r.status, "BLOCKED");
  assertNoMoney(r);
});

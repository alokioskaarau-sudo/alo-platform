import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateEarningsPresentationV1808
} from "./aloNowEarningsGate.v1808.js";

import type {
  IndependentAttestationV1808
} from "./aloNowEarningsGate.v1808.js";

import type {
  EvidenceV1676
} from "./aloNowWalletEvidence.v1676.js";

function fixture() {
  const evidence: EvidenceV1676 = {
    orderId: "ORDER-TEST-1808",
    driverUserId: "101",
    workspace: "AARAU",
    delivery: {
      orderId: "ORDER-TEST-1808",
      driverUserId: "101",
      workspace: "AARAU",
      status: "DELIVERED",
      deliveredAt: "2026-11-07T10:00:00Z",
      cancelledAt: null
    },
    payment: {
      orderId: "ORDER-TEST-1808",
      method: "CARD",
      providerConfirmed: true,
      reconciliationOpen: false,
      reversedOrRefunded: false
    },
    handoff: {
      orderId: "ORDER-TEST-1808",
      driverUserId: "101",
      finalVerified: true,
      settlementFinal: true
    },
    financeEvents: [
      {
        orderId: "ORDER-TEST-1808",
        driverUserId: "101",
        workspace: "AARAU",
        type: "COMMISSION_EARNED",
        amountRappen: 400,
        sourceVerified: true
      },
      {
        orderId: "ORDER-TEST-1808",
        driverUserId: "101",
        workspace: "AARAU",
        type: "ONLINE_TIP_EARNED",
        amountRappen: 150,
        sourceVerified: true
      }
    ],
    orderRappen: 3500,
    orderTotalVerified: true
  };

  const attestation: IndependentAttestationV1808 = {
    orderId: "ORDER-TEST-1808",
    driverUserId: "101",
    workspace: "AARAU",
    providerPaymentChecked: true,
    refundsAndReversalsChecked: true,
    financeEventOriginsChecked: true,
    commissionBookingChecked: true,
    finalHandoffChecked: true
  };

  return {evidence, attestation};
}

function blocked(
  evidence: EvidenceV1676,
  attestation: IndependentAttestationV1808 | null
) {
  const result = evaluateEarningsPresentationV1808(
    evidence,
    attestation
  );
  assert.equal(result.status, "PENDING_VERIFICATION");
  assert.equal(result.commissionRappen, null);
  assert.equal(result.tipRappen, null);
  assert.equal(result.verified, false);
}

test("V1808: vollständig attestierte Testdaten", () => {
  const x = fixture();
  assert.deepEqual(
    evaluateEarningsPresentationV1808(
      x.evidence, x.attestation
    ),
    {
      status: "DISPLAY_READY",
      commissionRappen: 400,
      tipRappen: 150,
      verified: true
    }
  );
});

test("V1808: ohne unabhängige Attestation keine CHF", () => {
  const x = fixture();
  blocked(x.evidence, null);
});

test("V1808: ungeprüfter Zahlungsanbieter gesperrt", () => {
  const x = fixture();
  x.attestation.providerPaymentChecked = false;
  blocked(x.evidence, x.attestation);
});

test("V1808: Rückerstattungsprüfung erforderlich", () => {
  const x = fixture();
  x.attestation.refundsAndReversalsChecked = false;
  blocked(x.evidence, x.attestation);
});

test("V1808: falscher Fahrer gesperrt", () => {
  const x = fixture();
  x.attestation.driverUserId = "999";
  blocked(x.evidence, x.attestation);
});

test("V1808: fremder Standort gesperrt", () => {
  const x = fixture();
  x.attestation.workspace = "OLTEN";
  blocked(x.evidence, x.attestation);
});

test("V1808: fehlende Provisionsbuchung gesperrt", () => {
  const x = fixture();
  x.evidence.financeEvents = [];
  blocked(x.evidence, x.attestation);
});

test("V1808: doppelte Provision gesperrt", () => {
  const x = fixture();
  x.evidence.financeEvents = [
    ...x.evidence.financeEvents,
    x.evidence.financeEvents[0]
  ];
  blocked(x.evidence, x.attestation);
});

test("V1808: nicht zugestellte Bestellung gesperrt", () => {
  const x = fixture();
  x.evidence.delivery.status = "ON_THE_WAY";
  blocked(x.evidence, x.attestation);
});

test("V1808: kein Trinkgeld ist erlaubt", () => {
  const x = fixture();
  x.evidence.financeEvents =
    x.evidence.financeEvents.slice(0, 1);

  const result = evaluateEarningsPresentationV1808(
    x.evidence, x.attestation
  );

  assert.equal(result.status, "DISPLAY_READY");
  assert.equal(result.tipRappen, 0);
});

test("V1808: offene Zahlungsabweichung gesperrt", () => {
  const x = fixture();
  x.evidence.payment.reconciliationOpen = true;
  blocked(x.evidence, x.attestation);
});

test("V1808: nicht attestierte Ereignisquelle gesperrt", () => {
  const x = fixture();
  x.attestation.financeEventOriginsChecked = false;
  blocked(x.evidence, x.attestation);
});

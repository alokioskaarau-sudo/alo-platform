import test from "node:test";
import assert from "node:assert/strict";

import {
  checkOnlinePaymentEvidenceV1810
} from "./aloNowOnlinePaymentEvidence.v1810.js";

const id = "gid://shopify/Order/12345";

function fixture() {
  return {
    order: {
      id,
      cancelledAt: null as string | null | undefined,
      displayFinancialStatus: "PAID",
      totalPriceSet: {
        shopMoney: {
          amount: "35.50",
          currencyCode: "CHF"
        }
      },
      totalRefundedSet: {
        shopMoney: {
          amount: "0.00",
          currencyCode: "CHF"
        }
      },
      totalOutstandingSet: {
        shopMoney: {
          amount: "0.00",
          currencyCode: "CHF"
        }
      }
    },
    states: [
      {
        phase: "PAYMENT_CONFIRMED",
        payment_method: "ONLINE"
      }
    ]
  };
}

function run(x: ReturnType<typeof fixture>) {
  return checkOnlinePaymentEvidenceV1810(id, {
    shopify: async () => x.order,
    paymentStates: async () => x.states
  });
}

test("V1810B: bestätigte Zahlung bleibt ohne Refundfreigabe", async () => {
  const r = await run(fixture());
  assert.equal(r.status, "MATCHED_REFUND_CHECK_PENDING");
  assert.equal(r.shopifyPaymentMatched, true);
  assert.equal(r.refundVerificationCompleted, false);
  assert.equal(r.earningsAuthorized, false);
  assert.equal(r.payoutEnabled, false);
});

test("Unbezahlte Bestellung gesperrt", async () => {
  const x = fixture();
  x.order.displayFinancialStatus = "PENDING";
  assert.equal((await run(x)).status, "BLOCKED");
});

test("Stornierte Bestellung gesperrt", async () => {
  const x = fixture();
  x.order.cancelledAt = "2026-11-07T10:00:00Z";
  assert.equal((await run(x)).status, "BLOCKED");
});

test("Fehlender Stornierungsnachweis gesperrt", async () => {
  const x = fixture();
  x.order.cancelledAt = undefined;
  assert.equal((await run(x)).status, "BLOCKED");
});

test("Offener Zahlbetrag gesperrt", async () => {
  const x = fixture();
  x.order.totalOutstandingSet.shopMoney.amount = "1.00";
  assert.equal((await run(x)).status, "BLOCKED");
});

test("Andere Währung gesperrt", async () => {
  const x = fixture();
  x.order.totalPriceSet.shopMoney.currencyCode = "EUR";
  assert.equal((await run(x)).status, "BLOCKED");
});

test("Bargeld nicht als Onlinezahlung akzeptiert", async () => {
  const x = fixture();
  x.states[0].payment_method = "CASH";
  assert.equal((await run(x)).status, "BLOCKED");
});

test("Doppelte Zahlungszustände gesperrt", async () => {
  const x = fixture();
  x.states.push({...x.states[0]});
  assert.equal((await run(x)).status, "BLOCKED");
});

test("Falsche Shopify-Bestellung gesperrt", async () => {
  const x = fixture();
  x.order.id = "gid://shopify/Order/999";
  assert.equal((await run(x)).status, "BLOCKED");
});

test("Provider-Ausfall sperrt Nachweis", async () => {
  const r = await checkOnlinePaymentEvidenceV1810(id, {
    shopify: async () => {
      throw new Error("OFFLINE");
    },
    paymentStates: async () => fixture().states
  });
  assert.equal(r.status, "BLOCKED");
});

test("Ungültige Bestellreferenz vor Zugriff abgewiesen", async () => {
  let accessed = false;

  const r = await checkOnlinePaymentEvidenceV1810(
    "invalid",
    {
      shopify: async () => {
        accessed = true;
        return fixture().order;
      },
      paymentStates: async () => {
        accessed = true;
        return fixture().states;
      }
    }
  );

  assert.equal(r.status, "BLOCKED");
  assert.equal(accessed, false);
});


test("V1814: Teilrückerstattung blockiert CHF-Nachweis", async () => {
  const x = fixture();
  x.order.totalRefundedSet.shopMoney.amount = "1.50";
  assert.equal((await run(x)).status, "BLOCKED");
});

test("V1814: vollständige Rückerstattung blockiert", async () => {
  const x = fixture();
  x.order.totalRefundedSet.shopMoney.amount = "35.50";
  assert.equal((await run(x)).status, "BLOCKED");
});

test("V1814: Refund in falscher Währung blockiert", async () => {
  const x = fixture();
  x.order.totalRefundedSet.shopMoney.currencyCode = "EUR";
  assert.equal((await run(x)).status, "BLOCKED");
});

test("V1814: fehlender Refund-Nachweis blockiert", async () => {
  const x = fixture();
  const result = await checkOnlinePaymentEvidenceV1810(id, {
    shopify: async () => ({
      ...x.order,
      totalRefundedSet: undefined
    }),
    paymentStates: async () => x.states
  });
  assert.equal(result.status, "BLOCKED");
});

test("V1814: gültige Zahlung bleibt ohne finale Finanzfreigabe", async () => {
  const result = await run(fixture());
  assert.equal(result.shopifyPaymentMatched, true);
  assert.equal(result.refundVerificationCompleted, false);
  assert.equal(result.earningsAuthorized, false);
  assert.equal(result.payoutEnabled, false);
});

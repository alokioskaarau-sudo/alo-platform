import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluatePartialPaymentV1648,
  type PartialPaymentEvidenceV1648,
} from "./aloNowPartialPaymentGuard.v1648.js";

const orderId = "gid://shopify/Order/123";

function fixture(): PartialPaymentEvidenceV1648 {
  return {
    expectedOrderId: orderId,
    shopify: {
      id: orderId,
      cancelledAt: null,
      displayFinancialStatus: "PAID",
      currencyCode: "CHF",
      outstandingRappen: 0,
    },
    paymentRows: [{
      shopifyOrderId: orderId,
      paymentMethod: "ONLINE",
      phase: "PAYMENT_CONFIRMED",
    }],
    packStatus: "PACKED",
    fulfillmentType: "ALO_NOW",
  };
}

function denial(
  data: PartialPaymentEvidenceV1648,
  reason: string
) {
  assert.deepEqual(
    evaluatePartialPaymentV1648(data),
    {allowed: false, reason}
  );
}

test("Verifizierte Onlinezahlung besteht Vorprüfung", () => {
  assert.deepEqual(
    evaluatePartialPaymentV1648(fixture()),
    {
      allowed: true,
      status: "ONLINE_PAYMENT_PRECHECK_PASSED",
    }
  );
});

test("Offene Shopify-Zahlung wird blockiert", () => {
  const x = fixture();
  x.shopify!.displayFinancialStatus = "PENDING";
  denial(x, "ONLINE_PAYMENT_NOT_FULLY_VERIFIED");
});

test("Offener Restbetrag wird blockiert", () => {
  const x = fixture();
  x.shopify!.outstandingRappen = 500;
  denial(x, "ONLINE_PAYMENT_NOT_FULLY_VERIFIED");
});

test("Stornierte Bestellung wird blockiert", () => {
  const x = fixture();
  x.shopify!.cancelledAt = "2026-11-03T12:00:00Z";
  denial(x, "SHOPIFY_ORDER_CANCELLED");
});

test("Doppelte Zahlungsbindung wird blockiert", () => {
  const x = fixture();
  x.paymentRows.push({...x.paymentRows[0]});
  denial(x, "PAYMENT_BINDING_NOT_UNIQUE");
});

test("Falsche Bestellzuordnung wird blockiert", () => {
  const x = fixture();
  x.paymentRows[0].shopifyOrderId =
    "gid://shopify/Order/999";
  denial(x, "PAYMENT_ORDER_MISMATCH");
});

test("Unverpackte Bestellung wird blockiert", () => {
  const x = fixture();
  x.packStatus = "PACKING";
  denial(x, "ORDER_NOT_PACKED");
});

test("CASH_CONFIRMED ist keine Kassierung", () => {
  const x = fixture();
  x.paymentRows[0].paymentMethod = "CASH";
  x.paymentRows[0].phase = "CASH_CONFIRMED";
  x.shopify!.displayFinancialStatus = "PENDING";
  x.shopify!.outstandingRappen = 1200;
  denial(x, "CASH_COLLECTION_EVIDENCE_REQUIRED");
});

test("Unbekannte Zahlungsmethode wird blockiert", () => {
  const x = fixture();
  x.paymentRows[0].paymentMethod = "UNVERIFIED";
  denial(x, "UNKNOWN_PAYMENT_METHOD");
});

test("Falscher Shop-Typ wird blockiert", () => {
  const x = fixture();
  x.fulfillmentType = "SHIPPING";
  denial(x, "NOT_ALO_NOW_ORDER");
});

test("Fremde Shopify-Bestellung wird blockiert", () => {
  const x = fixture();
  x.shopify!.id = "gid://shopify/Order/999";
  denial(x, "SHOPIFY_ORDER_MISMATCH");
});

test("Fremdwährung wird blockiert", () => {
  const x = fixture();
  x.shopify!.currencyCode = "EUR";
  denial(x, "INVALID_SHOPIFY_PAYMENT_AMOUNT");
});


import assert from "node:assert/strict";
import test from "node:test";

import {
  inspectShopifyWalletPaymentV1692
} from "./aloNowWalletShopifyGuard.v1692.js";

import type {
  ShopifyWalletSnapshotV1692
} from "./aloNowWalletShopifyGuard.v1692.js";

const ID = "gid://shopify/Order/101";

function money(amount: string, currencyCode = "CHF") {
  return { shopMoney: { amount, currencyCode } };
}

function fixture(): ShopifyWalletSnapshotV1692 {
  return {
    id: ID,
    displayFinancialStatus: "PAID",
    cancelledAt: null,
    totalPriceSet: money("25.00"),
    totalOutstandingSet: money("0.00"),
    totalRefundedSet: money("0.00")
  };
}

function blocked(
  snapshot: ShopifyWalletSnapshotV1692 | null,
  reason: string
) {
  const decision = inspectShopifyWalletPaymentV1692(
    ID, snapshot
  );

  assert.equal(decision.status, "BLOCKED");
  assert.equal(decision.reason, reason);
  assert.equal(decision.orderTotalRappen, null);
  assert.equal(decision.payoutEnabled, false);
  assert.equal(decision.payableOutstandingRappen, null);
}

test("fully paid and no refunds passes precheck only", () => {
  const r = inspectShopifyWalletPaymentV1692(
    ID, fixture()
  );

  assert.equal(r.status, "PAYMENT_PRECHECK_PASSED");
  assert.equal(r.orderTotalRappen, 2500);
  assert.equal(r.providerSourceAuthenticated, false);
  assert.equal(r.payoutEnabled, false);
  assert.equal(r.payableOutstandingRappen, null);
});

test("wrong Shopify order is blocked", () => {
  const f = fixture();
  f.id = "gid://shopify/Order/202";
  blocked(f, "SHOPIFY_ORDER_ID_MISMATCH");
});

test("unpaid order is blocked", () => {
  const f = fixture();
  f.displayFinancialStatus = "PENDING";
  blocked(f, "SHOPIFY_NOT_FULLY_PAID");
});

test("partially refunded order is blocked", () => {
  const f = fixture();
  f.displayFinancialStatus = "PARTIALLY_REFUNDED";
  f.totalRefundedSet = money("5.00");
  blocked(f, "SHOPIFY_NOT_FULLY_PAID");
});

test("refund is blocked even when status remains PAID", () => {
  const f = fixture();
  f.totalRefundedSet = money("0.01");
  blocked(f, "SHOPIFY_REFUND_DETECTED");
});

test("missing refund evidence fails closed", () => {
  const f = fixture();
  f.totalRefundedSet = undefined as any;
  blocked(f, "INCOMPLETE_SHOPIFY_MONEY_EVIDENCE");
});

test("outstanding amount is blocked", () => {
  const f = fixture();
  f.totalOutstandingSet = money("2.00");
  blocked(f, "SHOPIFY_OUTSTANDING_PAYMENT");
});

test("cancelled order is blocked", () => {
  const f = fixture();
  f.cancelledAt = "2026-11-04T12:00:00Z";
  blocked(f, "SHOPIFY_ORDER_CANCELLED");
});

test("wrong currency is blocked", () => {
  const f = fixture();
  f.totalPriceSet = money("25.00", "EUR");
  blocked(f, "INCOMPLETE_SHOPIFY_MONEY_EVIDENCE");
});

test("malformed money is blocked", () => {
  const f = fixture();
  f.totalRefundedSet = money("invalid");
  blocked(f, "INCOMPLETE_SHOPIFY_MONEY_EVIDENCE");
});

test("missing Shopify snapshot is blocked", () => {
  blocked(null, "SHOPIFY_ORDER_ID_MISMATCH");
});

test("zero-value order is blocked", () => {
  const f = fixture();
  f.totalPriceSet = money("0.00");
  blocked(f, "INCOMPLETE_SHOPIFY_MONEY_EVIDENCE");
});

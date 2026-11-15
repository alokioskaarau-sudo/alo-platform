
import test from "node:test";
import assert from "node:assert/strict";
import {
  createAloNowShopifyAdminPaymentReader
} from "./aloNowShopifyAdminPaymentReader.js";
import {
  inspectShopifyWalletPaymentV1692
} from "./aloNowWalletShopifyGuard.v1692.js";

const ID = "gid://shopify/Order/101";

const money = (amount: string, currencyCode = "CHF") => ({
  shopMoney: { amount, currencyCode }
});

function fixture(refund = "0") {
  return {
    id: ID,
    displayFinancialStatus: "PAID",
    cancelledAt: null,
    totalPriceSet: money("25"),
    totalOutstandingSet: money("0"),
    totalRefundedSet: money(refund)
  };
}

async function read(node: unknown) {
  const reader = createAloNowShopifyAdminPaymentReader(
    async (query, variables) => {
      assert.match(query, /totalRefundedSet\s*\{/);
      assert.deepEqual(variables, { id: ID });
      return { data: { node } };
    }
  );
  return reader(ID);
}

test("paid order without refunds passes diagnostic precheck", async () => {
  const snapshot = await read(fixture());
  assert.ok(snapshot);
  assert.equal(snapshot.totalPriceSet.shopMoney.amount, "25.00");
  assert.equal(snapshot.totalOutstandingSet?.shopMoney.amount, "0.00");
  assert.equal(snapshot.totalRefundedSet?.shopMoney.amount, "0.00");

  const result = inspectShopifyWalletPaymentV1692(
    ID,
    snapshot as NonNullable<
      Parameters<typeof inspectShopifyWalletPaymentV1692>[1]
    >
  );

  assert.equal(result.status, "PAYMENT_PRECHECK_PASSED");
  assert.equal(result.orderTotalRappen, 2500);
  assert.equal(result.payoutEnabled, false);
  assert.equal(result.payableOutstandingRappen, null);
});

test("one Rappen refund blocks wallet", async () => {
  const snapshot = await read(fixture("0.01"));
  assert.ok(snapshot);
  const result = inspectShopifyWalletPaymentV1692(
    ID,
    snapshot as NonNullable<
      Parameters<typeof inspectShopifyWalletPaymentV1692>[1]
    >
  );
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reason, "SHOPIFY_REFUND_DETECTED");
});

test("missing refund field is rejected", async () => {
  const node: Record<string, unknown> = fixture();
  delete node.totalRefundedSet;
  await assert.rejects(
    read(node),
    /SHOPIFY_REFUND_EVIDENCE_INVALID/
  );
});

test("wrong refund currency is rejected", async () => {
  const node = fixture();
  node.totalRefundedSet = money("0", "EUR");
  await assert.rejects(
    read(node),
    /SHOPIFY_REFUND_EVIDENCE_INVALID/
  );
});

test("invalid fractional amount is rejected", async () => {
  await assert.rejects(
    read(fixture("0.001")),
    /SHOPIFY_REFUND_AMOUNT_INVALID/
  );
});

test("refunds normalize to exact Rappen", async () => {
  const snapshot = await read(fixture("3.5"));
  assert.equal(snapshot?.totalRefundedSet?.shopMoney.amount, "3.50");
});

test("GraphQL errors fail closed", async () => {
  const reader = createAloNowShopifyAdminPaymentReader(
    async () => ({ errors: [{ message: "Failure" }] })
  );
  await assert.rejects(reader(ID), /SHOPIFY_GRAPHQL_ERROR/);
});

test("incorrect order ID fails closed", async () => {
  const node = fixture();
  node.id = "gid://shopify/Order/202";
  await assert.rejects(read(node), /SHOPIFY_EVIDENCE_INVALID/);
});

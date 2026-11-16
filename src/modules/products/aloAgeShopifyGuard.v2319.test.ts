import test from "node:test";
import assert from "node:assert/strict";
import {
  requireReviewedAgeV2319, verifyShopifyAgeV2319, syncAndVerifyShopifyAgeV2319
} from "./aloAgeShopifyGuard.v2319.js";

test("V2319 missing review defaults to unrestricted without Shopify write", () => {
  assert.equal(requireReviewedAgeV2319({age_requirement:"NONE",age_requirement_reviewed_at:null}),null);
});
test("V2319 explicit 18 needs reviewed status", () => {
  assert.throws(() => requireReviewedAgeV2319({age_requirement:"AGE_18",age_requirement_reviewed_at:null}), /ALO_AGE_REVIEW_REQUIRED/);
  assert.equal(requireReviewedAgeV2319({age_requirement:"AGE_18",age_requirement_reviewed_at:"2026-11-16"}),"AGE_18");
});
test("V2319 invalid reviewed value blocks sync", () => {
  assert.throws(() => requireReviewedAgeV2319({age_requirement:"something",age_requirement_reviewed_at:"x"}), /ALO_AGE_VALUE_INVALID/);
});
test("V2319 full sync confirms Shopify write and independent read", async () => {
  let calls=0;
  await syncAndVerifyShopifyAgeV2319(async (query, variables) => {
    calls++;
    if(query.includes("metafieldsSet")) {
      assert.equal(variables.metafields[0].value,"AGE_16");
      return {metafieldsSet:{metafields:[{namespace:"alo",key:"age_requirement",value:"AGE_16"}],userErrors:[]}};
    }
    return {product:{id:"gid://shopify/Product/1",ageRequirement:{value:"AGE_16"}}};
  },"gid://shopify/Product/1","AGE_16");
  assert.equal(calls,2);
});
test("V2319 cannot accept Shopify mutation response without metadata", async () => {
  await assert.rejects(syncAndVerifyShopifyAgeV2319(async () => ({metafieldsSet:{userErrors:[]}}),"gid://shopify/Product/1","AGE_18"), /ALO_AGE_SHOPIFY_WRITE_NOT_CONFIRMED/);
});
test("V2319 activation rejects missing or mismatched Shopify age", async () => {
  await assert.rejects(verifyShopifyAgeV2319(async () => ({product:{id:"gid://shopify/Product/1",ageRequirement:null}}),"gid://shopify/Product/1","AGE_18"), /ALO_AGE_SHOPIFY_NOT_VERIFIED/);
});
test("V2319 activation accepts exact match", async () => {
  await verifyShopifyAgeV2319(async () => ({product:{id:"gid://shopify/Product/1",ageRequirement:{value:"AGE_18"}}}),"gid://shopify/Product/1","AGE_18");
});

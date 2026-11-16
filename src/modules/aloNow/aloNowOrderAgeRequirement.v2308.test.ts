import assert from "node:assert/strict";
import { test } from "node:test";
import { getAloNowOrderAgeRequirement } from "./aloNowOrderAgeRequirement.js";

function orderWith(...values: Array<string | null | undefined>) {
  return {
    lineItems: {
      edges: values.map((value, index) => ({ node: {
        id: `gid://shopify/LineItem/${index + 1}`,
        name: `Test ${index + 1}`,
        variant: { product: { id: `gid://shopify/Product/${index + 1}`,
          ageRequirement: value === undefined ? null : { value } } },
      } })),
    },
  };
}

test("V2308 missing age metafield defaults to NONE and is classified", () => {
  const age = getAloNowOrderAgeRequirement(orderWith(undefined, null, ""));
  assert.equal(age.classified, true);
  assert.equal(age.requiresAgeCheck, false);
  assert.equal(age.ageRequirement, "NONE");
  assert.equal(age.unclassifiedLineItems.length, 0);
});

test("V2308 explicitly assigned 16+ remains required", () => {
  const age = getAloNowOrderAgeRequirement(orderWith(undefined, "AGE_16"));
  assert.equal(age.classified, true);
  assert.equal(age.requiresAgeCheck, true);
  assert.equal(age.ageRequirement, "AGE_16");
});

test("V2308 18+ wins over 16+ and unrestricted", () => {
  const age = getAloNowOrderAgeRequirement(orderWith("AGE_16", "", "AGE_18"));
  assert.equal(age.classified, true);
  assert.equal(age.requiresAgeCheck, true);
  assert.equal(age.ageRequirement, "AGE_18");
});

test("V2308 invalid explicit age value fails classification", () => {
  const age = getAloNowOrderAgeRequirement(orderWith("AGE_21", undefined));
  assert.equal(age.classified, false);
  assert.equal(age.unclassifiedLineItems.length, 1);
});

test("V2308 missing Shopify product cannot silently become unrestricted", () => {
  const order = { lineItems: { edges: [{ node: {
    id: "gid://shopify/LineItem/1", name: "Unavailable", variant: null,
  } }] } };
  const age = getAloNowOrderAgeRequirement(order);
  assert.equal(age.classified, false);
});

test("V2308 empty order is not classified", () => {
  assert.equal(getAloNowOrderAgeRequirement(orderWith()).classified, false);
});

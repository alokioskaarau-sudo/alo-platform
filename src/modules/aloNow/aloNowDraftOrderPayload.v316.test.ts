import assert from "node:assert/strict";
import { buildAloNowDraftOrderPayload } from "./aloNowDraftOrderPayload.js";

const requestId = "123e4567-e89b-42d3-a456-426614174000";
const checkoutReference = "123e4567-e89b-42d3-a456-426614174001";
const item = {
  variantId: "gid://shopify/ProductVariant/123",
  quantity: 2,
  unitPriceCHF: 4.95,
  title: "ALO Testartikel"
};

const base = {
  requestId, checkoutReference,
  storedItems: [item],
  freshCart: {
    items: [item],
    subtotalCHF: 9.90,
    currency: "CHF" as const
  },
  verifiedSubtotalCHF: "9.90",
  deliveryFeeCHF: "4.50"
};

const result = buildAloNowDraftOrderPayload(base);
assert.equal(result.expectedTotalCHF, "14.40");
assert.deepEqual(result.draftInput.lineItems, [
  { variantId: item.variantId, quantity: 2 }
]);
assert.equal(result.draftInput.shippingLine.priceWithCurrency.amount, "4.50");
assert.equal(result.draftInput.customAttributes.length, 2);
console.log("OK: Draft mit Varianten und Liefergebühr.");

const cases: Array<[string, typeof base]> = [
  ["Preisänderung", {
    ...base, freshCart: {
      ...base.freshCart,
      items: [{ ...item, unitPriceCHF: 5.95 }],
      subtotalCHF: 11.90
    }
  }],
  ["Mengenänderung", {
    ...base, freshCart: {
      ...base.freshCart,
      items: [{ ...item, quantity: 3 }],
      subtotalCHF: 14.85
    }
  }],
  ["Falscher gespeicherter Warenwert", {
    ...base, verifiedSubtotalCHF: "8.90"
  }],
  ["Falscher Live-Warenwert", {
    ...base, freshCart: {
      ...base.freshCart, subtotalCHF: 1
    }
  }],
  ["Ungültige Liefergebühr", {
    ...base, deliveryFeeCHF: "-1.00"
  }],
  ["Ungültige Checkout-Referenz", {
    ...base, checkoutReference: "invalid"
  }],
  ["Doppelte Varianten", {
    ...base,
    storedItems: [item, item],
    freshCart: {
      ...base.freshCart,
      items: [item, item],
      subtotalCHF: 19.80
    },
    verifiedSubtotalCHF: "19.80"
  }],
  ["Leerer Warenkorb", {
    ...base, storedItems: [],
    freshCart: {
      items: [], subtotalCHF: 0, currency: "CHF"
    }
  }]
];

for (const [name, input] of cases) {
  assert.throws(() => buildAloNowDraftOrderPayload(input), name);
  console.log("OK: Abgelehnt –", name);
}

console.log("===== V316 – ALLE 9 TESTS BESTANDEN =====");

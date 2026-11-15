import assert from "node:assert/strict";
import {
  createAloNowShopifyProvenanceReader
} from "./aloNowShopifyProvenanceReader.js";
import {
  verifyAloNowOrderProvenance
} from "./aloNowOrderProvenance.js";

const requestId = "123e4567-e89b-42d3-a456-426614174000";
const reference = "123e4567-e89b-42d3-a456-426614174001";
const other = "123e4567-e89b-42d3-a456-426614174002";
const orderId = "gid://shopify/Order/987654321279";

function payload(attributes: unknown[]) {
  return {
    data: {
      node: { id: orderId, customAttributes: attributes }
    }
  };
}

const attrs = [
  { key: "alo_now_request_id", value: requestId },
  { key: "alo_now_checkout_reference", value: reference }
];

const reader = createAloNowShopifyProvenanceReader(
  async (query, variables) => {
    assert.match(query, /customAttributes/);
    assert.deepEqual(variables, { id: orderId });
    return payload(attrs);
  }
);

const snapshot = await reader(orderId);
assert.ok(snapshot);

assert.deepEqual(
  verifyAloNowOrderProvenance(
    requestId,
    {
      requestId,
      checkoutReference: reference,
      shopifyOrderId: orderId
    },
    snapshot
  ),
  { ok: true }
);
console.log("OK: Shopify-Kennzeichen passen zur Anfrage.");

assert.equal(
  verifyAloNowOrderProvenance(
    requestId,
    {
      requestId,
      checkoutReference: other,
      shopifyOrderId: orderId
    },
    snapshot
  ).ok,
  false
);
console.log("OK: Fremde Checkout-Referenz blockiert.");

async function rejected(data: unknown) {
  const read = createAloNowShopifyProvenanceReader(
    async () => data
  );
  await assert.rejects(read(orderId));
}

await rejected(payload([
  { key: "alo_now_request_id", value: requestId }
]));
console.log("OK: Fehlende Referenz abgelehnt.");

await rejected(payload([
  ...attrs,
  { key: "alo_now_request_id", value: other }
]));
console.log("OK: Doppelte Kennzeichen abgelehnt.");

await rejected(payload([
  { key: "alo_now_request_id", value: "invalid" },
  { key: "alo_now_checkout_reference", value: reference }
]));
console.log("OK: Ungültiges UUID-Format abgelehnt.");

await rejected({
  data: {
    node: {
      id: "gid://shopify/Order/999",
      customAttributes: attrs
    }
  }
});
console.log("OK: Abweichende Shopify-Order-ID abgelehnt.");

await assert.rejects(reader("invalid"));
console.log("OK: Ungültige Bestell-ID vor API-Aufruf blockiert.");

console.log("===== V307 – ALLE 7 TESTS BESTANDEN =====");

import assert from "node:assert/strict";
import {
  verifyAloNowOrderProvenance
} from "./aloNowOrderProvenance.js";

const requestId = "123e4567-e89b-42d3-a456-426614174000";
const otherId = "123e4567-e89b-42d3-a456-426614174001";
const checkoutReference = "123e4567-e89b-42d3-a456-426614174002";
const orderId = "gid://shopify/Order/987654321279";

const intent = {
  requestId,
  checkoutReference,
  shopifyOrderId: orderId
};

const order = {
  id: orderId,
  aloNowRequestId: requestId,
  aloNowCheckoutReference: checkoutReference
};

const cases = [
  ["Gültige Zuordnung", requestId, intent, order, true],
  ["Falsche Anfrage", otherId, intent, order, false],
  ["Falsche Shopify-Order", requestId, intent,
    { ...order, id: "gid://shopify/Order/987654321280" }, false],
  ["Shopify ohne Anfragekennzeichen", requestId, intent,
    { ...order, aloNowRequestId: null }, false],
  ["Fremde Shopify-Anfrage", requestId, intent,
    { ...order, aloNowRequestId: otherId }, false],
  ["Fremde Checkout-Referenz", requestId, intent,
    { ...order, aloNowCheckoutReference: otherId }, false],
  ["Fehlende Checkout-Referenz", requestId, intent,
    { ...order, aloNowCheckoutReference: null }, false],
  ["Manipulierte Intent-Referenz", requestId,
    { ...intent, checkoutReference: otherId }, order, false]
] as const;

for (const [name, id, stored, snapshot, expected] of cases) {
  const result = verifyAloNowOrderProvenance(id, stored, snapshot);
  assert.equal(result.ok, expected, name);
  console.log("OK:", name);
}

console.log("===== V300 – ALLE 8 TESTS BESTANDEN =====");

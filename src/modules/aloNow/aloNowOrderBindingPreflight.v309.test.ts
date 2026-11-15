import assert from "node:assert/strict";
import {
  createAloNowBindingPreflight
} from "./aloNowOrderBindingPreflight.js";
import type {
  AloNowPreflightRecord
} from "./aloNowOrderBindingPreflight.js";
import type {
  AloNowOrderProvenance
} from "./aloNowOrderProvenance.js";

const requestId = "123e4567-e89b-42d3-a456-426614174000";
const reference = "123e4567-e89b-42d3-a456-426614174001";
const other = "123e4567-e89b-42d3-a456-426614174002";
const orderId = "gid://shopify/Order/987654321279";

const row: AloNowPreflightRecord = {
  request_id: requestId,
  checkout_reference: reference,
  intent_order_id: null,
  payment_order_id: null,
  phase: "AWAITING_PAYMENT",
  payment_method: "ONLINE",
  used_elsewhere: false
};

const order: AloNowOrderProvenance = {
  id: orderId,
  aloNowRequestId: requestId,
  aloNowCheckoutReference: reference
};

async function check(
  name: string,
  record: AloNowPreflightRecord | null,
  snapshot: AloNowOrderProvenance | null,
  expected: string,
  id = requestId,
  oid = orderId
) {
  const fn = createAloNowBindingPreflight(
    async () => record,
    async () => snapshot
  );
  const result = await fn(id, oid);
  const actual = result.ok ? "OK" : result.reason;
  assert.equal(actual, expected, name);
  console.log("OK:", name, "=>", actual);
}

await check("Gültige Vorprüfung", row, order, "OK");
await check("Intent fehlt", null, order, "CHECKOUT_INTENT_NOT_FOUND");
await check("Zahlungsphase falsch",
  { ...row, phase: "CANCELLED" }, order, "PAYMENT_STATE_INVALID");
await check("Bestellung doppelt",
  { ...row, used_elsewhere: true }, order, "ORDER_USED_ELSEWHERE");
await check("Vorherige Order widerspricht",
  { ...row, payment_order_id: "gid://shopify/Order/123" },
  order, "EXISTING_BINDING_CONFLICT");
await check("Shopify-Anfrage falsch",
  row, { ...order, aloNowRequestId: other }, "PROVENANCE_MISMATCH");
await check("Checkout-Referenz falsch",
  row, { ...order, aloNowCheckoutReference: other },
  "PROVENANCE_MISMATCH");
await check("Shopify ohne Bestellung",
  row, null, "SHOPIFY_ORDER_NOT_FOUND");
await check("Ungültige Anfrage-ID",
  row, order, "INVALID_REQUEST_ID", "invalid");
await check("Ungültige Shopify-ID",
  row, order, "INVALID_ORDER_ID", requestId, "invalid");

console.log("===== V309B – ALLE 10 TESTS BESTANDEN =====");

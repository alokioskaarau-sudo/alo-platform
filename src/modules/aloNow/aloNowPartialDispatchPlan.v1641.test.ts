import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPartialDispatchPlanV1641,
} from "./aloNowPartialDispatchPlan.v1641.js";
import {
  fingerprintJournalPayloadV1586,
} from "./aloNowFulfillmentJournal.v1586.js";

const order = "gid://shopify/Order/123";
const fulfillmentOrder = "gid://shopify/FulfillmentOrder/456";
const hash = "a".repeat(64);

const lines = [{
  id: "gid://shopify/FulfillmentOrderLineItem/789",
  quantity: 2,
}];

const payload = {
  shopifyOrderId: order,
  fulfillmentOrderId: fulfillmentOrder,
  selectionHash: hash,
  lines,
};

const payloadHash = fingerprintJournalPayloadV1586(payload);

function snapshot() {
  return {
    shopifyOrderId: order,
    selectionHash: hash,
    selectionState: "PREPARED",
    manifest: [{
      fulfillmentOrderId: fulfillmentOrder,
      fulfillmentOrderLineItems: lines,
    }],
    journal: [{
      fulfillmentOrderId: fulfillmentOrder,
      selectionHash: hash,
      payloadHash,
      fulfillmentLines: lines,
      state: "PREPARED" as const,
      shopifyFulfillmentId: null as string | null,
    }],
  };
}

test("Gültiger gespeicherter Plan", () => {
  const result = buildPartialDispatchPlanV1641(snapshot());
  assert.equal(result.action, "DISPATCH_READY");
  assert.deepEqual(result.payloads, [payload]);
});

test("Geänderte gespeicherte Menge wird blockiert", () => {
  const data = snapshot();
  data.journal[0].fulfillmentLines = [
    {...lines[0], quantity: 3}
  ];
  assert.throws(
    () => buildPartialDispatchPlanV1641(data),
    /JOURNAL_LINES_CHANGED/
  );
});

test("Fehlender Journal-Eintrag wird blockiert", () => {
  const data = snapshot();
  const input = {...data, journal: []};
  assert.throws(
    () => buildPartialDispatchPlanV1641(input),
    /INVALID_DISPATCH_SNAPSHOT/
  );
});

test("Ungeklärter Shopify-Status wird blockiert", () => {
  const data = snapshot();
  const input = {
    ...data,
    journal: data.journal.map(row => ({
      ...row,
      state: "RECONCILE_REQUIRED" as const,
    })),
  };
  assert.throws(
    () => buildPartialDispatchPlanV1641(input),
    /JOURNAL_RECONCILIATION_REQUIRED/
  );
});

test("Bereits bestätigte Erfüllung wird nicht erneut gesendet", () => {
  const data = snapshot();
  const input = {
    ...data,
    journal: data.journal.map(row => ({
      ...row,
      state: "CONFIRMED" as const,
      shopifyFulfillmentId: "gid://shopify/Fulfillment/999",
    })),
  };
  const result = buildPartialDispatchPlanV1641(input);
  assert.equal(result.action, "ALREADY_CONFIRMED");
  assert.equal(result.payloads.length, 0);
});

test("Manipulierter Auswahl-Hash wird blockiert", () => {
  const data = snapshot();
  const input = {...data, selectionHash: "b".repeat(64)};
  assert.throws(
    () => buildPartialDispatchPlanV1641(input),
    /JOURNAL_PAYLOAD_MISMATCH/
  );
});

test("Abgeschlossene Auswahl kann nicht dispatchen", () => {
  const input = {
    ...snapshot(),
    selectionState: "COMPLETED",
  };
  assert.throws(
    () => buildPartialDispatchPlanV1641(input),
    /INVALID_DISPATCH_SNAPSHOT/
  );
});

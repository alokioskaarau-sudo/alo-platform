import test from "node:test";
import assert from "node:assert/strict";

import {
  fingerprintJournalPayloadV1586,
  decideJournalActionV1586,
  assertJournalTransitionV1586,
  type JournalStateV1586,
} from "./aloNowFulfillmentJournal.v1586.js";

const selectionHash = "a".repeat(64);

const payload = {
  shopifyOrderId: "123456",
  fulfillmentOrderId: "gid://shopify/FulfillmentOrder/987654",
  selectionHash,
  lines: [
    { id: "gid://shopify/FulfillmentOrderLineItem/1", quantity: 2 },
  ],
};

const payloadHash = fingerprintJournalPayloadV1586(payload);

function existing(state: JournalStateV1586) {
  return {
    shopifyOrderId: payload.shopifyOrderId,
    fulfillmentOrderId: payload.fulfillmentOrderId,
    selectionHash,
    payloadHash,
    state,
  };
}

test("Neuer Vorgang muss vorbereitet werden", () => {
  assert.equal(
    decideJournalActionV1586({ existing: null, payload }),
    "PREPARE_NEW"
  );
});

test("PREPARED darf versendet werden", () => {
  assert.equal(
    decideJournalActionV1586({
      existing: existing("PREPARED"), payload
    }),
    "SAFE_TO_DISPATCH"
  );
});

test("CONFIRMED verhindert erneute Erfüllung", () => {
  assert.equal(
    decideJournalActionV1586({
      existing: existing("CONFIRMED"), payload
    }),
    "ALREADY_CONFIRMED"
  );
});

test("DISPATCHING verlangt Abgleich", () => {
  assert.equal(
    decideJournalActionV1586({
      existing: existing("DISPATCHING"), payload
    }),
    "MANUAL_RECONCILIATION"
  );
});

test("RECONCILE_REQUIRED verhindert Retry", () => {
  assert.equal(
    decideJournalActionV1586({
      existing: existing("RECONCILE_REQUIRED"), payload
    }),
    "MANUAL_RECONCILIATION"
  );
});

test("Andere Menge erzeugt Idempotenzkonflikt", () => {
  assert.throws(
    () => decideJournalActionV1586({
      existing: existing("PREPARED"),
      payload: {
        ...payload,
        lines: [{ ...payload.lines[0], quantity: 3 }],
      },
    }),
    /JOURNAL_IDEMPOTENCY_CONFLICT/
  );
});

test("Gültige Journal-Übergänge", () => {
  assert.doesNotThrow(() =>
    assertJournalTransitionV1586("PREPARED", "DISPATCHING")
  );
  assert.doesNotThrow(() =>
    assertJournalTransitionV1586("DISPATCHING", "CONFIRMED")
  );
  assert.doesNotThrow(() =>
    assertJournalTransitionV1586(
      "DISPATCHING", "RECONCILE_REQUIRED"
    )
  );
});

test("Verbotene Journal-Übergänge", () => {
  const invalid: Array<[JournalStateV1586, JournalStateV1586]> = [
    ["PREPARED", "CONFIRMED"],
    ["CONFIRMED", "DISPATCHING"],
    ["RECONCILE_REQUIRED", "PREPARED"],
    ["RECONCILE_REQUIRED", "DISPATCHING"],
  ];
  for (const [from, to] of invalid) {
    assert.throws(
      () => assertJournalTransitionV1586(from, to),
      /INVALID_JOURNAL_TRANSITION/
    );
  }
});

test("Unveränderter Payload hat denselben Fingerprint", () => {
  assert.equal(
    fingerprintJournalPayloadV1586(payload),
    payloadHash
  );
});

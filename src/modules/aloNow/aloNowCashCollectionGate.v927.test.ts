import assert from "node:assert/strict";
import test from "node:test";
import {
  checkCashCollectionV927,
  type CashGateInputV927
} from "./aloNowCashCollectionGate.v927.js";

const valid: CashGateInputV927 = {
  orderId: "gid://shopify/Order/123",
  driverId: "driver-1",
  assignedDriverId: "driver-1",
  shiftDriverId: "driver-1",
  shiftStatus: "OPEN",
  deliveryStatus: "ON_THE_WAY",
  paymentMethod: "CASH",
  paymentPhase: "CASH_CONFIRMED",
  alreadyCollected: false,
  dueRappen: 5800
};

test("V927 permits valid cash collection", () => {
  assert.deepEqual(
    checkCashCollectionV927(valid),
    { allowed: true, dueRappen: 5800 }
  );
});

test("V927 prevents online double collection", () => {
  assert.equal(
    checkCashCollectionV927({
      ...valid,
      paymentMethod: "ONLINE",
      paymentPhase: "PAYMENT_CONFIRMED"
    }).allowed,
    false
  );
});

test("V927 rejects wrong driver", () => {
  assert.equal(
    checkCashCollectionV927({
      ...valid,
      assignedDriverId: "other-driver"
    }).allowed,
    false
  );
});

test("V927 requires an open cash shift", () => {
  assert.equal(
    checkCashCollectionV927({
      ...valid,
      shiftStatus: "CLOSED"
    }).allowed,
    false
  );
});

test("V927 blocks duplicate cash collection", () => {
  assert.deepEqual(
    checkCashCollectionV927({
      ...valid,
      alreadyCollected: true
    }),
    { allowed: false, reason: "CASH_ALREADY_COLLECTED" }
  );
});

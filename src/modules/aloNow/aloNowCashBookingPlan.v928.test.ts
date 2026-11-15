import test from "node:test";
import assert from "node:assert/strict";
import {
  planCashBookingV928
} from "./aloNowCashBookingPlan.v928.js";
import type {
  CashGateInputV927
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

test("V928 CHF 60 -> CHF 2 change", () => {
  const p = planCashBookingV928(valid,6000,0);
  assert.equal(p.orderCashRappen,5800);
  assert.equal(p.changeRappen,200);
  assert.equal(p.eventKeys.tip,null);
});

test("V928 explicit tip is separated", () => {
  const p = planCashBookingV928(valid,6000,200);
  assert.equal(p.orderCashRappen,5800);
  assert.equal(p.cashTipRappen,200);
  assert.equal(p.changeRappen,0);
  assert.ok(p.eventKeys.tip);
});

test("V928 rejects online payment", () => {
  assert.throws(() => planCashBookingV928({
    ...valid,
    paymentMethod:"ONLINE",
    paymentPhase:"PAYMENT_CONFIRMED"
  },6000,0));
});

test("V928 rejects wrong driver", () => {
  assert.throws(() => planCashBookingV928({
    ...valid,assignedDriverId:"other"
  },6000,0));
});

test("V928 prevents duplicate collection", () => {
  assert.throws(() => planCashBookingV928({
    ...valid,alreadyCollected:true
  },6000,0));
});

test("V928 rejects invalid tip", () => {
  assert.throws(() => planCashBookingV928(valid,6000,-100));
});

test("V928 stable event keys", () => {
  const a=planCashBookingV928(valid,6000,200);
  const b=planCashBookingV928(valid,6000,200);
  assert.deepEqual(a.eventKeys,b.eventKeys);
});

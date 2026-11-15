import assert from "node:assert/strict";
import test from "node:test";
import {quoteCashTenderV925, parseChfToRappenV925} from "./aloNowCashTender.v925.js";

test("V925 CHF conversion is exact", () => {
  assert.equal(parseChfToRappenV925("58"),5800);
  assert.equal(parseChfToRappenV925("58.5"),5850);
  assert.equal(parseChfToRappenV925("58,05"),5805);
  for (const input of ["-1", "1.999", "NaN", "1e3", "", "01", "1,2,3"])
    assert.throws(() => parseChfToRappenV925(input));
});

test("V925 60 CHF tender against 58 CHF due", () => {
  const q=quoteCashTenderV925({dueRappen:5800,receivedRappen:6000,explicitCashTipRappen:0});
  assert.equal(q.changeRappen,200);
  assert.equal(q.cashOrderRevenueRappen,5800);
  assert.equal(q.driverCashIntakeRappen,5800);
  assert.equal(q.paymentRecorded,false);
});

test("V925 2 CHF tip only when explicitly given", () => {
  const q=quoteCashTenderV925({dueRappen:5800,receivedRappen:6000,explicitCashTipRappen:200});
  assert.equal(q.changeRappen,0);
  assert.equal(q.cashOrderRevenueRappen,5800);
  assert.equal(q.cashTipRappen,200);
  assert.equal(q.driverCashIntakeRappen,6000);
  assert.equal(q.cashTipRetainedByDriver,false);
});

test("V925 rejects insufficient or invalid amounts", () => {
  for (const input of [
    {dueRappen:5800,receivedRappen:5799,explicitCashTipRappen:0},
    {dueRappen:5800,receivedRappen:6000,explicitCashTipRappen:201},
    {dueRappen:0,receivedRappen:6000,explicitCashTipRappen:0},
    {dueRappen:5800,receivedRappen:NaN,explicitCashTipRappen:0},
    {dueRappen:5800.5,receivedRappen:6000,explicitCashTipRappen:0},
    {dueRappen:5800,receivedRappen:6000,explicitCashTipRappen:-1},
  ]) assert.throws(() => quoteCashTenderV925(input));
});

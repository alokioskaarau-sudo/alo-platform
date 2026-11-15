import test from "node:test";
import assert from "node:assert/strict";
import {
  quoteDriverCommissionV1861 as quote,
  ALO_DRIVER_TARIFF_V1861 as tariff,
} from "./aloNowDriverTariff.v1861.js";

test("Approved base tariff", () => {
  assert.equal(tariff.baseRappen, 200);
  assert.equal(tariff.rappenPerKm, 50);
  assert.equal(tariff.capRappen, 800);
});

test("One kilometre pays CHF 2.50", () => {
  assert.equal(quote(1000).quotedCommissionRappen, 250);
});

test("3.2 km rounds CHF 3.60 up to CHF 4.00", () => {
  assert.equal(quote(3200).quotedCommissionRappen, 400);
});

test("4 km pays CHF 4.00", () => {
  assert.equal(quote(4000).quotedCommissionRappen, 400);
});

test("12 km reaches CHF 8.00 cap", () => {
  assert.equal(quote(12000).quotedCommissionRappen, 800);
});

test("Long routes never exceed the cap", () => {
  assert.equal(quote(25000).quotedCommissionRappen, 800);
});

test("Missing or invalid distance is rejected", () => {
  for (const distance of [
    0, -1, NaN, Infinity, 2.4
  ]) {
    assert.throws(() => quote(distance));
  }
});

test("Result retains the original quoted distance", () => {
  const result = quote(3200);
  assert.equal(result.distanceMetres, 3200);
  assert.equal(result.tariffVersion, tariff.version);
  assert.equal(result.currency, "CHF");
  assert.equal(Object.isFrozen(result), true);
});

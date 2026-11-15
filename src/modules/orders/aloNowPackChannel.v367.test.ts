
import test from "node:test";
import assert from "node:assert/strict";
import {
  getStaffOrderChannel
} from "./orderFulfillmentType.js";

function order(methods: Array<{
  methodType: string;
  presentedName: string;
}>, complete = true) {
  return {
    fulfillmentOrders: {
      edges: methods.map(deliveryMethod => ({
        node: { deliveryMethod }
      })),
      pageInfo: {
        hasNextPage: !complete
      }
    }
  };
}

const now = {
  methodType: "LOCAL",
  presentedName: "ALO NOW"
};

const pickup = {
  methodType: "PICK_UP",
  presentedName: "Abholung"
};

const shipping = {
  methodType: "SHIPPING",
  presentedName: "Standardversand"
};

test("ALO NOW wird eindeutig erkannt", () => {
  assert.equal(
    getStaffOrderChannel(order([now])),
    "ALO_NOW"
  );
});

test("Mehrere ALO NOW Positionen bleiben ALO NOW", () => {
  assert.equal(
    getStaffOrderChannel(order([
      now,
      { methodType: "LOCAL", presentedName: "ALO NOW Aarau" }
    ])),
    "ALO_NOW"
  );
});

test("ALO NOW und Abholung dürfen nicht gemischt werden", () => {
  assert.equal(
    getStaffOrderChannel(order([now, pickup])),
    "UNKNOWN"
  );
});

test("ALO NOW und Versand dürfen nicht gemischt werden", () => {
  assert.equal(
    getStaffOrderChannel(order([now, shipping])),
    "UNKNOWN"
  );
});

test("Unvollständige Shopify-Pagination wird gesperrt", () => {
  assert.equal(
    getStaffOrderChannel(order([now], false)),
    "UNKNOWN"
  );
});

test("Ohne Fulfillment Orders keine Kanalentscheidung", () => {
  assert.equal(
    getStaffOrderChannel(order([])),
    "UNKNOWN"
  );
});

test("ALO NOW nicht durch ähnlich klingende Namen erfinden", () => {
  assert.equal(
    getStaffOrderChannel(order([{
      methodType: "LOCAL",
      presentedName: "ALO NOWHERE"
    }])),
    "UNKNOWN"
  );
});

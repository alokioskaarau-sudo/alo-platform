
import test from "node:test";
import assert from "node:assert/strict";

const { getStaffOrderChannel } = await import(
  "../dist/modules/orders/orderFulfillmentType.js"
);

const context = {
  classify: getStaffOrderChannel
};

function order(...methods) {
  return {
    fulfillmentOrders: {
      pageInfo: { hasNextPage: false },
      edges: methods.map(deliveryMethod => ({
        node: { deliveryMethod }
      }))
    }
  };
}

const cases = [
  ["Normaler Versand", order({
    methodType: "SHIPPING",
    presentedName: "Standardversand"
  }), "SHIPPING"],

  ["Abholung", order({
    methodType: "PICK_UP",
    presentedName: "Abholung"
  }), "PICKUP"],

  ["ALO NOW", order({
    methodType: "SHIPPING",
    presentedName: "ALO NOW"
  }), "ALO_NOW"],

  ["ALO NOW mit Zusatz", order({
    methodType: "SHIPPING",
    presentedName: "ALO NOW Aarau"
  }), "ALO_NOW"],

  ["Gemischter Versand und ALO NOW", order(
    { methodType: "SHIPPING", presentedName: "Standardversand" },
    { methodType: "SHIPPING", presentedName: "ALO NOW" }
  ), "UNKNOWN"],

  ["Gemischte Abholung und Versand", order(
    { methodType: "PICK_UP", presentedName: "Abholung" },
    { methodType: "SHIPPING", presentedName: "Standardversand" }
  ), "UNKNOWN"],

  ["Keine Fulfillment Orders", order(), "UNKNOWN"],

  ["Unbekannte Versandmethode", order({
    methodType: "LOCAL",
    presentedName: "Lieferung"
  }), "UNKNOWN"],

  ["Fehlende Liefermethode", order({}), "UNKNOWN"],

  ["Mehrere gleiche Versandarten", order(
    { methodType: "SHIPPING", presentedName: "Standardversand" },
    { methodType: "SHIPPING", presentedName: "Expressversand" }
  ), "SHIPPING"],

  ["Unvollständige Pagination", {
    fulfillmentOrders: {
      pageInfo: { hasNextPage: true },
      edges: [{
        node: {
          deliveryMethod: {
            methodType: "SHIPPING",
            presentedName: "Standardversand"
          }
        }
      }]
    }
  }, "UNKNOWN"],

  ["Pagination fehlt", {
    fulfillmentOrders: {
      edges: [{
        node: {
          deliveryMethod: {
            methodType: "SHIPPING",
            presentedName: "Standardversand"
          }
        }
      }]
    }
  }, "UNKNOWN"]
];

for (const [name, input, expected] of cases) {
  test(name, () => {
    assert.equal(context.classify(input), expected);
  });
}

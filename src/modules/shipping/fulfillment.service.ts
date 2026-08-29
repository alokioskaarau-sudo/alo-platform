import {
  getFulfillmentOrdersForOrder,
  createShopifyFulfillment,
} from "../../integrations/shopify/fulfillment.js";

import {
  findShippingLabel,
} from "../../database/shippingLabels.js";


type ShopifyOrder = {
  id: string;
  name: string;
  displayFulfillmentStatus: string;
};


export async function fulfillShopifyOrderWithSwissPostTracking(
  order: ShopifyOrder
) {
  const normalizedStatus =
    String(
      order.displayFulfillmentStatus || ""
    ).toUpperCase();


  // ==========================================================
  // 1. Shopify bereits fulfilled
  // ==========================================================

  if (normalizedStatus === "FULFILLED") {
    const existingLabel =
      await findShippingLabel(
        order.id,
        "LIVE"
      );

    return {
      alreadyFulfilled: true,

      orderName:
        order.name,

      swissPostIdentCode:
        existingLabel?.swisspost_ident_code ?? null,

      fulfillmentOrderId:
        null,

      fulfillment:
        null,

      message:
        "Bestellung ist in Shopify bereits fulfilled. Kein zweites Fulfillment erstellt.",
    };
  }


  // ==========================================================
  // 2. Versandlabel suchen
  // ==========================================================

  const label =
    await findShippingLabel(
      order.id,
      "LIVE"
    );


  if (!label) {
    throw new Error(
      `Für ${order.name} wurde noch kein Shipping Label gespeichert.`
    );
  }


  if (
    label.status !== "COMPLETED"
  ) {
    throw new Error(
      `Shipping Label für ${order.name} ist noch nicht vollständig erstellt.`
    );
  }


  if (
    !label.swisspost_ident_code
  ) {
    throw new Error(
      `Swiss Post IdentCode für ${order.name} fehlt.`
    );
  }


  // ==========================================================
  // 3. Shopify Fulfillment Orders laden
  // ==========================================================

  const fulfillmentData =
    await getFulfillmentOrdersForOrder(
      order.id
    );


  const fulfillmentOrders =
    fulfillmentData
      ?.fulfillmentOrders
      ?.nodes ?? [];


  const openFulfillmentOrder =
    fulfillmentOrders.find(
      (fulfillmentOrder: any) =>
        fulfillmentOrder.status === "OPEN"
    );


  // ==========================================================
  // 4. Keine offene Fulfillment Order mehr
  // ==========================================================

  if (!openFulfillmentOrder) {
    return {
      alreadyFulfilled: true,

      orderName:
        order.name,

      swissPostIdentCode:
        label.swisspost_ident_code,

      fulfillmentOrderId:
        null,

      fulfillment:
        null,

      message:
        "Keine offene Fulfillment Order vorhanden. Bestellung scheint bereits erfüllt zu sein.",
    };
  }


  // ==========================================================
  // 5. Shopify Fulfillment erstellen
  // ==========================================================

  const fulfillment =
    await createShopifyFulfillment({
      fulfillmentOrderId:
        openFulfillmentOrder.id,

      trackingNumber:
        label.swisspost_ident_code,

      notifyCustomer: false,
    });


  return {
    alreadyFulfilled: false,

    orderName:
      order.name,

    fulfillmentOrderId:
      openFulfillmentOrder.id,

    swissPostIdentCode:
      label.swisspost_ident_code,

    fulfillment,
  };
}

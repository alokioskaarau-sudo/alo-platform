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


  const fulfillableFulfillmentOrders =
    fulfillmentOrders.filter(
      (fulfillmentOrder: any) => {
        const status =
          String(
            fulfillmentOrder.status ?? ""
          ).toUpperCase();

        const remainingQuantity =
          (
            fulfillmentOrder
              ?.lineItems
              ?.nodes ?? []
          ).reduce(
            (
              total: number,
              lineItem: any
            ) =>
              total +
              Math.max(
                0,
                Number(
                  lineItem
                    ?.remainingQuantity ??
                    0
                )
              ),
            0
          );

        return (
          (
            status === "OPEN" ||
            status === "IN_PROGRESS"
          ) &&
          remainingQuantity > 0
        );
      }
    );


  // ==========================================================
  // 4. Keine offene Fulfillment Order mehr
  //
  // Hier NICHT behaupten, dass die Bestellung fulfilled ist.
  // Der aufrufende READY_TO_SHIP-Flow lädt Shopify danach
  // erneut und prüft displayFulfillmentStatus === FULFILLED.
  // ==========================================================

  if (fulfillableFulfillmentOrders.length === 0) {
    return {
      alreadyFulfilled: false,

      orderName:
        order.name,

      swissPostIdentCode:
        label.swisspost_ident_code,

      fulfillmentOrderIds:
        [],

      fulfillments:
        [],

      message:
        "Keine offene Shopify Fulfillment Order vorhanden. Finaler Shopify Order-Status wird separat verifiziert.",
    };
  }


  // ==========================================================
  // 5. Alle offenen Shopify Fulfillment Orders erfüllen
  //
  // Relevant für Split-Fulfillments:
  // Eine Bestellung kann mehrere Fulfillment Orders besitzen.
  // ==========================================================

  const fulfillments: Array<{
    fulfillmentOrderId: string;
    fulfillment: any;
  }> = [];

  for (
    const openFulfillmentOrder
    of fulfillableFulfillmentOrders
  ) {
    const fulfillment =
      await createShopifyFulfillment({
        fulfillmentOrderId:
          openFulfillmentOrder.id,

        trackingNumber:
          label.swisspost_ident_code,

        notifyCustomer: false,
      });

    fulfillments.push({
      fulfillmentOrderId:
        openFulfillmentOrder.id,

      fulfillment,
    });
  }


  return {
    alreadyFulfilled: false,

    orderName:
      order.name,

    fulfillmentOrderIds:
      fulfillableFulfillmentOrders.map(
        (fulfillmentOrder: any) =>
          fulfillmentOrder.id
      ),

    swissPostIdentCode:
      label.swisspost_ident_code,

    fulfillments,
  };

}

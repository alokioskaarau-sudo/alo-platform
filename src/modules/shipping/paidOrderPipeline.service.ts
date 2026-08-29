import {
  getShopifyOrderById,
} from "../../integrations/shopify/orders.js";

import {
  createSpecimenLabelForOrder,
} from "./shipping.service.js";

import {
  findShippingLabel,
} from "../../database/shippingLabels.js";

import {
  createPrintJob,
} from "../../database/shippingDashboard.js";

import {
  createPickupReceiptForOrder,
} from "../pickup/pickupReceipt.service.js";


// ============================================================
// PICKUP ERKENNEN
// ============================================================

function isPickupOrder(
  order: any
): boolean {

  const fulfillmentOrders =
    order
      ?.fulfillmentOrders
      ?.edges
      ?.map(
        (edge: any) =>
          edge?.node
      )
      ?.filter(Boolean) ??
    [];


  if (
    fulfillmentOrders.length ===
    0
  ) {
    return false;
  }


  return fulfillmentOrders.some(
    (fulfillmentOrder: any) => {

      const methodType =
        String(
          fulfillmentOrder
            ?.deliveryMethod
            ?.methodType ??
          ""
        ).toUpperCase();

      const presentedName =
        String(
          fulfillmentOrder
            ?.deliveryMethod
            ?.presentedName ??
          ""
        ).toLowerCase();


      return (
        methodType ===
          "PICK_UP" ||

        methodType ===
          "PICKUP" ||

        presentedName.includes(
          "abholung"
        ) ||

        presentedName.includes(
          "pickup"
        )
      );
    }
  );
}


// ============================================================
// PAID ORDER PIPELINE
// ============================================================

export async function processPaidShopifyOrder(
  orderId: string
) {

  console.log(
    "Paid Order Pipeline gestartet:",
    orderId
  );


  // ----------------------------------------------------------
  // SHOPIFY ORDER
  // ----------------------------------------------------------

  const order =
    await getShopifyOrderById(
      orderId
    );


  if (!order) {
    throw new Error(
      `Shopify Bestellung ${orderId} wurde nicht gefunden.`
    );
  }


  // ----------------------------------------------------------
  // PAYMENT
  // ----------------------------------------------------------

  if (
    order.displayFinancialStatus !==
    "PAID"
  ) {

    throw new Error(
      `Bestellung ${order.name} ist nicht PAID.`
    );
  }


  // ----------------------------------------------------------
  // BEREITS FULFILLED
  // ----------------------------------------------------------

  if (
    order.displayFulfillmentStatus ===
    "FULFILLED"
  ) {

    console.log(
      `Bestellung ${order.name} ist bereits fulfilled.`
    );

    return {

      skipped: true,

      reason:
        "ALREADY_FULFILLED",

      orderName:
        order.name,
    };
  }


  // ----------------------------------------------------------
  // VERSANDART ERKENNEN
  // ----------------------------------------------------------

  const pickup =
    isPickupOrder(
      order
    );


  console.log(
    `Bestellung ${order.name}:`,
    {
      fulfillmentType:
        pickup
          ? "PICKUP"
          : "SHIPPING",
    }
  );


  // ==========================================================
  // PICKUP
  // ==========================================================

  if (pickup) {

    console.log(
      `Abholbestellung erkannt: ${order.name}`
    );


    const receipt =
      await createPickupReceiptForOrder(
        order
      );


    const storedLabel =
      await findShippingLabel(
        order.id,
        "PICKUP"
      );


    if (!storedLabel) {

      throw new Error(
        `Abholbon für ${order.name} wurde nicht gefunden.`
      );
    }


    if (
      storedLabel.status !==
      "COMPLETED"
    ) {

      throw new Error(
        `Abholbon für ${order.name} ist nicht COMPLETED.`
      );
    }


    const printJob =
      await createPrintJob(
        storedLabel.id
      );


    console.log(
      `Pickup Pipeline bereit: ${order.name}`,
      {
        labelId:
          storedLabel.id,

        receiptReused:
          receipt.reused,

        printJobCreated:
          printJob.created,
      }
    );


    return {

      skipped: false,

      orderId:
        order.id,

      orderName:
        order.name,

      fulfillmentType:
        "PICKUP",

      label: {

        id:
          storedLabel.id,

        mode:
          "PICKUP",

        reused:
          receipt.reused,
      },

      printJob: {

        created:
          printJob.created,

        id:
          printJob.job?.id ??
          null,

        status:
          printJob.job?.status ??
          null,
      },
    };
  }


  // ==========================================================
  // SHIPPING
  // ==========================================================

  console.log(
    `Versandbestellung erkannt: ${order.name}`
  );


  const label =
    await createSpecimenLabelForOrder(
      order
    );


  const storedLabel =
    await findShippingLabel(
      order.id,
      "SPECIMEN"
    );


  if (!storedLabel) {

    throw new Error(
      `Gespeichertes Label für ${order.name} wurde nicht gefunden.`
    );
  }


  if (
    storedLabel.status !==
    "COMPLETED"
  ) {

    throw new Error(
      `Label für ${order.name} ist nicht COMPLETED.`
    );
  }


  const printJob =
    await createPrintJob(
      storedLabel.id
    );


  console.log(
    `Shipping Pipeline bereit: ${order.name}`,
    {

      labelId:
        storedLabel.id,

      labelReused:
        label.reused,

      printJobCreated:
        printJob.created,
    }
  );


  return {

    skipped: false,

    orderId:
      order.id,

    orderName:
      order.name,

    fulfillmentType:
      "SHIPPING",

    label: {

      id:
        storedLabel.id,

      mode:
        "SPECIMEN",

      identCode:
        label.identCode,

      reused:
        label.reused,

      weightGrams:
        label.weightGrams,
    },

    printJob: {

      created:
        printJob.created,

      id:
        printJob.job?.id ??
        null,

      status:
        printJob.job?.status ??
        null,
    },
  };
}

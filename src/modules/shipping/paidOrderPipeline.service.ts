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

export async function processPaidShopifyOrder(
  orderId: string
) {
  console.log(
    "Paid Order Pipeline gestartet:",
    orderId
  );

  const order =
    await getShopifyOrderById(
      orderId
    );

  if (!order) {
    throw new Error(
      `Shopify Bestellung ${orderId} wurde nicht gefunden.`
    );
  }

  if (
    order.displayFinancialStatus !==
    "PAID"
  ) {
    throw new Error(
      `Bestellung ${order.name} ist nicht PAID.`
    );
  }

  if (
    order.displayFulfillmentStatus ===
    "FULFILLED"
  ) {
    console.log(
      `Bestellung ${order.name} ist bereits fulfilled.`
    );

    return {
      skipped: true,
      reason: "ALREADY_FULFILLED",
      orderName: order.name,
    };
  }

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
    `Paid Order Pipeline bereit: ${order.name}`,
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

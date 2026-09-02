import {
  getShopifyOrderById,
} from "../../integrations/shopify/orders.js";

import {
  createLiveLabelForOrder,
} from "./shipping.service.js";

import {
  findShippingLabel,
} from "../../database/shippingLabels.js";

import {
  createPrintJob,
  createPackingSlipPrintJob,
  createInvoicePrintJob,
} from "../../database/shippingDashboard.js";

import {
  createPickupReceiptForOrder,
} from "../pickup/pickupReceipt.service.js";

import {
  createPackingSlipForOrder,
} from "./packingSlip.service.js";

import {
  createInvoiceForOrder,
} from "../invoices/invoice.service.js";


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
  // VERSANDART
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


  // ----------------------------------------------------------
  // 1. VERSANDLABEL
  // ----------------------------------------------------------

  const label =
    await createLiveLabelForOrder(
      order
    );


  const storedLabel =
    await findShippingLabel(
      order.id,
      "LIVE"
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


  // ----------------------------------------------------------
  // 2. VERSANDLABEL PRINT JOB
  // ----------------------------------------------------------

  const shippingPrintJob =
    await createPrintJob(
      storedLabel.id
    );


  // ----------------------------------------------------------
  // 3. LIEFERSCHEIN ERZEUGEN
  // ----------------------------------------------------------

  const packingSlip =
    await createPackingSlipForOrder(
      order
    );


  if (
    !packingSlip?.id
  ) {

    throw new Error(
      `Lieferschein für ${order.name} wurde nicht erstellt.`
    );
  }


  if (
    !packingSlip?.pdfBase64
  ) {

    throw new Error(
      `Lieferschein für ${order.name} enthält kein PDF.`
    );
  }


  // ----------------------------------------------------------
  // 4. LIEFERSCHEIN PRINT JOB
  // ----------------------------------------------------------

  const packingSlipPrintJob =
    await createPackingSlipPrintJob(
      packingSlip.id
    );


  // ----------------------------------------------------------
  // 5. RECHNUNG ERZEUGEN / ARCHIVIEREN
  // ----------------------------------------------------------

  const invoice =
    await createInvoiceForOrder(
      order
    );

  if (
    !invoice?.id
  ) {
    throw new Error(
      `Rechnung für ${order.name} wurde nicht erstellt.`
    );
  }

  if (
    !invoice?.pdfBase64
  ) {
    throw new Error(
      `Rechnung für ${order.name} enthält kein PDF.`
    );
  }


  // ----------------------------------------------------------
  // 6. RECHNUNG PRINT JOB
  // ----------------------------------------------------------

  const invoicePrintJob =
    await createInvoicePrintJob(
      invoice.id
    );


  // ----------------------------------------------------------
  // LOG
  // ----------------------------------------------------------

  console.log(
    `Shipping Pipeline vollständig bereit: ${order.name}`,
    {

      labelId:
        storedLabel.id,

      labelReused:
        label.reused,

      shippingPrintJobCreated:
        shippingPrintJob.created,

      packingSlipId:
        packingSlip.id,

      packingSlipReused:
        packingSlip.reused,

      packingSlipPrintJobCreated:
        packingSlipPrintJob.created,

      invoiceId:
        invoice.id,

      invoiceNumber:
        invoice.invoiceNumber,

      invoiceReused:
        invoice.reused,

      invoicePrintJobCreated:
        invoicePrintJob.created,
    }
  );


  // ----------------------------------------------------------
  // RETURN
  // ----------------------------------------------------------

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
        "LIVE",

      identCode:
        label.identCode,

      reused:
        label.reused,

      weightGrams:
        label.weightGrams,
    },


    packingSlip: {

      id:
        packingSlip.id,

      reused:
        packingSlip.reused,
    },

    invoice: {

      id:
        invoice.id,

      invoiceNumber:
        invoice.invoiceNumber,

      reused:
        invoice.reused,
    },


    printJobs: {

      shippingLabel: {

        created:
          shippingPrintJob.created,

        id:
          shippingPrintJob.job?.id ??
          null,

        status:
          shippingPrintJob.job?.status ??
          null,
      },


      packingSlip: {

        created:
          packingSlipPrintJob.created,

        id:
          packingSlipPrintJob.job?.id ??
          null,

        status:
          packingSlipPrintJob.job?.status ??
          null,
      },

      invoice: {

        created:
          invoicePrintJob.created,

        id:
          invoicePrintJob.job?.id ??
          null,

        status:
          invoicePrintJob.job?.status ??
          null,

      },
    },
  };
}

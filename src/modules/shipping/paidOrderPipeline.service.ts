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

import {
  ensureOrderFulfillmentWorkflow,
} from "../../database/orderFulfillmentWorkflow.js";

import {
  sendNewOrderStaffPush,
} from "../staff/staffPush.service.js";
import {
  ensureAloNowDelivery,
} from "../../database/aloNowDeliveries.js";
import {
  getOrderFulfillmentType,
} from "../orders/orderFulfillmentType.js";

// ============================================================
// PICKUP ERKENNEN
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

  const fulfillmentType =
    getOrderFulfillmentType(
      order
    );

  const pickup =
    fulfillmentType === "PICKUP";

  console.log(
    `Bestellung ${order.name}:`,
    {
      fulfillmentType,
    }
  );

  if (
    fulfillmentType === "ALO_NOW"
  ) {
    console.log(
      `ALO NOW Bestellung erkannt: ${order.name}`
    );

    const packingSlip =
      await createPackingSlipForOrder(
        order
      );

    if (
      !packingSlip?.id ||
      !packingSlip?.pdfBase64
    ) {
      throw new Error(
        `ALO NOW Lieferschein für ${order.name} wurde nicht vollständig erstellt.`
      );
    }

    const packingSlipPrintJob =
      await createPackingSlipPrintJob(
        packingSlip.id,
        "HP7C4D8F71B318(HP Color Laser MFP 178 179)"
      );

    const invoice =
      await createInvoiceForOrder(
        order
      );

    if (
      !invoice?.id ||
      !invoice?.pdfBase64
    ) {
      throw new Error(
        `ALO NOW Rechnung für ${order.name} wurde nicht vollständig erstellt.`
      );
    }

    const invoicePrintJob =
      await createInvoicePrintJob(
        invoice.id,
        "HP7C4D8F71B318(HP Color Laser MFP 178 179)"
      );

    const workflow =
      await ensureOrderFulfillmentWorkflow(
        order.id
      );

    const delivery =
      await ensureAloNowDelivery(
        order.id,
        order.name,
        "AARAU",
        false
      );

    try {
      const pushResult =
        await sendNewOrderStaffPush({
          orderId: order.id,
          orderName: order.name,
          totalAmount:
            order?.currentTotalPriceSet
              ?.shopMoney
              ?.amount ??
            order?.totalPriceSet
              ?.shopMoney
              ?.amount ??
            null,
          currency:
            order?.currentTotalPriceSet
              ?.shopMoney
              ?.currencyCode ??
            order?.totalPriceSet
              ?.shopMoney
              ?.currencyCode ??
            null,
        });

      console.log(
        `ALO NOW Staff Push: ${order.name}`,
        pushResult
      );
    } catch (error) {
      console.error(
        `ALO NOW Staff Push fehlgeschlagen: ${order.name}`,
        error
      );
    }

    console.log(
      `ALO NOW Pipeline bereit: ${order.name}`,
      {
        deliveryId:
          delivery.id,
        deliveryStatus:
          delivery.delivery_status,
        workspace:
          delivery.fulfillment_workspace,
        workflowStatus:
          workflow.pack_status,
        packingSlipId:
          packingSlip.id,
        invoiceId:
          invoice.id,
      }
    );

    return {
      skipped: false,
      orderId:
        order.id,
      orderName:
        order.name,
      fulfillmentType:
        "ALO_NOW",
      delivery: {
        id:
          delivery.id,
        status:
          delivery.delivery_status,
        workspace:
          delivery.fulfillment_workspace,
        requiresAgeCheck:
          delivery.requires_age_check,
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
      workflow: {
        status:
          workflow.pack_status,
      },
      printJobs: {
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
      storedLabel.id,
      "Brother QL-1110NWB"
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
      packingSlip.id,
      "HP7C4D8F71B318(HP Color Laser MFP 178 179)"
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
      invoice.id,
      "HP7C4D8F71B318(HP Color Laser MFP 178 179)"
    );


  // ----------------------------------------------------------
  // 7. FULFILLMENT BEWUSST NOCH NICHT AUSLÖSEN
  //
  // orders/paid bedeutet nur:
  // - Zahlung bestätigt
  // - Versanddokumente vorbereitet
  // - Printjobs angelegt
  //
  // Shopify Fulfillment + Swiss Post Tracking werden erst
  // nach dem operativen Packprozess bei READY_TO_SHIP
  // serverseitig ausgelöst.
  // ----------------------------------------------------------

  const workflow =
    await ensureOrderFulfillmentWorkflow(
      order.id
    );

  const trackingSync = {
    ok: false as const,
    pending: true as const,
    reason: "WAITING_FOR_READY_TO_SHIP",
  };

  try {
    const pushResult =
      await sendNewOrderStaffPush({
        orderId: order.id,
        orderName: order.name,
        totalAmount:
          order?.currentTotalPriceSet
            ?.shopMoney
            ?.amount ??
          order?.totalPriceSet
            ?.shopMoney
            ?.amount ??
          null,
        currency:
          order?.currentTotalPriceSet
            ?.shopMoney
            ?.currencyCode ??
          order?.totalPriceSet
            ?.shopMoney
            ?.currencyCode ??
          null,
      });

    console.log(
      `ALO STAFF Push: ${order.name}`,
      pushResult
    );
  } catch (error) {
    console.error(
      `ALO STAFF Push fehlgeschlagen: ${order.name}`,
      error
    );
  }


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
      workflowStatus:
        workflow.pack_status,
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


    trackingSync,

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

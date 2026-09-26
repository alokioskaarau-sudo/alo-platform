import { Router } from "express";
import { PDFDocument } from "pdf-lib";
import { db } from "../database/db.js";
import {
  getShopifyOrderById,
  getShopifyOrdersByIds,
  getLatestShopifyOrders,
} from "../integrations/shopify/orders.js";

import {
  fulfillShopifyOrderWithSwissPostTracking,
} from "../modules/shipping/fulfillment.service.js";
import {
  syncOrderPackItems,
  adjustOrderPackItem,
  getOrderPackItems,
  isOrderFullyPacked,
} from "../database/orderPackItems.js";

import {
  getStaffUser,
  requireStaffAuth,
} from "../middleware/staffAuth.js";

import {
  getOrderDashboard,
  createManualReprintJob,
  getStaffInvoicesByPeriod,
  getStaffInvoicesByIds,
} from "../database/shippingDashboard.js";
import {
  claimOrderForPacking,
  releaseOrderClaim,
  setOrderPackStatus,
  getOrderFulfillmentWorkflows,
  getOrderFulfillmentWorkflow,
  type OrderPackStatus,
} from "../database/orderFulfillmentWorkflow.js";
import {
  getAloNowDelivery,
  markAloNowReadyForPickup,
} from "../database/aloNowDeliveries.js";
import {
  getOrderFulfillmentType,
} from "../modules/orders/orderFulfillmentType.js";

const router = Router();

type OperationalOrderStatus =
  | "NEW"
  | "PACKING"
  | "PACKED"
  | "READY_TO_SHIP"
  | "COMPLETED"
  | "CANCELLED";

function getOperationalOrderStatus(
  shopify: any,
  workflow: {
    pack_status: OrderPackStatus;
  } | null,
  dashboardStatus?: string | null
): OperationalOrderStatus {
  if (shopify?.cancelledAt) {
    return "CANCELLED";
  }

  const fulfillmentStatus =
    String(
      shopify?.displayFulfillmentStatus ?? ""
    ).toUpperCase();

  if (fulfillmentStatus === "FULFILLED") {
    return "COMPLETED";
  }

  if (workflow?.pack_status === "COMPLETED") {
    return "COMPLETED";
  }

  if (workflow) {
    return workflow.pack_status;
  }

  if (
    String(
      dashboardStatus ?? ""
    ).toUpperCase() === "COMPLETED"
  ) {
    return "COMPLETED";
  }

  return "NEW";
}


/*
 * ALO STAFF â€“ BESTELLMANAGER
 *
 * Eigene Staff-API.
 * Verwendet dieselben Bestelldaten wie die bestehende
 * Bestellzentrale, aber mit Staff-Bearer-Authentifizierung.
 */

router.get(
  "/",
  requireStaffAuth,
  async (_req, res) => {
    try {
      const staffUser =
        getStaffUser(res);

      /*
       * ========================================================
       * SHOPIFY = SOURCE OF TRUTH FUER DIE OPERATIVE ORDER QUEUE
       * ========================================================
       *
       * Die Staff-App darf NICHT aus historischen Dashboard-
       * Eintraegen aufgebaut werden.
       *
       * Shopify liefert die aktuellen Orders.
       * Dashboard + Workflow reichern diese nur an.
       */
      const latestShopifyOrders =
        await getLatestShopifyOrders(50);

      const shopifyOrderIds =
        latestShopifyOrders
          .map((order: any) =>
            String(order?.id || "").trim()
          )
          .filter(Boolean);

      const [
        workflows,
        dashboardOrders,
      ] = await Promise.all([
        getOrderFulfillmentWorkflows(
          shopifyOrderIds
        ),
        getOrderDashboard(500),
      ]);

      const workflowByOrderId =
        new Map(
          workflows.map((workflow) => [
            String(
              workflow.shopify_order_id
            ),
            workflow,
          ])
        );

      const dashboardByOrderId =
        new Map(
          dashboardOrders.map((order) => [
            String(
              order.shopify_order_id
            ),
            order,
          ])
        );

      const orders =
        latestShopifyOrders.map(
          (shopify: any) => {
            const orderId =
              String(shopify.id);

            const dashboard =
              dashboardByOrderId.get(
                orderId
              ) ?? null;

            const workflow =
              workflowByOrderId.get(
                orderId
              ) ?? null;

            const fulfillmentStatus =
              String(
                shopify
                  ?.displayFulfillmentStatus ??
                  ""
              ).toUpperCase();

            const financialStatus =
              String(
                shopify
                  ?.displayFinancialStatus ??
                  ""
              ).toUpperCase();

            const cancelled =
              Boolean(
                shopify?.cancelledAt
              );

            const operationalStatus =
              getOperationalOrderStatus(
                shopify,
                workflow,
                dashboard
                  ?.dashboard_status ??
                  null
              );

            const shopifyName =
              String(
                shopify?.name ?? ""
              ).trim();

            /*
             * Wichtig:
             * Die App erwartet u.a. name und order_number.
             * Niemals die Shopify GID als sichtbare
             * Bestellnummer verwenden, wenn Shopify.name
             * vorhanden ist.
             */
            return {
              ...(dashboard ?? {}),

              shopify_order_id:
                orderId,

              shopify_order_name:
                shopifyName || null,

              name:
                shopifyName || null,

              order_number:
                shopifyName || null,

              order_created_at:
                shopify?.createdAt
                  ? new Date(
                      shopify.createdAt
                    )
                  : dashboard
                      ?.order_created_at ??
                    null,

              latest_created_at:
                shopify?.createdAt
                  ? new Date(
                      shopify.createdAt
                    )
                  : dashboard
                      ?.latest_created_at ??
                    null,

              dashboard_status:
                dashboard
                  ?.dashboard_status ??
                "CURRENT",

              is_archived:
                dashboard
                  ?.is_archived ??
                false,

              is_test:
                dashboard
                  ?.is_test ??
                false,

              archived_at:
                dashboard
                  ?.archived_at ??
                null,

              fulfillment_workflow:
                workflow,

              /*
               * Alias fuer bestehende App-Versionen.
               */
              workflow,

              operational_status:
                operationalStatus,

              financial_status:
                financialStatus,

              fulfillment_status:
                fulfillmentStatus,

              shopify_status: {
                financial_status:
                  financialStatus,

                fulfillment_status:
                  fulfillmentStatus,

                cancelled,

                cancelled_at:
                  shopify?.cancelledAt ??
                  null,

                closed_at:
                  shopify?.closedAt ??
                  null,

                exists: true,
              },
            };
          }
        );

      /*
       * Nur operative Bestellungen an die Staff-App.
       *
       * COMPLETED / CANCELLED / ARCHIVED gehoeren nicht
       * in die aktuelle Packqueue.
       */
      const activeOrders =
        orders.filter((order: any) => {
          const status =
            String(
              order.operational_status ||
                ""
            ).toUpperCase();

          const dashboardStatus =
            String(
              order.dashboard_status ||
                ""
            ).toUpperCase();

          if (
            status === "COMPLETED" ||
            status === "CANCELLED"
          ) {
            return false;
          }

          if (
            dashboardStatus ===
            "ARCHIVED"
          ) {
            return false;
          }

          return true;
        });

      /*
       * Neueste zuerst.
       */
      activeOrders.sort(
        (a: any, b: any) => {
          const aTime =
            new Date(
              a.order_created_at ||
                a.latest_created_at ||
                0
            ).getTime();

          const bTime =
            new Date(
              b.order_created_at ||
                b.latest_created_at ||
                0
            ).getTime();

          return bTime - aTime;
        }
      );

      const stats = {
        total:
          activeOrders.length,

        current:
          activeOrders.length,

        completed:
          0,

        error:
          activeOrders.filter(
            (order: any) =>
              String(
                order.dashboard_status ||
                  ""
              ).toUpperCase() ===
              "ERROR"
          ).length,

        archived:
          0,
      };

      console.log(
        "[STAFF ORDERS] ACTIVE SHOPIFY QUEUE",
        activeOrders.map(
          (order: any) => ({
            id:
              order.shopify_order_id,
            name:
              order.name,
            status:
              order.operational_status,
            fulfillment:
              order.fulfillment_status,
          })
        )
      );

      return res.json({
        ok: true,

        staff: {
          id:
            staffUser.id,

          displayName:
            staffUser.displayName,

          role:
            staffUser.role,
        },

        stats,

        orders:
          activeOrders,
      });
    } catch (error) {
      console.error(
        "STAFF ORDERS LIST ERROR",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          "Bestellungen konnten nicht geladen werden.",
      });
    }
  }
);

/*
 * Bestellung zum Packen Ã¼bernehmen.
 *
 * Die Staff-ID kommt ausschliesslich aus dem
 * authentifizierten Bearer-Token.
 */

/*
 * ALO STAFF â€“ BESTELLDETAIL
 *
 * FÃ¼hrt Shopify-Bestelldaten, technische Dokumentdaten
 * der Bestellzentrale und den operativen Packworkflow
 * in einer Antwort zusammen.
 *
 * Read-only:
 * - kein Label
 * - kein Fulfillment
 * - kein Druckjob
 * - keine StatusÃ¤nderung
 */

// ==========================================================
// STAFF INVOICE CENTER
// ==========================================================

function parseInvoiceDate(
  value: unknown
): Date | null {
  const raw =
    String(value ?? "").trim();

  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(raw)
  ) {
    return null;
  }

  const date =
    new Date(`${raw}T00:00:00.000Z`);

  if (
    Number.isNaN(date.getTime())
  ) {
    return null;
  }

  return date;
}


router.get(
  "/invoices",
  requireStaffAuth,
  async (req, res) => {
    try {
      const from =
        parseInvoiceDate(
          req.query.from
        );

      const to =
        parseInvoiceDate(
          req.query.to
        );

      if (!from || !to) {
        return res.status(400).json({
          ok: false,
          error: "INVALID_DATE_RANGE",
        });
      }

      if (
        from.getTime() >
        to.getTime()
      ) {
        return res.status(400).json({
          ok: false,
          error: "INVALID_DATE_RANGE",
        });
      }

      const toExclusive =
        new Date(to);

      toExclusive.setUTCDate(
        toExclusive.getUTCDate() + 1
      );

      const invoices =
        await getStaffInvoicesByPeriod(
          from,
          toExclusive
        );

      const totals =
        invoices.reduce<
          Record<string, number>
        >(
          (acc, invoice) => {
            const currency =
              invoice.currency || "CHF";

            const amount =
              Number(
                invoice.total_amount ??
                  0
              );

            acc[currency] =
              (acc[currency] ?? 0) +
              (
                Number.isFinite(amount)
                  ? amount
                  : 0
              );

            return acc;
          },
          {}
        );

      return res.json({
        ok: true,
        from:
          String(req.query.from),
        to:
          String(req.query.to),
        count: invoices.length,
        totals,
        invoices,
      });
    } catch (error: any) {
      console.error(
        "STAFF INVOICE LIST ERROR",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          "INVOICE_LIST_FAILED",
      });
    }
  }
);


router.post(
  "/invoices/print",
  requireStaffAuth,
  async (req, res) => {
    try {
      const invoiceIds: string[] =
        Array.isArray(
          req.body?.invoiceIds
        )
          ? req.body.invoiceIds
              .map((id: unknown) =>
                String(id).trim()
              )
              .filter(Boolean)
          : [];

      const uniqueIds: string[] =
        Array.from(
          new Set<string>(invoiceIds)
        );

      if (
        uniqueIds.length === 0
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "NO_INVOICES_SELECTED",
        });
      }

      if (
        uniqueIds.length > 500
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "TOO_MANY_INVOICES",
        });
      }

      const invoices =
        await getStaffInvoicesByIds(
          uniqueIds
        );

      const foundIds =
        new Set(
          invoices.map(
            (invoice) =>
              String(invoice.id)
          )
        );

      const missingIds =
        uniqueIds.filter(
          (id) =>
            !foundIds.has(
              String(id)
            )
        );

      if (
        missingIds.length > 0
      ) {
        return res.status(409).json({
          ok: false,
          error:
            "INVOICES_NOT_AVAILABLE",
          missingIds,
        });
      }

      const results = [];

      for (
        const invoice of invoices
      ) {
        const result =
          await createManualReprintJob(
            "INVOICE",
            String(invoice.id)
          );

        results.push({
          invoiceId:
            String(invoice.id),
          invoiceNumber:
            invoice.invoice_number,
          result,
        });
      }

      return res.json({
        ok: true,
        count: results.length,
        results,
      });
    } catch (error: any) {
      console.error(
        "STAFF INVOICE BATCH PRINT ERROR",
        error
      );

      return res.status(400).json({
        ok: false,
        error:
          "INVOICE_BATCH_PRINT_FAILED",
        message:
          error?.message ??
          String(error),
      });
    }
  }
);


router.post(
  "/invoices/pdf",
  requireStaffAuth,
  async (req, res) => {
    try {
      const invoiceIds: string[] =
        Array.isArray(
          req.body?.invoiceIds
        )
          ? req.body.invoiceIds
              .map((id: unknown) =>
                String(id).trim()
              )
              .filter(Boolean)
          : [];

      const uniqueIds: string[] =
        Array.from(
          new Set<string>(invoiceIds)
        );

      if (
        uniqueIds.length === 0
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "NO_INVOICES_SELECTED",
        });
      }

      if (
        uniqueIds.length > 500
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "TOO_MANY_INVOICES",
        });
      }

      const invoices =
        await getStaffInvoicesByIds(
          uniqueIds
        );

      const foundIds =
        new Set(
          invoices.map(
            (invoice) =>
              String(invoice.id)
          )
        );

      const missingIds =
        uniqueIds.filter(
          (id) =>
            !foundIds.has(
              String(id)
            )
        );

      if (
        missingIds.length > 0
      ) {
        return res.status(409).json({
          ok: false,
          error:
            "INVOICES_NOT_AVAILABLE",
          missingIds,
        });
      }

      const merged =
        await PDFDocument.create();

      for (
        const invoice of invoices
      ) {
        const bytes =
          Buffer.from(
            invoice.pdf_base64,
            "base64"
          );

        const source =
          await PDFDocument.load(
            bytes
          );

        const pages =
          await merged.copyPages(
            source,
            source.getPageIndices()
          );

        for (
          const page of pages
        ) {
          merged.addPage(page);
        }
      }

      if (
        merged.getPageCount() === 0
      ) {
        return res.status(409).json({
          ok: false,
          error:
            "EMPTY_INVOICE_PDF",
        });
      }

      const pdfBytes =
        await merged.save();

      const date =
        new Date()
          .toISOString()
          .slice(0, 10);

      const filename =
        `ALO-Rechnungen-${date}.pdf`;

      res.setHeader(
        "Content-Type",
        "application/pdf"
      );

      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`
      );

      res.setHeader(
        "Content-Length",
        String(pdfBytes.length)
      );

      return res.send(
        Buffer.from(pdfBytes)
      );
    } catch (error: any) {
      console.error(
        "STAFF INVOICE PDF ERROR",
        error
      );

      return res.status(400).json({
        ok: false,
        error:
          "INVOICE_PDF_FAILED",
        message:
          error?.message ??
          String(error),
      });
    }
  }
);


router.get(
  "/:orderId",
  requireStaffAuth,
  async (req, res) => {
    try {
      const orderId = String(
        req.params.orderId || ""
      ).trim();

      if (!orderId) {
        return res.status(400).json({
          ok: false,
          error: "ORDER_ID_REQUIRED",
        });
      }

      let shopifyOrder;
      let dashboardOrders;
      let workflow;

      try {
        console.log(
          "[ORDER DETAIL] SHOPIFY START",
          orderId
        );

        shopifyOrder =
          await getShopifyOrderById(
            orderId
          );

        console.log(
          "[ORDER DETAIL] SHOPIFY OK",
          orderId
        );
      } catch (error) {
        console.error(
          "[ORDER DETAIL] SHOPIFY FAILED",
          orderId,
          error
        );
        throw error;
      }

      try {
        console.log(
          "[ORDER DETAIL] DASHBOARD START",
          orderId
        );

        dashboardOrders =
          await getOrderDashboard(500);

        console.log(
          "[ORDER DETAIL] DASHBOARD OK",
          orderId
        );
      } catch (error) {
        console.error(
          "[ORDER DETAIL] DASHBOARD FAILED",
          orderId,
          error
        );
        throw error;
      }

      try {
        console.log(
          "[ORDER DETAIL] WORKFLOW START",
          orderId
        );

        workflow =
          await getOrderFulfillmentWorkflow(
            orderId
          );

        console.log(
          "[ORDER DETAIL] WORKFLOW OK",
          orderId
        );
      } catch (error) {
        console.error(
          "[ORDER DETAIL] WORKFLOW FAILED",
          orderId,
          error
        );
        throw error;
      }

      if (!shopifyOrder) {
        return res.status(404).json({
          ok: false,
          error: "ORDER_NOT_FOUND",
        });
      }

      const normalizedOrderId =
        String(shopifyOrder.id);

      const dashboardOrder =
        dashboardOrders.find(
          (order) =>
            order.shopify_order_id ===
            normalizedOrderId
        ) ?? null;

      const lineItems =
        (
          shopifyOrder.lineItems?.edges ??
          []
        ).map(
          (edge: any) => edge.node
        );

      let packItems;

      try {
        console.log(
          "[ORDER DETAIL] PACK SYNC START",
          normalizedOrderId,
          "items:",
          lineItems.length
        );

        packItems =
          await syncOrderPackItems(
            normalizedOrderId,
            lineItems
          );

        console.log(
          "[ORDER DETAIL] PACK SYNC OK",
          normalizedOrderId,
          "items:",
          packItems.length
        );
      } catch (error) {
        console.error(
          "[ORDER DETAIL] PACK SYNC FAILED",
          normalizedOrderId,
          error
        );
        throw error;
      }

      /*
       * Shopify liefert Produkt-Metadaten.
       * PostgreSQL liefert den Packzustand.
       *
       * Beide werden ueber die Shopify Line Item ID verbunden.
       */
      const enrichedPackItems =
        packItems.map((packItem: any) => {
          const shopifyLineItem =
            lineItems.find((lineItem: any) =>
              String(lineItem?.id || "") ===
              String(
                packItem?.shopify_line_item_id || ""
              )
            ) ?? null;

          const variantImageUrl =
            shopifyLineItem?.variant?.image?.url ??
            null;

          const productImageUrl =
            shopifyLineItem?.variant?.product
              ?.featuredImage?.url ??
            null;

          const imageUrl =
            variantImageUrl ||
            productImageUrl ||
            null;

          return {
            ...packItem,

            image_url:
              imageUrl,

            imageUrl:
              imageUrl,

            variant_image_url:
              variantImageUrl,

            product_image_url:
              productImageUrl,

            variant_id:
              shopifyLineItem?.variant?.id ??
              null,

            product_id:
              shopifyLineItem?.variant?.product?.id ??
              null,

            sku:
              shopifyLineItem?.sku ??
              packItem?.sku ??
              null,

            variant_title:
              shopifyLineItem?.variant?.title ??
              packItem?.variant_title ??
              null,

            product_title:
              shopifyLineItem?.variant?.product?.title ??
              packItem?.title ??
              null,
          };
        });

      console.log(
        "[ORDER DETAIL] PRODUCT IMAGES",
        enrichedPackItems.map((item: any) => ({
          id:
            item.shopify_line_item_id,

          title:
            item.title,

          image:
            item.image_url,
        }))
      );

      const packProgress =
        enrichedPackItems.reduce(
          (
            progress,
            item
          ) => {
            progress.expected +=
              item.expected_quantity;

            progress.packed +=
              item.packed_quantity;

            return progress;
          },
          {
            expected: 0,
            packed: 0,
          }
        );

      const packComplete =
        packProgress.expected > 0 &&
        packProgress.packed ===
          packProgress.expected;

      const operationalStatus =
        getOperationalOrderStatus(
          shopifyOrder,
          workflow
        );

      return res.json({
        ok: true,

        order: {
          ...shopifyOrder,

          operational_status:
            operationalStatus,

          lineItems,

          pack_items:
            enrichedPackItems,

          pack_progress: {
            packed:
              packProgress.packed,
            expected:
              packProgress.expected,
            complete:
              packComplete,
          },

          fulfillment_workflow:
            workflow,

          dashboard:
            dashboardOrder,
        },
      });
    } catch (error) {
      console.error(
        "STAFF ORDER DETAIL ERROR",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          "Bestelldetails konnten nicht geladen werden.",
      });
    }
  }
);


router.post(
  "/:orderId/claim",
  requireStaffAuth,
  async (req, res) => {
    try {
      const staffUser = getStaffUser(res);
      const orderId = String(
        req.params.orderId || ""
      ).trim();

      if (!orderId) {
        return res.status(400).json({
          ok: false,
          error: "ORDER_ID_REQUIRED",
        });
      }

      const result =
        await claimOrderForPacking(
          orderId,
          staffUser.id
        );

      if (!result.ok) {
        return res.status(409).json({
          ok: false,
          error: "ORDER_ALREADY_CLAIMED",
          workflow: result.workflow,
        });
      }

      return res.json({
        ok: true,
        alreadyClaimedByMe:
          result.alreadyClaimedByMe,
        workflow: result.workflow,
      });
    } catch (error) {
      console.error(
        "STAFF ORDER CLAIM ERROR",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          "Bestellung konnte nicht Ã¼bernommen werden.",
      });
    }
  }
);


/*
 * Eigene Ãœbernahme wieder freigeben.
 *
 * releaseOrderClaim() erlaubt das nur dem
 * Mitarbeiter, der die Bestellung besitzt.
 */
router.post(
  "/:orderId/release",
  requireStaffAuth,
  async (req, res) => {
    try {
      const staffUser = getStaffUser(res);
      const orderId = String(
        req.params.orderId || ""
      ).trim();

      if (!orderId) {
        return res.status(400).json({
          ok: false,
          error: "ORDER_ID_REQUIRED",
        });
      }

      const workflow =
        await releaseOrderClaim(
          orderId,
          staffUser.id
        );

      if (!workflow) {
        return res.status(409).json({
          ok: false,
          error:
            "ORDER_RELEASE_NOT_ALLOWED",
        });
      }

      return res.json({
        ok: true,
        workflow,
      });
    } catch (error) {
      console.error(
        "STAFF ORDER RELEASE ERROR",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          "Bestellung konnte nicht freigegeben werden.",
      });
    }
  }
);


/*
 * Operativen Packstatus Ã¤ndern.
 *
 * Dieser Status ist bewusst getrennt vom
 * dashboard_status der Bestellzentrale.
 */

/*
 * Einzelne Packposition atomar +1 / -1.
 *
 * Nur der Mitarbeiter, der die Bestellung
 * Ã¼bernommen hat, darf Packmengen verÃ¤ndern.
 */
router.post(
  "/:orderId/items/:lineItemId/adjust",
  requireStaffAuth,
  async (req, res) => {
    try {
      const staffUser = getStaffUser(res);

      const orderId = String(
        req.params.orderId || ""
      ).trim();

      const lineItemId = String(
        req.params.lineItemId || ""
      ).trim();

      const delta =
        Number(req.body?.delta);

      if (!orderId || !lineItemId) {
        return res.status(400).json({
          ok: false,
          error: "ORDER_OR_ITEM_ID_REQUIRED",
        });
      }

      if (delta !== 1 && delta !== -1) {
        return res.status(400).json({
          ok: false,
          error: "INVALID_PACK_DELTA",
          allowed: [1, -1],
        });
      }

      const result =
        await adjustOrderPackItem(
          orderId,
          lineItemId,
          staffUser.id,
          delta
        );

      if (!result.ok) {
        const status =
          result.reason === "ITEM_NOT_FOUND"
            ? 404
            : 409;

        return res.status(status).json({
          ok: false,
          error: result.reason,
        });
      }

      const packItems =
        await getOrderPackItems(orderId);

      const progress =
        packItems.reduce(
          (
            value,
            item
          ) => {
            value.expected +=
              item.expected_quantity;

            value.packed +=
              item.packed_quantity;

            return value;
          },
          {
            expected: 0,
            packed: 0,
          }
        );

      return res.json({
        ok: true,

        item: result.item,

        pack_progress: {
          packed:
            progress.packed,

          expected:
            progress.expected,

          complete:
            progress.expected > 0 &&
            progress.packed ===
              progress.expected,
        },
      });
    } catch (error) {
      console.error(
        "STAFF PACK ITEM ADJUST ERROR",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          "Packmenge konnte nicht geÃ¤ndert werden.",
      });
    }
  }
);


router.patch(
  "/:orderId/status",
  requireStaffAuth,
  async (req, res) => {
    try {
      const staffUser = getStaffUser(res);
      const orderId = String(
        req.params.orderId || ""
      ).trim();

      if (!orderId) {
        return res.status(400).json({
          ok: false,
          error: "ORDER_ID_REQUIRED",
        });
      }

      // NEW -> PACKING wird ausschlieÃŸlich durch
      // POST /:orderId/claim ausgelÃ¶st.
      //
      // Die Status-API darf nur die nachfolgenden
      // operativen Schritte auslÃ¶sen.
      const allowedStatuses:
        OrderPackStatus[] = [
          "PACKED",
          "READY_TO_SHIP",
          ];

      const status = String(
        req.body?.status || ""
      ).trim() as OrderPackStatus;

      if (!allowedStatuses.includes(status)) {
        return res.status(400).json({
          ok: false,
          error: "INVALID_PACK_STATUS",
          allowedStatuses,
        });
      }

      if (
        status === "PACKED" ||
        status === "READY_TO_SHIP"
      ) {
        const fullyPacked =
          await isOrderFullyPacked(
            orderId
          );

        if (!fullyPacked) {
          const packItems =
            await getOrderPackItems(
              orderId
            );

          const progress =
            packItems.reduce(
              (
                value,
                item
              ) => {
                value.expected +=
                  item.expected_quantity;

                value.packed +=
                  item.packed_quantity;

                return value;
              },
              {
                expected: 0,
                packed: 0,
              }
            );

          return res.status(409).json({
            ok: false,
            error:
              "ORDER_NOT_FULLY_PACKED",

            pack_progress: {
              packed:
                progress.packed,

              expected:
                progress.expected,

              complete: false,
            },
          });
        }
      }

      let workflow =
        await getOrderFulfillmentWorkflow(
          orderId
        );

      if (!workflow) {
        return res.status(409).json({
          ok: false,
          error:
            "ORDER_WORKFLOW_NOT_FOUND",
        });
      }

      // ------------------------------------------------------
      // PACKED
      // ------------------------------------------------------

      if (status === "PACKED") {
        let packedWorkflow =
          workflow;

        if (
          workflow.pack_status !==
          "PACKED"
        ) {
          const transitionedWorkflow =
            await setOrderPackStatus(
              orderId,
              staffUser.id,
              "PACKED"
            );

          if (!transitionedWorkflow) {
            return res.status(409).json({
              ok: false,
              error:
                "ORDER_STATUS_CHANGE_NOT_ALLOWED",
            });
          }

          packedWorkflow =
            transitionedWorkflow;
        } else if (
          workflow.claimed_by_staff_user_id !==
          staffUser.id
        ) {
          return res.status(409).json({
            ok: false,
            error:
              "ORDER_NOT_CLAIMED_BY_STAFF",
          });
        }

        const shopifyOrder =
          await getShopifyOrderById(
            orderId
          );

        if (!shopifyOrder) {
          return res.status(502).json({
            ok: false,
            error:
              "SHOPIFY_ORDER_NOT_FOUND",
            workflow:
              packedWorkflow,
            retryable: true,
          });
        }

        const fulfillmentType =
          getOrderFulfillmentType(
            shopifyOrder
          );

        if (
          fulfillmentType === "ALO_NOW"
        ) {
          const delivery =
            await getAloNowDelivery(
              orderId
            );

          if (!delivery) {
            return res.status(409).json({
              ok: false,
              error:
                "ALO_NOW_DELIVERY_NOT_FOUND",
              workflow:
                packedWorkflow,
              retryable: true,
            });
          }

          if (
            delivery.delivery_status ===
              "DRIVER_ASSIGNED" ||
            delivery.delivery_status ===
              "READY_FOR_PICKUP" ||
            delivery.delivery_status ===
              "PICKED_UP" ||
            delivery.delivery_status ===
              "ON_THE_WAY" ||
            delivery.delivery_status ===
              "DELIVERED"
          ) {
            const readyResult =
              await markAloNowReadyForPickup(
                orderId
              );

            if (!readyResult.ok) {
              return res.status(409).json({
                ok: false,
                error:
                  "ALO_NOW_READY_FOR_PICKUP_FAILED",
                reason:
                  readyResult.reason,
                workflow:
                  packedWorkflow,
                delivery:
                  readyResult.delivery,
                retryable: true,
              });
            }

            return res.json({
              ok: true,
              fulfillmentType:
                "ALO_NOW",
              workflow:
                packedWorkflow,
              delivery:
                readyResult.delivery,
            });
          }

          if (
            delivery.delivery_status ===
            "WAITING_FOR_DRIVER"
          ) {
            return res.json({
              ok: true,
              fulfillmentType:
                "ALO_NOW",
              workflow:
                packedWorkflow,
              delivery,
            });
          }

          return res.status(409).json({
            ok: false,
            error:
              "ALO_NOW_INVALID_DELIVERY_STATUS",
            workflow:
              packedWorkflow,
            delivery,
            retryable: true,
          });
        }

        return res.json({
          ok: true,
          fulfillmentType,
          workflow:
            packedWorkflow,
        });
      }

      // ------------------------------------------------------
      // READY_TO_SHIP
      //
      // Erster Versuch:
      // PACKED -> READY_TO_SHIP
      //
      // Retry:
      // Ist die Order bereits READY_TO_SHIP, wird die
      // Transition nicht erneut ausgefÃ¼hrt. Stattdessen wird
      // direkt der idempotente Shopify-Fulfillment-Schritt
      // erneut versucht.
      // ------------------------------------------------------

      const readyToShipShopifyOrder =
        await getShopifyOrderById(
          orderId
        );

      if (!readyToShipShopifyOrder) {
        return res.status(502).json({
          ok: false,
          error:
            "SHOPIFY_ORDER_NOT_FOUND",
          workflow,
          retryable: true,
        });
      }

      const readyToShipFulfillmentType =
        getOrderFulfillmentType(
          readyToShipShopifyOrder
        );

      if (
        readyToShipFulfillmentType ===
        "ALO_NOW"
      ) {
        return res.status(409).json({
          ok: false,
          error:
            "ALO_NOW_READY_TO_SHIP_NOT_ALLOWED",
          fulfillmentType:
            "ALO_NOW",
          workflow,
          retryable: false,
        });
      }

      if (
        workflow.pack_status !==
        "READY_TO_SHIP"
      ) {
        const readyWorkflow =
          await setOrderPackStatus(
            orderId,
            staffUser.id,
            "READY_TO_SHIP"
          );

        if (!readyWorkflow) {
          return res.status(409).json({
            ok: false,
            error:
              "ORDER_STATUS_CHANGE_NOT_ALLOWED",
          });
        }

        workflow =
          readyWorkflow;
      } else if (
        workflow.claimed_by_staff_user_id !==
        staffUser.id
      ) {
        return res.status(409).json({
          ok: false,
          error:
            "ORDER_NOT_CLAIMED_BY_STAFF",
        });
      }

      // ------------------------------------------------------
      // SHOPIFY + SWISS POST TRACKING
      //
      // Pro Order darf immer nur EIN Fulfillment-Versuch
      // gleichzeitig laufen.
      // ------------------------------------------------------

      const fulfillmentLockClient =
        await db.connect();

      const fulfillmentLockKey =
        `staff-order-fulfillment:${orderId}`;

      let fulfillmentLockAcquired =
        false;

      try {
        const lockResult =
          await fulfillmentLockClient.query(
            `
              SELECT pg_try_advisory_lock(
                hashtext($1)
              ) AS locked
            `,
            [
              fulfillmentLockKey,
            ]
          );

        fulfillmentLockAcquired =
          lockResult.rows[0]?.locked === true;

        if (!fulfillmentLockAcquired) {
          return res.status(409).json({
            ok: false,
            error:
              "ORDER_SHIPPING_IN_PROGRESS",
            workflow,
            retryable: true,
          });
        }

        // ----------------------------------------------------
        // Shopify IMMER frisch lesen.
        //
        // Wichtig fÃ¼r Retry-FÃ¤lle:
        // Falls Shopify bereits fulfilled wurde, aber unser
        // lokales COMPLETED danach fehlgeschlagen ist, darf
        // kein zweites Fulfillment erstellt werden.
        // ----------------------------------------------------

        let shopifyOrder =
          await getShopifyOrderById(
            orderId
          );

        if (!shopifyOrder) {
          return res.status(502).json({
            ok: false,
            error:
              "SHOPIFY_ORDER_NOT_FOUND",
            workflow,
            retryable: true,
          });
        }

        if (
          String(
            shopifyOrder.displayFinancialStatus ??
              ""
          ).toUpperCase() !== "PAID"
        ) {
          return res.status(409).json({
            ok: false,
            error:
              "SHOPIFY_ORDER_NOT_PAID",
            workflow,
            retryable: false,
          });
        }

        let fulfillment: any = null;

        const alreadyFulfilled =
          String(
            shopifyOrder.displayFulfillmentStatus ??
              ""
          ).toUpperCase() === "FULFILLED";

        if (!alreadyFulfilled) {
          fulfillment =
            await fulfillShopifyOrderWithSwissPostTracking(
              shopifyOrder
            );

          // --------------------------------------------------
          // Niemals aufgrund des Helper-Returns alleine lokal
          // abschlieÃŸen. Shopify erneut laden und den echten
          // finalen Order-Status prÃ¼fen.
          // --------------------------------------------------

          shopifyOrder =
            await getShopifyOrderById(
              orderId
            );

          if (!shopifyOrder) {
            return res.status(502).json({
              ok: false,
              error:
                "SHOPIFY_ORDER_VERIFY_FAILED",
              workflow,
              fulfillment,
              retryable: true,
            });
          }
        }

        const verifiedFulfillmentStatus =
          String(
            shopifyOrder.displayFulfillmentStatus ??
              ""
          ).toUpperCase();

        if (
          verifiedFulfillmentStatus !==
          "FULFILLED"
        ) {
          return res.status(409).json({
            ok: false,
            error:
              "SHOPIFY_ORDER_NOT_FULLY_FULFILLED",
            shopifyFulfillmentStatus:
              verifiedFulfillmentStatus,
            workflow,
            fulfillment,
            retryable: true,
          });
        }

        // ----------------------------------------------------
        // Erst wenn Shopify nachweislich FULFILLED ist:
        // READY_TO_SHIP -> COMPLETED
        // ----------------------------------------------------

        const completedWorkflow =
          await setOrderPackStatus(
            orderId,
            staffUser.id,
            "COMPLETED"
          );

        if (!completedWorkflow) {
          return res.status(409).json({
            ok: false,
            error:
              "FULFILLMENT_COMPLETED_BUT_LOCAL_COMPLETION_FAILED",
            workflow,
            fulfillment,
            retryable: true,
          });
        }

        return res.json({
          ok: true,
          workflow:
            completedWorkflow,
          fulfillment,
          shopifyFulfillmentStatus:
            verifiedFulfillmentStatus,
        });

      } finally {
        if (fulfillmentLockAcquired) {
          try {
            await fulfillmentLockClient.query(
              `
                SELECT pg_advisory_unlock(
                  hashtext($1)
                )
              `,
              [
                fulfillmentLockKey,
              ]
            );
          } catch (unlockError) {
            console.error(
              "STAFF ORDER FULFILLMENT UNLOCK ERROR",
              {
                orderId,
                error:
                  unlockError,
              }
            );
          }
        }

        fulfillmentLockClient.release();
      }

    } catch (error) {
      console.error(
        "STAFF ORDER STATUS ERROR",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          "Bestellstatus konnte nicht geÃ¤ndert werden.",
      });
    }
  }
);


router.post(
  "/:orderId/reprint",
  requireStaffAuth,
  async (req, res) => {
    try {
      const orderId =
        String(req.params.orderId || "").trim();

      const documentType =
        String(req.body?.documentType || "")
          .trim()
          .toUpperCase();

      if (
        documentType !== "SHIPPING_LABEL" &&
        documentType !== "PACKING_SLIP" &&
        documentType !== "INVOICE"
      ) {
        return res.status(400).json({
          ok: false,
          error: "INVALID_DOCUMENT_TYPE",
        });
      }

      const dashboardOrders =
        await getOrderDashboard(500);

      const order =
        dashboardOrders.find(
          (item) =>
            item.shopify_order_id === orderId
        );

      if (!order) {
        return res.status(404).json({
          ok: false,
          error: "ORDER_NOT_FOUND",
        });
      }

      const documentId =
        documentType === "SHIPPING_LABEL"
          ? order.label_id
          : documentType === "PACKING_SLIP"
            ? order.packing_slip_id
            : order.invoice_id;

      if (!documentId) {
        return res.status(409).json({
          ok: false,
          error:
            documentType === "SHIPPING_LABEL"
              ? "SHIPPING_LABEL_NOT_AVAILABLE"
              : documentType === "PACKING_SLIP"
                ? "PACKING_SLIP_NOT_AVAILABLE"
                : "INVOICE_NOT_AVAILABLE",
        });
      }

      const result =
        await createManualReprintJob(
          documentType,
          documentId
        );

      return res.json({
        ok: true,
        documentType,
        documentId,
        result,
      });
    } catch (error: any) {
      console.error(
        "STAFF ORDER REPRINT ERROR",
        error
      );

      return res.status(400).json({
        ok: false,
        error:
          error?.message ||
          "REPRINT_FAILED",
      });
    }
  }
);

export default router;



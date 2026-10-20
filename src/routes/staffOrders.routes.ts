import { Router } from "express";
import { PDFDocument } from "pdf-lib";
import { db } from "../database/db.js";
import {
  getShopifyOrderById,
  getShopifyOrdersByIds,
  getLatestShopifyOrders,
  updateShopifyShippingAddress,
} from "../integrations/shopify/orders.js";

import { findShippingLabel } from "../database/shippingLabels.js";
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
  getStaffOrderChannel,
} from "../modules/orders/orderFulfillmentType.js";

// ALO_PICKUP_CONFIRM_IMPORTS_V1
import { fulfillShopifyPickupOrder } from "../modules/shipping/fulfillment.service.js";
import { isPickupOrderFullyPacked } from "../database/orderPackItems.js";

import { createSwissPostPreviewLabel } from "../integrations/swisspost/label.js";
import { splitSwissStreetAddress } from "../modules/shipping/shopifyShipping.js";
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

  // Ein lokaler Abschluss allein ist kein Shopify-Fulfillment.
  // Der Auftrag bleibt sichtbar, bis Shopify FULFILLED bestaetigt.
  if (workflow?.pack_status === "COMPLETED") {
    return "READY_TO_SHIP";
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
  async (req, res) => {
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
              // ALO_ORDER_CHANNEL_V1
              order_channel:
                getStaffOrderChannel(shopify),

              fulfillment_type:
                getStaffOrderChannel(shopify),



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

      // ALO_ORDER_CHANNEL_FILTER_V1
      // Kein Filter = bisherige API bleibt kompatibel.
      // ALO_UNKNOWN_QUEUE_V1
      const requestedChannel =
        typeof req.query.channel === "string"
          ? req.query.channel.trim().toUpperCase()
          : "";

      const allowedChannels = [
        "",
        "ALL",
        "SHIPPING",
        "ALO_NOW",
        "PICKUP",
          "UNKNOWN",
      ];

      if (!allowedChannels.includes(requestedChannel)) {
        return res.status(400).json({
          ok: false,
          error: "INVALID_ORDER_CHANNEL",
        });
      }

      const channelOrders =
        !requestedChannel || requestedChannel === "ALL"
          ? activeOrders
          : activeOrders.filter(
              (order: any) =>
                order.order_channel === requestedChannel
            );


      /*
       * Neueste zuerst.
       */
      channelOrders.sort(
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
          channelOrders.length,

        current:
          channelOrders.length,

        completed:
          0,

        error:
          channelOrders.filter(
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
        channelOrders.map(
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
          channelOrders,
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


// ALO_ORDER_ARCHIVE_SEARCH_V2
// Exact read-only archive lookup of existing documents, no 500-order dashboard limit.
// Customer names are not in these document tables: this endpoint searches order
// number/name and Shopify order ID only. It does NOT create a label or print job.
router.get('/archive-search', requireStaffAuth, async (req, res) => {
  try {
    const query = String(req.query.q ?? '').trim().slice(0, 100).replace(/^#/, '');
    if (query.length < 3) {
      return res.status(400).json({ok: false, error: 'SEARCH_QUERY_TOO_SHORT'});
    }
    const pattern = '%' + query.replace(/[\\%_]/g, '\\$&') + '%';
    const result = await db.query<{
      shopify_order_id: string;
      shopify_order_name: string | null;
      label_id: string | null;
      packing_slip_id: string | null;
      invoice_id: string | null;
    }>(`
      WITH matches AS (
        SELECT shopify_order_id FROM shipping_labels
          WHERE shopify_order_name ILIKE $1 ESCAPE '\\' OR shopify_order_id ILIKE $1 ESCAPE '\\'
        UNION
        SELECT shopify_order_id FROM packing_slips
          WHERE shopify_order_name ILIKE $1 ESCAPE '\\' OR shopify_order_id ILIKE $1 ESCAPE '\\'
        UNION
        SELECT shopify_order_id FROM invoices
          WHERE shopify_order_name ILIKE $1 ESCAPE '\\' OR shopify_order_id ILIKE $1 ESCAPE '\\'
      )
      SELECT m.shopify_order_id,
        COALESCE(sl.shopify_order_name, ps.shopify_order_name, iv.shopify_order_name) AS shopify_order_name,
        sl.id AS label_id, ps.id AS packing_slip_id, iv.id AS invoice_id
      FROM matches m
      LEFT JOIN LATERAL (
        SELECT id, shopify_order_name FROM shipping_labels
        WHERE shopify_order_id = m.shopify_order_id ORDER BY created_at DESC, id DESC LIMIT 1
      ) sl ON TRUE
      LEFT JOIN LATERAL (
        SELECT id, shopify_order_name FROM packing_slips
        WHERE shopify_order_id = m.shopify_order_id ORDER BY created_at DESC, id DESC LIMIT 1
      ) ps ON TRUE
      LEFT JOIN LATERAL (
        SELECT id, shopify_order_name FROM invoices
        WHERE shopify_order_id = m.shopify_order_id ORDER BY created_at DESC, id DESC LIMIT 1
      ) iv ON TRUE
      ORDER BY CASE WHEN REPLACE(COALESCE(sl.shopify_order_name, ps.shopify_order_name, iv.shopify_order_name, ''), '#', '')
                         ILIKE $2 THEN 0 ELSE 1 END,
               m.shopify_order_id DESC
      LIMIT 40
    `, [pattern, query]);
    const orders = result.rows.map(row => ({
      id: String(row.shopify_order_id),
      orderNumber: String(row.shopify_order_name ?? ''),
      customerName: '',
      status: 'ARCHIVED_DOCUMENT',
      hasShippingLabel: Boolean(row.label_id),
      hasPackingSlip: Boolean(row.packing_slip_id),
      hasInvoice: Boolean(row.invoice_id)
    }));
    return res.json({ok: true, orders, scope: 'document_archive', searched: orders.length});
  } catch (error) {
    console.error('STAFF ARCHIVE SEARCH V2 ERROR', error);
    return res.status(500).json({ok: false, error: 'ARCHIVE_SEARCH_FAILED'});
  }
});

// ALO_LIVE_PACK_READONLY_V2
// Staff-authentifiziert, nur lesend.
// Vor /:orderId registrieren.
router.get(
  "/live/packing",
  requireStaffAuth,
  async (_req, res) => {
    try {
      const latest = await getLatestShopifyOrders(50);

      const active = latest.filter((order: any) => {
        const fulfilled = String(
          order?.displayFulfillmentStatus ?? ""
        ).toUpperCase();

        return !order?.cancelledAt &&
          fulfilled !== "FULFILLED";
      });

      const orderIds: string[] = Array.from(
        new Set<string>(
          active
            .map((order: any): string =>
              String(order?.id ?? "").trim()
            )
            .filter((id: string) => id.length > 0)
        )
      );

      if (orderIds.length === 0) {
        res.setHeader("Cache-Control", "no-store");
        return res.json({ ok: true, orders: [] });
      }

      const [workflows, packResult] = await Promise.all([
        getOrderFulfillmentWorkflows(orderIds),
        db.query<{
          shopify_order_id: string;
          expected: number;
          packed: number;
          unavailable: number;
        }>(
          `
          SELECT
            shopify_order_id,
            COALESCE(SUM(expected_quantity), 0)::int
              AS expected,
            COALESCE(SUM(packed_quantity), 0)::int
              AS packed,
            COALESCE(SUM(unavailable_quantity), 0)::int
              AS unavailable
          FROM order_pack_items
          WHERE shopify_order_id = ANY($1::text[])
          GROUP BY shopify_order_id
          `,
          [orderIds]
        ),
      ]);

      const workflowsById = new Map(
        workflows.map((workflow) => [
          String(workflow.shopify_order_id),
          workflow,
        ])
      );

      const progressById = new Map(
        packResult.rows.map((row) => [
          String(row.shopify_order_id),
          row,
        ])
      );

      const orders = active.flatMap((order: any) => {
        const orderId = String(order?.id ?? "").trim();

        if (!orderId) return [];

        const workflow = workflowsById.get(orderId) ?? null;

        const status = getOperationalOrderStatus(
          order,
          workflow
        );

        if (
          status === "COMPLETED" ||
          status === "CANCELLED"
        ) return [];

        const progress = progressById.get(orderId);

        const expected = Math.max(
          0, Number(progress?.expected ?? 0)
        );

        const packed = Math.max(
          0, Number(progress?.packed ?? 0)
        );

        const unavailable = Math.max(
          0, Number(progress?.unavailable ?? 0)
        );

        const complete =
          expected > 0 &&
          packed + unavailable >= expected;

        const percent = expected > 0
          ? Math.min(
              100,
              Math.round(
                100 * (packed + unavailable) / expected
              )
            )
          : 0;

        return [{
          orderId,
          expected,
          packed,
          unavailable,
          percent,
          status,
          complete,
        }];
      });

      res.setHeader("Cache-Control", "no-store");

      return res.json({
        ok: true,
        orders,
      });
    } catch (error) {
      console.error("ALO LIVE PACK ERROR", error);

      return res.status(500).json({
        ok: false,
        error: "LIVE_PACK_UNAVAILABLE",
      });
    }
  }
);

// ALO_SHIPPING_ADDRESS_EDIT_V1
router.patch("/:orderId/shipping-address", requireStaffAuth, async (req, res) => {
  try {
    const orderId = String(req.params.orderId || "").trim();
    if (!/^(?:gid:\/\/shopify\/Order\/)?\d+$/.test(orderId)) {
      return res.status(400).json({ ok: false, error: "INVALID_ORDER_ID" });
    }
    const current = await getShopifyOrderById(orderId);
    if (!current || current.cancelledAt ||
        String(current.displayFulfillmentStatus).toUpperCase() === "FULFILLED") {
      return res.status(409).json({ ok: false, error: "ORDER_NOT_EDITABLE" });
    }
    // Versandlabel mit alter Adresse darf nach Aenderung nicht als korrekt gelten.
    const existingLabel = await findShippingLabel(current.id, "LIVE");
    const body = req.body ?? {};
    const required = ["firstName", "lastName", "address1", "zip", "city"] as const;
    for (const key of required) {
      if (typeof body[key] !== "string" || !body[key].trim() || body[key].length > 160) {
        return res.status(400).json({ ok: false, error: `INVALID_${key}` });
      }
    }
    if (body.countryCode && body.countryCode !== "CH") {
      return res.status(400).json({ ok: false, error: "ONLY_CH_SUPPORTED" });
    }
    const updated = await updateShopifyShippingAddress(orderId, {
      firstName: body.firstName.trim(), lastName: body.lastName.trim(),
      address1: body.address1.trim(),
      address2: String(body.address2 ?? "").trim().slice(0, 160),
      zip: body.zip.trim(), city: body.city.trim(), countryCode: "CH",
    });
    const verified = await getShopifyOrderById(orderId);
    const actual = verified?.shippingAddress;
    if (!actual || required.some(key => actual[key] !== String(body[key]).trim())) {
      return res.status(502).json({ ok: false, error: "SHOPIFY_ADDRESS_VERIFY_FAILED" });
    }
    return res.json({
      ok: true, shippingAddress: actual,
      labelReplacementRequired: existingLabel?.status === "COMPLETED",
      printBlockedUntilReplacement: existingLabel?.status === "COMPLETED",
    });
  } catch (error) {
    console.error("STAFF SHIPPING ADDRESS UPDATE FAILED", error);
    return res.status(502).json({ ok: false, error: "SHOPIFY_ADDRESS_UPDATE_FAILED" });
  }
});

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
          getStaffOrderChannel(
            readyToShipShopifyOrder
          );

        // ALO_SHIPPING_CHANNEL_GUARD_V1
        // Nur echte Versandbestellungen dürfen
        // Swiss-Post-Fulfillment auslösen.
        if (
          readyToShipFulfillmentType !== "SHIPPING" &&
          readyToShipFulfillmentType !== "PICKUP"
        ) {
          return res.status(409).json({
            ok: false,
            error:
              "ORDER_CHANNEL_NOT_SHIPPING",
            orderChannel:
              readyToShipFulfillmentType,
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

      // ALO_PICKUP_READY_ONLY_V1
      // Bereit zur Abholung, keine Uebergabe.
      // Kein Shopify-Fulfillment ausloesen.
      if (
        readyToShipFulfillmentType === "PICKUP"
      ) {
        return res.json({
          ok: true,
          fulfillmentType: "PICKUP",
          workflow,
          pickupReady: true,
          fulfilled: false,
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


// ALO SHIPPING REPLACEMENT V1 – explicitly initiated by staff, NEVER by normal reprint.
// Not a Swiss Post void/cancellation: the earlier identCode remains auditable.
router.post("/:orderId/replace-shipping-label", requireStaffAuth, async (req, res) => {
  const orderId = String(req.params.orderId || "").trim();
  if (req.body?.confirmNewPostage !== true || req.body?.parcelStillAtKiosk !== true) {
    return res.status(400).json({ok:false,error:"REPLACEMENT_REQUIRES_EXPLICIT_CONFIRMATION"});
  }
  try {
    const order = await getShopifyOrderById(orderId);
    if (!order || String(order.displayFinancialStatus).toUpperCase() !== "PAID" ||
        String(order.displayFulfillmentStatus).toUpperCase() === "FULFILLED") {
      return res.status(409).json({ok:false,error:"ORDER_NOT_ELIGIBLE"});
    }
    const a = order.shippingAddress;
    if (!a?.firstName?.trim() || !a?.lastName?.trim() || !a?.address1?.trim() ||
        !a?.zip?.trim() || !a?.city?.trim() || a?.countryCodeV2 !== "CH") {
      return res.status(409).json({ok:false,error:"SHOPIFY_SHIPPING_ADDRESS_INCOMPLETE"});
    }
    const live = await findShippingLabel(order.id, "LIVE");
    if (!live || live.status !== "COMPLETED" || !live.label_pdf_base64 ||
        !live.swisspost_ident_code || !live.weight_grams || live.weight_grams <= 0) {
      return res.status(409).json({ok:false,error:"ORIGINAL_LIVE_LABEL_MISSING"});
    }
    const busy = await db.query(
      `SELECT id FROM print_jobs WHERE shipping_label_id=$1 AND document_type='SHIPPING_LABEL'
       AND status IN ('PENDING','PRINTING') LIMIT 1`, [live.id]
    );
    if (busy.rows.length) return res.status(409).json({ok:false,error:"ORIGINAL_PRINT_JOB_STILL_ACTIVE"});
    const addr1 = a.address1.trim();
    const addr2 = String(a.address2 || "").trim();
    const houseOnly = /^\d+[A-Za-z]?(?:[-/]\d+[A-Za-z]?)?$/.test(addr2);
    const existingHouse = /\s+\d+[A-Za-z]?(?:[-/]\d+[A-Za-z]?)?$/.test(addr1);
    const {street,houseNumber} = splitSwissStreetAddress(
      houseOnly && !existingHouse ? `${addr1} ${addr2}` : addr1
    );
    if (!street || !houseNumber) return res.status(409).json({ok:false,error:"STREET_NUMBER_NOT_RESOLVED"});
    // Claim once BEFORE external API call. Do not auto-retry after unknown Post API outcome.
    const claimed = await db.query(
      `INSERT INTO shipping_label_replacements (shopify_order_id,shipping_label_id,old_label)
       VALUES ($1,$2,$3::jsonb) ON CONFLICT (shopify_order_id) DO NOTHING RETURNING id`,
      [order.id,live.id,JSON.stringify({identCode:live.swisspost_ident_code,
       oldPdfBase64:live.label_pdf_base64,weightGrams:live.weight_grams,
       originalStatus:live.status,originalUpdatedAt:live.updated_at})]
    );
    if (!claimed.rows.length) return res.status(409).json({ok:false,error:"REPLACEMENT_ALREADY_REQUESTED_CHECK_STATUS"});
    const replacementId = claimed.rows[0].id;
    // Unique itemId avoids accidentally requesting the same old postal item ID.
    let result: any;
    try {
      result = await createSwissPostPreviewLabel({
        itemId:`ALO-REPLACEMENT-${replacementId}`,
        recipient:{name1:`${a.firstName.trim()} ${a.lastName.trim()}`,
          street,houseNo:houseNumber,zip:a.zip.trim(),city:a.city.trim(),country:"CH"},
        weightGrams:live.weight_grams,service:"ECO"
      });
    } catch(error:any) {
      await db.query(`UPDATE shipping_label_replacements SET status='NEEDS_REVIEW',error_message=$2,
        finished_at=NOW() WHERE id=$1`,[replacementId,"Swiss Post response uncertain; manual review required"]);
      throw error;
    }
    const pdf = result?.item?.label?.[0];
    const ident = result?.item?.identCode;
    if (typeof pdf !== 'string' || !pdf.startsWith('JVBER') ||
        typeof ident !== 'string' || !ident.trim() || ident === live.swisspost_ident_code) {
      await db.query(`UPDATE shipping_label_replacements SET status='NEEDS_REVIEW',error_message=$2,
        finished_at=NOW() WHERE id=$1`,[replacementId,'Swiss Post returned invalid or duplicate label']);
      return res.status(502).json({ok:false,error:"POST_LABEL_RESPONSE_NEEDS_REVIEW"});
    }
    // Persist newly issued label before the second database transaction,
    // so a failed queue step is recoverable without reissuing postage.
    await db.query(`UPDATE shipping_label_replacements SET
      status='ISSUED_PENDING_QUEUE', new_ident_code=$2,new_pdf_base64=$3
      WHERE id=$1`,[replacementId,ident,pdf]);
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query(
        `SELECT id,status,swisspost_ident_code FROM shipping_labels WHERE id=$1 FOR UPDATE`,[live.id]
      );
      if (!current.rows[0] || current.rows[0].status !== 'COMPLETED' ||
          current.rows[0].swisspost_ident_code !== live.swisspost_ident_code) {
        throw new Error('ORIGINAL_LABEL_CHANGED_NEEDS_REVIEW');
      }
      const active = await client.query(
        `SELECT id FROM print_jobs WHERE shipping_label_id=$1 AND status IN ('PENDING','PRINTING') LIMIT 1`,[live.id]
      );
      if (active.rows.length) throw new Error('PRINT_JOB_BECAME_ACTIVE_NEEDS_REVIEW');
      await client.query(`UPDATE shipping_labels SET swisspost_ident_code=$2,tracking_number=$2,
         label_pdf_base64=$3,print_status='QUEUED',print_count=0,printed_at=NULL,
         updated_at=NOW() WHERE id=$1`,[live.id,ident,pdf]);
      const job = await client.query(`INSERT INTO print_jobs
        (shipping_label_id,packing_slip_id,document_type,printer_name,status)
        VALUES ($1,NULL,'SHIPPING_LABEL',NULL,'PENDING') RETURNING id`,[live.id]);
      await client.query(`UPDATE shipping_label_replacements SET status='QUEUED',new_ident_code=$2,
        finished_at=NOW() WHERE id=$1`,[replacementId,ident]);
      await client.query('COMMIT');
      return res.json({ok:true,queued:true,orderId:order.id,replacementId,
        printJobId:job.rows[0].id,trackingNumber:ident,
        warning:'Original Swiss Post label was NOT automatically cancelled'});
    } catch (error:any) {
      await client.query('ROLLBACK');
      await db.query(`UPDATE shipping_label_replacements SET status='NEEDS_REVIEW',
        error_message=$2,finished_at=NOW() WHERE id=$1`,[replacementId,
        String(error?.message || error).slice(0,500)]);
      throw error;
    } finally { client.release(); }
  } catch (error:any) {
    console.error('STAFF LABEL REPLACEMENT FAILED',String(error?.message || error));
    return res.status(409).json({ok:false,error:String(error?.message || 'REPLACEMENT_FAILED')});
  }
});

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

      // ALO_ORDER_ARCHIVE_SEARCH_V2: retrieve original archived document by
      // internal Shopify order ID, regardless of age. Never create a new label.
      const table = documentType === "SHIPPING_LABEL"
        ? "shipping_labels"
        : documentType === "PACKING_SLIP"
          ? "packing_slips"
          : "invoices";
      const documentRow = await db.query<{id: string}>(
        `SELECT id FROM ${table} WHERE shopify_order_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
        [orderId]
      );
      const documentId = documentRow.rows[0]?.id ?? null;

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



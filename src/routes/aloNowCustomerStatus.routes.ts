import { buildAloNowCustomerTimeline } from "../modules/aloNow/aloNowCustomerTimeline.js";

import { Router } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { db } from "../database/db.js";

export const aloNowCustomerStatusRouter = Router();

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

aloNowCustomerStatusRouter.get(
  "/order-requests/:requestId/customer-status",
  async (req, res) => {
    res.setHeader("Cache-Control", "no-store, private");
    res.setHeader("Pragma", "no-cache");

    if (process.env.ALO_NOW_REQUESTS_ENABLED !== "true") {
      return res.status(503).json({
        ok: false,
        error: "ALO_NOW_REQUESTS_NOT_ENABLED"
      });
    }

    const requestId = String(req.params.requestId ?? "");
    const token = req.get("x-alo-customer-token") ?? "";

    if (!UUID_PATTERN.test(requestId) ||
        !TOKEN_PATTERN.test(token)) {
      return res.status(404).json({
        ok: false,
        error: "REQUEST_NOT_FOUND"
      });
    }

    try {
      const result = await db.query<{
        id: string;
        status: string;
        created_at: Date;
        updated_at: Date;
        customer_status_token_hash: string | null;
      }>(
        `SELECT id, status, created_at, updated_at,
                customer_status_token_hash
         FROM alo_now_order_requests
         WHERE id = $1::uuid
         LIMIT 1`,
        [requestId]
      );

      const row = result.rows[0];
      const storedHash = row?.customer_status_token_hash;

      if (!row ||
          typeof storedHash !== "string" ||
          !/^[0-9a-f]{64}$/i.test(storedHash)) {
        return res.status(404).json({
          ok: false,
          error: "REQUEST_NOT_FOUND"
        });
      }

      const actualHash = createHash("sha256")
        .update(token)
        .digest();

      const expectedHash = Buffer.from(storedHash, "hex");

      if (!timingSafeEqual(actualHash, expectedHash)) {
        return res.status(404).json({
          ok: false,
          error: "REQUEST_NOT_FOUND"
        });
      }

      // The request token has already been verified above.
      // Read payment state only for the authenticated request.
      // Disabled until the production schema is approved.
      let paymentPhase: string | null = null;
      let shopifyOrderId: string | null = null;

      if (
        process.env.ALO_NOW_CUSTOMER_PAYMENT_TIMELINE_ENABLED ===
        "true"
      ) {
        const payment = await db.query<{
          phase: string | null;
          shopify_order_id: string | null;
        }>(
          `SELECT phase, shopify_order_id
           FROM alo_now_payment_states
           WHERE request_id = $1::uuid
           ORDER BY version DESC
           LIMIT 1`,
          [requestId]
        );

        paymentPhase = payment.rows[0]?.phase ?? null;
        shopifyOrderId =
          payment.rows[0]?.shopify_order_id ?? null;
      }

      // Read only the Shopify order linked to this token-owned
      // request and its verified payment state.
      let packStatus: string | null = null;
      let deliveryStatus: string | null = null;

      const paymentConfirmed =
        paymentPhase === "PAYMENT_CONFIRMED" ||
        paymentPhase === "CASH_CONFIRMED";

      if (
        process.env.ALO_NOW_CUSTOMER_FULFILLMENT_TIMELINE_ENABLED
          === "true" &&
        paymentConfirmed &&
        typeof shopifyOrderId === "string" &&
        shopifyOrderId.length > 0
      ) {
        const [
          { getOrderFulfillmentWorkflow },
          { getAloNowDelivery }
        ] = await Promise.all([
          import("../database/orderFulfillmentWorkflow.js"),
          import("../database/aloNowDeliveries.js")
        ]);

        const [workflow, delivery] = await Promise.all([
          getOrderFulfillmentWorkflow(shopifyOrderId),
          getAloNowDelivery(shopifyOrderId)
        ]);

        packStatus = workflow?.pack_status ?? null;
        deliveryStatus = delivery?.delivery_status ?? null;
      }

      // Optional, fail-closed customer GPS.
      // No GPS is queried before customer-token validation.
      let gpsPosition: {
        latitude: number;
        longitude: number;
        accuracyMeters: number;
        updatedAt: string;
      } | null = null;

      if (
        process.env.ALO_NOW_CUSTOMER_GPS_ENABLED === "true" &&
        process.env.ALO_NOW_CUSTOMER_PAYMENT_TIMELINE_ENABLED
          === "true" &&
        process.env.ALO_NOW_CUSTOMER_FULFILLMENT_TIMELINE_ENABLED
          === "true" &&
        process.env.ALO_NOW_GPS_INGEST_ENABLED === "true" &&
        process.env.ALO_NOW_GPS_CLEANUP_ENABLED === "true" &&
        paymentConfirmed &&
        deliveryStatus === "ON_THE_WAY" &&
        shopifyOrderId
      ) {
        try {
          const { readAloNowCustomerGps } = await import(
            "../modules/aloNow/aloNowCustomerGps.js"
          );

          gpsPosition = await readAloNowCustomerGps(
            requestId,
            shopifyOrderId
          );
        } catch (gpsError) {
          console.error(
            "ALO NOW CUSTOMER GPS UNAVAILABLE",
            gpsError instanceof Error
              ? gpsError.name
              : "UNKNOWN"
          );

          gpsPosition = null;
        }
      }

      return res.status(200).json({
        ok: true,
        gps: gpsPosition,
        requestId: row.id,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        timeline: buildAloNowCustomerTimeline(
          row.status,
          new Date(row.created_at),
          new Date(),
          paymentPhase,
          { packStatus, deliveryStatus },
          gpsPosition !== null
        )
      });

    } catch (error) {
      console.error(
        "ALO NOW CUSTOMER STATUS ERROR",
        error instanceof Error ? error.name : "UNKNOWN"
      );

      return res.status(503).json({
        ok: false,
        error: "CUSTOMER_STATUS_UNAVAILABLE"
      });
    }
  }
);

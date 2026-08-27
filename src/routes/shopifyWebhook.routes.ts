import { Router } from "express";
import {
  createHmac,
  timingSafeEqual,
} from "node:crypto";

import {
  processPaidShopifyOrder,
} from "../modules/shipping/paidOrderPipeline.service.js";

const router = Router();


// ============================================================
// SHOPIFY HMAC VERIFIZIEREN
// ============================================================

function verifyShopifyWebhook(
  rawBody: Buffer,
  hmacHeader: string | undefined
): boolean {
  if (!hmacHeader) {
    return false;
  }

  const secret =
    process.env.SHOPIFY_CLIENT_SECRET;

  if (!secret) {
    throw new Error(
      "SHOPIFY_CLIENT_SECRET fehlt."
    );
  }

  const calculatedHmac =
    createHmac(
      "sha256",
      secret
    )
      .update(rawBody)
      .digest("base64");

  let receivedBuffer: Buffer;
  let calculatedBuffer: Buffer;

  try {
    receivedBuffer =
      Buffer.from(
        hmacHeader,
        "base64"
      );

    calculatedBuffer =
      Buffer.from(
        calculatedHmac,
        "base64"
      );
  } catch {
    return false;
  }

  if (
    receivedBuffer.length !==
    calculatedBuffer.length
  ) {
    return false;
  }

  return timingSafeEqual(
    receivedBuffer,
    calculatedBuffer
  );
}


// ============================================================
// SHOPIFY ORDERS PAID WEBHOOK
// ============================================================

router.post(
  "/webhooks/shopify/orders-paid",
  async (req, res) => {
    try {
      const rawBody =
        req.body as Buffer;

      if (
        !Buffer.isBuffer(rawBody)
      ) {
        console.error(
          "Shopify Webhook ohne Raw Body."
        );

        return res.status(400).json({
          ok: false,
          error:
            "Webhook Raw Body fehlt.",
        });
      }


      // ------------------------------------------------------
      // HMAC prüfen
      // ------------------------------------------------------

      const hmacHeader =
        req.get(
          "X-Shopify-Hmac-Sha256"
        );

      const valid =
        verifyShopifyWebhook(
          rawBody,
          hmacHeader
        );

      if (!valid) {
        console.warn(
          "Shopify Webhook mit ungültiger HMAC abgelehnt."
        );

        return res.status(401).json({
          ok: false,
          error:
            "Invalid Shopify HMAC",
        });
      }


      // ------------------------------------------------------
      // Shopify Header
      // ------------------------------------------------------

      const topic =
        req.get(
          "X-Shopify-Topic"
        );

      const shop =
        req.get(
          "X-Shopify-Shop-Domain"
        );

      const webhookId =
        req.get(
          "X-Shopify-Webhook-Id"
        );


      // ------------------------------------------------------
      // Topic prüfen
      // ------------------------------------------------------

      if (
        topic &&
        topic !== "orders/paid"
      ) {
        console.warn(
          "Unerwarteter Shopify Webhook Topic:",
          topic
        );

        return res.status(400).json({
          ok: false,
          error:
            "Unexpected webhook topic",
        });
      }


      // ------------------------------------------------------
      // JSON parsen
      // ------------------------------------------------------

      let payload: any;

      try {
        payload =
          JSON.parse(
            rawBody.toString(
              "utf8"
            )
          );
      } catch {
        console.error(
          "Shopify Webhook enthält ungültiges JSON."
        );

        return res.status(400).json({
          ok: false,
          error:
            "Invalid JSON payload",
        });
      }


      // ------------------------------------------------------
      // Order ID ermitteln
      // ------------------------------------------------------

      const rawOrderId =
        payload
          ?.admin_graphql_api_id ??
        payload?.id;

      if (!rawOrderId) {
        console.error(
          "Shopify orders/paid Webhook ohne Order-ID."
        );

        return res.status(400).json({
          ok: false,
          error:
            "Order ID fehlt.",
        });
      }

      const orderId =
        String(rawOrderId);


      // ------------------------------------------------------
      // Nur sichere Metadaten loggen
      // Keine Kundenadresse / E-Mail loggen
      // ------------------------------------------------------

      console.log(
        "Shopify Webhook empfangen:",
        {
          topic:
            topic ?? null,

          shop:
            shop ?? null,

          webhookId:
            webhookId ?? null,

          orderId,

          orderName:
            payload?.name ??
            null,
        }
      );


      // ------------------------------------------------------
      // Shopify sofort bestätigen
      // ------------------------------------------------------

      res.status(200).json({
        ok: true,
        received: true,
      });


      // ------------------------------------------------------
      // Versand-Pipeline im Hintergrund starten
      //
      // AKTUELL:
      // Shopify PAID
      // -> Bestellung laden
      // -> Adresse validieren
      // -> Gewicht berechnen
      // -> SPECIMEN Swiss Post Label
      // -> PostgreSQL
      // -> Print Queue
      //
      // Noch KEINE LIVE Frankierung.
      // Noch KEIN Fulfillment vor erfolgreichem Druck.
      // ------------------------------------------------------

      void processPaidShopifyOrder(
        orderId
      )
        .then(
          (result) => {
            console.log(
              "Shopify orders/paid erfolgreich verarbeitet:",
              {
                orderId,

                skipped:
                  result?.skipped ??
                  false,

                orderName:
                  result?.orderName ??
                  null,
              }
            );
          }
        )
        .catch(
          (error: any) => {
            console.error(
              "Paid Order Pipeline Fehler:",
              {
                orderId,

                error:
                  error?.message ??
                  String(error),
              }
            );
          }
        );

      return;

    } catch (error: any) {
      console.error(
        "Shopify Webhook Error:",
        error?.message ??
          error
      );

      if (!res.headersSent) {
        return res.status(500).json({
          ok: false,
          error:
            "Webhook processing failed",
        });
      }

      return;
    }
  }
);


export const shopifyWebhookRouter =
  router;

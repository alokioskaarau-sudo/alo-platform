import { Router } from "express";

import {
  createHmac,
  timingSafeEqual,
} from "node:crypto";

import {
  processPaidShopifyOrder,
} from "../modules/shipping/paidOrderPipeline.service.js";

import {
  createWebhookEvent,
  markWebhookProcessing,
  markWebhookCompleted,
  markWebhookFailed,
} from "../database/shopifyWebhookEvents.js";

const router =
  Router();


// ============================================================
// SHOPIFY HMAC
// ============================================================

function verifyShopifyWebhook(
  rawBody: Buffer,
  hmacHeader:
    | string
    | undefined
): boolean {
  if (!hmacHeader) {
    return false;
  }

  const secret =
    process.env
      .SHOPIFY_CLIENT_SECRET;

  if (!secret) {
    throw new Error(
      "SHOPIFY_CLIENT_SECRET fehlt."
    );
  }

  const calculated =
    createHmac(
      "sha256",
      secret
    )
      .update(rawBody)
      .digest();

  let received: Buffer;

  try {
    received =
      Buffer.from(
        hmacHeader,
        "base64"
      );
  } catch {
    return false;
  }

  if (
    received.length !==
    calculated.length
  ) {
    return false;
  }

  return timingSafeEqual(
    received,
    calculated
  );
}


// ============================================================
// PAID ORDER VERARBEITEN
// ============================================================

async function processStoredWebhook(
  eventId: string,
  orderId: string
) {
  try {
    await markWebhookProcessing(
      eventId
    );

    const result =
      await processPaidShopifyOrder(
        orderId
      );

    await markWebhookCompleted(
      eventId
    );

    console.log(
      "Shopify Webhook vollständig verarbeitet:",
      {
        eventId,
        orderId,
        orderName:
          result?.orderName ??
          null,
        skipped:
          result?.skipped ??
          false,
      }
    );

  } catch (error: any) {
    const message =
      error?.message ??
      String(error);

    await markWebhookFailed(
      eventId,
      message
    );

    console.error(
      "Shopify Webhook Verarbeitung fehlgeschlagen:",
      {
        eventId,
        orderId,
        error: message,
      }
    );
  }
}


// ============================================================
// ORDERS / PAID
// ============================================================

router.post(
  "/webhooks/shopify/orders-paid",

  async (req, res) => {
    try {
      const rawBody =
        req.body as Buffer;

      if (
        !Buffer.isBuffer(
          rawBody
        )
      ) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "Webhook Raw Body fehlt.",
          });
      }


      // ------------------------------------------------------
      // HMAC
      // ------------------------------------------------------

      const hmac =
        req.get(
          "X-Shopify-Hmac-Sha256"
        );

      if (
        !verifyShopifyWebhook(
          rawBody,
          hmac
        )
      ) {
        console.warn(
          "Ungültiger Shopify Webhook abgelehnt."
        );

        return res
          .status(401)
          .json({
            ok: false,
            error:
              "Invalid Shopify HMAC",
          });
      }


      // ------------------------------------------------------
      // HEADER
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
      // NUR ORDERS_PAID
      // ------------------------------------------------------

      if (
        topic !== "orders/paid"
      ) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "Unexpected webhook topic",
          });
      }


      // ------------------------------------------------------
      // WEBHOOK-ID IST FÜR IDEMPOTENZ PFLICHT
      // ------------------------------------------------------

      if (!webhookId) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "Webhook ID fehlt.",
          });
      }


      // ------------------------------------------------------
      // PAYLOAD
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
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "Invalid JSON payload",
          });
      }


      // ------------------------------------------------------
      // ORDER ID
      // ------------------------------------------------------

      const rawOrderId =
        payload
          ?.admin_graphql_api_id ??
        payload?.id;

      if (!rawOrderId) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "Order ID fehlt.",
          });
      }

      const orderId =
        String(
          rawOrderId
        );

      const orderName =
        payload?.name
          ? String(
              payload.name
            )
          : null;


      // ------------------------------------------------------
      // WEBHOOK ZUERST IN POSTGRES SPEICHERN
      // ------------------------------------------------------

      const stored =
        await createWebhookEvent({
          webhookId,

          topic,

          shopDomain:
            shop ?? null,

          orderId,

          orderName,
        });


      // ------------------------------------------------------
      // DUPLIKAT
      // ------------------------------------------------------

      if (!stored.created) {
        console.log(
          "Shopify Webhook bereits bekannt:",
          {
            webhookId,
            orderId,
            status:
              stored.event.status,
          }
        );

        return res
          .status(200)
          .json({
            ok: true,
            received: true,
            duplicate: true,
          });
      }


      console.log(
        "Shopify Webhook dauerhaft gespeichert:",
        {
          eventId:
            stored.event.id,

          webhookId,

          orderId,

          orderName,
        }
      );


      // ------------------------------------------------------
      // JETZT DARF SHOPIFY 200 BEKOMMEN
      //
      // Der Event existiert bereits dauerhaft in PostgreSQL.
      // ------------------------------------------------------

      res
        .status(200)
        .json({
          ok: true,
          received: true,
          persisted: true,
        });


      // ------------------------------------------------------
      // PIPELINE
      // ------------------------------------------------------

      void processStoredWebhook(
        stored.event.id,
        orderId
      );

      return;

    } catch (error: any) {
      console.error(
        "Shopify Webhook Error:",
        error?.message ??
          error
      );

      if (
        !res.headersSent
      ) {
        return res
          .status(500)
          .json({
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

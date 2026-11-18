import { Router } from "express";

import {
  createHmac,
  timingSafeEqual,
} from "node:crypto";

import {
  processPaidOrderWithAloNowV2697
} from "../modules/aloNow/aloNowPaidOrderRouter.v2697.js";

import {
  createWebhookEvent,
  markWebhookProcessing,
  markWebhookCompleted,
  markWebhookFailed,
  claimWebhookEvent,
  finishClaimedWebhookEvent,
} from "../database/shopifyWebhookEvents.js";

import {
  processShopifyProductWebhook,
} from "../services/shopifyProductWebhook.service.js";

import {
  createOrderAlert,
} from "../database/orderAlerts.js";

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

// ALO_SAFE_ORDER_WEBHOOK_V1
async function processStoredWebhook(
  eventId: string,
  orderId: string
) {
  let attempt: number | null = null;

  try {
    const claim = await claimWebhookEvent(eventId);

    if (!claim.claimed || claim.attempt === null) {
      console.log("Webhook wird bereits verarbeitet oder ist abgeschlossen:", eventId);
      return;
    }

    attempt = claim.attempt;

    const result = await processPaidOrderWithAloNowV2697(orderId);

    const completed = await finishClaimedWebhookEvent(
      eventId,
      attempt,
      "COMPLETED"
    );

    if (!completed) {
      console.warn("Webhook-Abschluss verworfen: Versuch nicht mehr aktuell.", {
        eventId,
        attempt,
      });
      return;
    }

    console.log("Shopify Webhook vollständig verarbeitet:", {
      eventId,
      orderId,
      orderName: result?.orderName ?? null,
      skipped: result?.skipped ?? false,
    });
  } catch (error: any) {
    const message = error?.message ?? String(error);

    if (attempt !== null) {
      try {
        const failed = await finishClaimedWebhookEvent(
          eventId,
          attempt,
          "FAILED",
          message
        );

        if (!failed) {
          console.warn("Webhook-Fehlerstatus verworfen: Versuch nicht mehr aktuell.", {
            eventId,
            attempt,
          });
        }
      } catch (statusError) {
        console.error("Webhook-Fehlerstatus konnte nicht gespeichert werden:", statusError);
      }
    }

    console.error("Shopify Webhook Verarbeitung fehlgeschlagen:", {
      eventId,
      orderId,
      error: message,
    });
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
      // ALO ORDER ALERT
      //
      // Bewusst VOR dem Duplicate-Return:
      // Falls die Alert-Erstellung einmal fehlschlägt und
      // Shopify den Webhook erneut sendet, kann der Alert
      // beim Retry noch erstellt werden.
      //
      // shopify_order_id ist in order_alerts UNIQUE.
      // Dadurch entsteht pro Bestellung maximal ein Alert.
      // ------------------------------------------------------

      const alertItems =
        Array.isArray(
          payload?.line_items
        )
          ? payload.line_items
              .map(
                (item: any) => ({
                  name:
                    String(
                      item?.name ??
                      item?.title ??
                      "Artikel"
                    ).trim(),
                  quantity:
                    Math.max(
                      1,
                      Number(
                        item?.quantity ??
                        1
                      ) || 1
                    ),
                })
              )
              .filter(
                (item: any) =>
                  item.name.length > 0
              )
          : [];

      const alertTotalAmount =
        String(
          payload?.current_total_price ??
          payload?.total_price ??
          "0"
        );

      const alertCurrencyCode =
        String(
          payload?.currency ??
          payload?.presentment_currency ??
          "CHF"
        ).toUpperCase();

      const alertResult =
        await createOrderAlert({
          shopifyOrderId:
            orderId,

          shopifyOrderName:
            orderName ??
            String(orderId),

          totalAmount:
            alertTotalAmount,

          currencyCode:
            alertCurrencyCode,

          fulfillmentType:
            "ORDER",

          items:
            alertItems,
        });

      console.log(
        alertResult.created
          ? "ALO Order Alert erstellt:"
          : "ALO Order Alert bereits vorhanden:",
        {
          orderId,
          orderName,
          alertId:
            alertResult.alert.id,
          total:
            alertTotalAmount,
          currency:
            alertCurrencyCode,
          items:
            alertItems.length,
        }
      );


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



// ============================================================
// PRODUCTS / CREATE + UPDATE
// ============================================================

const PRODUCT_WEBHOOK_TOPICS =
  new Set([
    "products/create",
    "products/update",
  ]);

// ALO_SAFE_PRODUCT_WEBHOOK_V1
async function processStoredProductWebhook(
  eventId: string,
  payload: any
) {
  let attempt: number | null = null;

  try {
    const claim = await claimWebhookEvent(eventId);

    if (!claim.claimed || claim.attempt === null) {
      console.log("Produkt-Webhook bereits übernommen oder abgeschlossen:", eventId);
      return;
    }

    attempt = claim.attempt;

    const result = await processShopifyProductWebhook(payload);

    const completed = await finishClaimedWebhookEvent(
      eventId,
      attempt,
      "COMPLETED"
    );

    if (!completed) {
      console.warn("Produkt-Webhook: Abschlussversuch nicht mehr aktuell.", {
        eventId,
        attempt,
      });
      return;
    }

    console.log("Shopify Product Webhook vollständig verarbeitet:", {
      eventId,
      action: result.action,
      productMasterId:
        "productMasterId" in result
          ? result.productMasterId
          : null,
      shopifyProductId: result.shopifyProductId,
    });
  } catch (error: any) {
    const message = error?.message ?? String(error);

    if (attempt !== null) {
      try {
        const updated = await finishClaimedWebhookEvent(
          eventId,
          attempt,
          "FAILED",
          message
        );

        if (!updated) {
          console.warn("Produkt-Webhook: Fehlerstatus nicht mehr aktuell.", {
            eventId,
            attempt,
          });
        }
      } catch (statusError) {
        console.error(
          "Produkt-Webhook: Fehlerstatus konnte nicht gespeichert werden:",
          statusError
        );
      }
    }

    console.error("Shopify Product Webhook Verarbeitung fehlgeschlagen:", {
      eventId,
      error: message,
    });
  }
}

router.post(
  "/webhooks/shopify/products",
  async (req, res) => {
    try {
      const rawBody =
        req.body as Buffer;

      if (!Buffer.isBuffer(rawBody)) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "Webhook Raw Body fehlt.",
          });
      }

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
        return res
          .status(401)
          .json({
            ok: false,
            error:
              "Invalid Shopify HMAC",
          });
      }

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

      if (
        !topic ||
        !PRODUCT_WEBHOOK_TOPICS.has(
          topic
        )
      ) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "Unexpected webhook topic",
          });
      }

      if (!webhookId) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "Webhook ID fehlt.",
          });
      }

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

      const rawProductId =
        payload
          ?.admin_graphql_api_id ??
        payload?.id;

      if (!rawProductId) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "Product ID fehlt.",
          });
      }

      const resourceId =
        String(rawProductId);

      const stored =
        await createWebhookEvent({
          webhookId,
          topic,
          shopDomain:
            shop ?? null,
          resourceId,
        });

      if (!stored.created) {
        return res
          .status(200)
          .json({
            ok: true,
            received: true,
            duplicate: true,
          });
      }

      console.log(
        "Shopify Product Webhook dauerhaft gespeichert:",
        {
          eventId:
            stored.event.id,
          webhookId,
          topic,
          resourceId,
        }
      );

      res
        .status(200)
        .json({
          ok: true,
          received: true,
          persisted: true,
        });

      void processStoredProductWebhook(
        stored.event.id,
        payload
      );

      return;
    } catch (error: any) {
      console.error(
        "Shopify Product Webhook Error:",
        error?.message ??
          error
      );

      if (!res.headersSent) {
        return res
          .status(500)
          .json({
            ok: false,
            error:
              "Product webhook processing failed",
          });
      }

      return;
    }
  }
);


export const shopifyWebhookRouter =
  router;

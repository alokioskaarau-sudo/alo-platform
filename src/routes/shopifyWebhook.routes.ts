import { Router } from "express";
import crypto from "node:crypto";

const router = Router();

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

  const calculatedHmac = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("base64");

  const received =
    Buffer.from(hmacHeader, "base64");

  const calculated =
    Buffer.from(calculatedHmac, "base64");

  if (
    received.length !== calculated.length
  ) {
    return false;
  }

  return crypto.timingSafeEqual(
    received,
    calculated
  );
}

router.post(
  "/webhooks/shopify/orders-paid",
  async (req, res) => {
    try {
      const rawBody = req.body as Buffer;

      if (!Buffer.isBuffer(rawBody)) {
        return res.status(400).json({
          ok: false,
          error: "Webhook Raw Body fehlt.",
        });
      }

      const hmacHeader =
        req.get("X-Shopify-Hmac-Sha256");

      if (
        !verifyShopifyWebhook(
          rawBody,
          hmacHeader
        )
      ) {
        console.warn(
          "Shopify Webhook mit ungültiger HMAC abgelehnt."
        );

        return res.status(401).json({
          ok: false,
          error: "Invalid Shopify HMAC",
        });
      }

      const topic =
        req.get("X-Shopify-Topic");

      const shop =
        req.get("X-Shopify-Shop-Domain");

      const webhookId =
        req.get("X-Shopify-Webhook-Id");

      const payload =
        JSON.parse(
          rawBody.toString("utf8")
        );

      console.log(
        "Shopify Webhook empfangen:",
        {
          topic,
          shop,
          webhookId,
          orderId: payload?.admin_graphql_api_id ??
            payload?.id ??
            null,
          orderName: payload?.name ?? null,
        }
      );

      /*
       * Noch absichtlich KEINE echte Frankierung.
       *
       * Im nächsten Schritt verbinden wir hier:
       *
       * 1. Bestellung aus Shopify laden
       * 2. Adresse validieren
       * 3. Gewicht berechnen
       * 4. SPECIMEN Label erzeugen
       * 5. DB aktualisieren
       * 6. Print Job erzeugen
       *
       * Erst nach vollständigem Test:
       * SPECIMEN -> LIVE
       */

      return res.status(200).json({
        ok: true,
        received: true,
      });
    } catch (error: any) {
      console.error(
        "Shopify Webhook Error:",
        error
      );

      return res.status(500).json({
        ok: false,
        error: "Webhook processing failed",
      });
    }
  }
);

export const shopifyWebhookRouter =
  router;

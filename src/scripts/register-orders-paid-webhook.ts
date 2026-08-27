import { env } from "../config/env.js";
import { getShopifyAccessToken } from "../integrations/shopify/auth.js";

const WEBHOOK_URL =
  "https://alo-platform-production.up.railway.app/webhooks/shopify/orders-paid";

async function registerWebhook() {
  const token =
    await getShopifyAccessToken();

  const endpoint =
    `https://${env.shopify.shop}.myshopify.com/admin/api/${env.shopify.apiVersion}/graphql.json`;

  const mutation = `
    mutation webhookSubscriptionCreate(
      $topic: WebhookSubscriptionTopic!,
      $webhookSubscription: WebhookSubscriptionInput!
    ) {
      webhookSubscriptionCreate(
        topic: $topic,
        webhookSubscription: $webhookSubscription
      ) {
        webhookSubscription {
          id
          topic
          uri
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const response =
    await fetch(
      endpoint,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": token,
        },
        body: JSON.stringify({
          query: mutation,
          variables: {
            topic: "ORDERS_PAID",
            webhookSubscription: {
              uri: WEBHOOK_URL,
            },
          },
        }),
      }
    );

  const json =
    await response.json();

  console.dir(
    json,
    {
      depth: null,
    }
  );
}

registerWebhook().catch(
  (error) => {
    console.error(
      "Webhook Registrierung fehlgeschlagen:",
      error
    );

    process.exit(1);
  }
);

import { db } from "./db.js";

export type ShopifyWebhookEvent = {
  id: string;

  webhook_id: string;
  topic: string;

  shop_domain:
    | string
    | null;

  shopify_order_id: string;

  shopify_order_name:
    | string
    | null;

  status: string;

  attempts: number;

  error_message:
    | string
    | null;

  received_at: Date;

  processing_started_at:
    | Date
    | null;

  processed_at:
    | Date
    | null;

  updated_at: Date;
};


// ============================================================
// WEBHOOK DAUERHAFT SPEICHERN
// ============================================================

export async function createWebhookEvent(
  input: {
    webhookId: string;
    topic: string;
    shopDomain?: string | null;
    orderId: string;
    orderName?: string | null;
  }
): Promise<{
  created: boolean;
  event: ShopifyWebhookEvent;
}> {
  const result =
    await db.query<ShopifyWebhookEvent>(
      `
        INSERT INTO shopify_webhook_events (
          webhook_id,
          topic,
          shop_domain,
          shopify_order_id,
          shopify_order_name,
          status
        )

        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          'PENDING'
        )

        ON CONFLICT (
          webhook_id
        )
        DO NOTHING

        RETURNING *
      `,
      [
        input.webhookId,
        input.topic,
        input.shopDomain ?? null,
        input.orderId,
        input.orderName ?? null,
      ]
    );

  if (result.rows[0]) {
    return {
      created: true,
      event: result.rows[0],
    };
  }

  const existing =
    await db.query<ShopifyWebhookEvent>(
      `
        SELECT *
        FROM shopify_webhook_events
        WHERE webhook_id = $1
        LIMIT 1
      `,
      [
        input.webhookId,
      ]
    );

  if (!existing.rows[0]) {
    throw new Error(
      "Webhook Event konnte nicht gespeichert werden."
    );
  }

  return {
    created: false,
    event: existing.rows[0],
  };
}


// ============================================================
// EVENT AUF PROCESSING SETZEN
// ============================================================

export async function markWebhookProcessing(
  id: string
) {
  const result =
    await db.query<ShopifyWebhookEvent>(
      `
        UPDATE shopify_webhook_events

        SET
          status = 'PROCESSING',

          attempts =
            attempts + 1,

          processing_started_at =
            NOW(),

          error_message =
            NULL,

          updated_at =
            NOW()

        WHERE id = $1

        RETURNING *
      `,
      [id]
    );

  if (!result.rows[0]) {
    throw new Error(
      "Webhook Event wurde nicht gefunden."
    );
  }

  return result.rows[0];
}


// ============================================================
// EVENT ERFOLGREICH
// ============================================================

export async function markWebhookCompleted(
  id: string
) {
  await db.query(
    `
      UPDATE shopify_webhook_events

      SET
        status = 'COMPLETED',

        processed_at =
          NOW(),

        error_message =
          NULL,

        updated_at =
          NOW()

      WHERE id = $1
    `,
    [id]
  );
}


// ============================================================
// EVENT FEHLGESCHLAGEN
// ============================================================

export async function markWebhookFailed(
  id: string,
  errorMessage: string
) {
  await db.query(
    `
      UPDATE shopify_webhook_events

      SET
        status = 'FAILED',

        error_message =
          $2,

        updated_at =
          NOW()

      WHERE id = $1
    `,
    [
      id,
      errorMessage,
    ]
  );
}

import { db } from "./db.js";

export type ShopifyWebhookEvent = {
  id: string;

  webhook_id: string;
  topic: string;

  shop_domain:
    | string
    | null;

  shopify_order_id:
    | string
    | null;

  shopify_resource_id:
    | string
    | null;

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
    orderId?: string | null;
    orderName?: string | null;
    resourceId?: string | null;
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
          shopify_resource_id,
          status
        )

        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
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
        input.orderId ?? null,
        input.orderName ?? null,
        input.resourceId ?? null,
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
// EVENT BRAUCHT MANUELLE PRÜFUNG
// ============================================================

export async function markWebhookNeedsReview(
  id: string,
  errorMessage: string
) {
  await db.query(
    `
      UPDATE shopify_webhook_events
      SET
        status = 'NEEDS_REVIEW',
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


export async function claimPendingPaidWebhookV380(
  eventId: string
): Promise<boolean> {
  const result = await db.query(
    `UPDATE shopify_webhook_events
     SET status='PROCESSING',
         attempts=attempts+1,
         processing_started_at=NOW(),
         error_message=NULL,
         updated_at=NOW()
     WHERE id=$1
       AND topic='orders/paid'
       AND status='PENDING'
     RETURNING id`,
    [eventId]
  );
  return result.rowCount === 1;
}


export async function claimOrderScopedPaidWebhookV383(
  eventId: string,
  orderId: string
): Promise<boolean> {
  if (
    !/^gid:\/\/shopify\/Order\/[1-9][0-9]*$/.test(orderId)
  ) {
    return false;
  }

  const client = await db.connect();
  let transactionOpen = false;
  let destroy = false;

  try {
    await client.query("BEGIN");
    transactionOpen = true;

    await client.query("SET LOCAL lock_timeout = '3s'");
    await client.query("SET LOCAL statement_timeout = '12s'");

    // Fester Namespace + Hash der Order-ID.
    // Hashkollisionen blockieren höchstens zusätzliche Orders.
    await client.query(
      "SELECT pg_advisory_xact_lock(383, hashtext($1))",
      [orderId]
    );

    const event = await client.query<{
      id: string;
      status: string;
      shopify_order_id: string | null;
    }>(
      `SELECT id::text, status, shopify_order_id
       FROM shopify_webhook_events
       WHERE id=$1
         AND topic='orders/paid'
       FOR UPDATE`,
      [eventId]
    );

    const row = event.rows[0];

    if (
      !row ||
      row.status !== "PENDING" ||
      row.shopify_order_id !== orderId
    ) {
      await client.query("ROLLBACK");
      transactionOpen = false;
      return false;
    }

    const conflict = await client.query(
      `SELECT 1
       FROM shopify_webhook_events
       WHERE shopify_order_id=$1
         AND topic='orders/paid'
         AND id<>$2
         AND status IN (
           'PROCESSING',
           'COMPLETED',
           'FAILED',
           'NEEDS_REVIEW'
         )
       LIMIT 1`,
      [orderId, eventId]
    );

    if (conflict.rowCount) {
      await client.query("ROLLBACK");
      transactionOpen = false;
      return false;
    }

    const updated = await client.query(
      `UPDATE shopify_webhook_events
       SET status='PROCESSING',
           attempts=attempts+1,
           processing_started_at=NOW(),
           error_message=NULL,
           updated_at=NOW()
       WHERE id=$1
         AND topic='orders/paid'
         AND shopify_order_id=$2
         AND status='PENDING'
       RETURNING id`,
      [eventId, orderId]
    );

    if (updated.rowCount !== 1) {
      throw new Error("ORDER_WEBHOOK_CLAIM_CONFLICT");
    }

    await client.query("COMMIT");
    transactionOpen = false;
    return true;

  } catch (error) {
    destroy = true;
    throw error;
  } finally {
    if (transactionOpen) {
      try {
        await client.query("ROLLBACK");
      } catch {
        destroy = true;
      }
    }
    client.release(destroy);
  }
}

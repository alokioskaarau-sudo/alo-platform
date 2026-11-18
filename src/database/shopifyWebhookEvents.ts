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


// ALO_WEBHOOK_ATOMIC_CLAIM_V1
// Atomare Übernahme eines Webhook-Events.
// Die zurückgegebene attempts-Zahl identifiziert den Versuch.
export async function claimWebhookEvent(
  id: string,
  allowRecovery: boolean = false
): Promise<{
  claimed: boolean;
  attempt: number | null;
}> {
  const result = await db.query<ShopifyWebhookEvent>(
    `
      UPDATE shopify_webhook_events
      SET
        status = 'PROCESSING',
        attempts = attempts + 1,
        processing_started_at = NOW(),
        error_message = NULL,
        updated_at = NOW()
      WHERE id = $1
        AND (
          status = 'PENDING'
          OR (
            $2::boolean = TRUE
            AND (
              (status = 'FAILED' AND attempts < 3)
              OR (
                status = 'PROCESSING'
                AND processing_started_at <
                  NOW() - INTERVAL '30 minutes'
              )
            )
          )
        )
      RETURNING *
    `,
    [id, allowRecovery]
  );

  const event = result.rows[0];

  return {
    claimed: Boolean(event),
    attempt: event ? Number(event.attempts) : null,
  };
}


// ALO_WEBHOOK_SAFE_FINISH_V1
// Nur der aktuelle Verarbeitungsversuch darf den Event abschliessen.
export async function finishClaimedWebhookEvent(
  id: string,
  attempt: number,
  status: "COMPLETED" | "FAILED" | "NEEDS_REVIEW",
  errorMessage: string | null = null
): Promise<boolean> {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new Error("Ungültige Webhook-Versuchsnummer.");
  }

  const result = await db.query<{ id: string }>(
    `
      UPDATE shopify_webhook_events
      SET
        status = $3,
        error_message = CASE
          WHEN $3 = 'COMPLETED' THEN NULL
          ELSE $4
        END,
        processed_at = CASE
          WHEN $3 = 'COMPLETED' THEN NOW()
          ELSE processed_at
        END,
        updated_at = NOW()
      WHERE id = $1
        AND attempts = $2
        AND status = 'PROCESSING'
      RETURNING id
    `,
    [id, attempt, status, errorMessage]
  );

  return result.rows.length === 1;
}

import { db } from "../../database/db.js";

import {
  processPaidShopifyOrder,
} from "./paidOrderPipeline.service.js";

import {
  claimWebhookEvent,
  finishClaimedWebhookEvent,
} from "../../database/shopifyWebhookEvents.js";


type RecoverableWebhookEvent = {
  id: string;
  shopify_order_id: string;
  status: string;
  attempts: number;
};


function isPermanentWebhookFailure(
  message: string
): boolean {
  const normalized =
    String(message ?? "")
      .trim()
      .toLowerCase();

  return (
    normalized.includes(
      "hat keine versandadresse"
    ) ||
    normalized.includes(
      "adresse nicht ausreichend bestätigt"
    ) ||
    normalized.includes(
      "hausnummer konnte aus adresse nicht erkannt werden"
    )
  );
}


// ============================================================
// EINEN EVENT VERARBEITEN
// ============================================================

// ALO_SAFE_WEBHOOK_RECOVERY_V1
async function recoverEvent(
  event: RecoverableWebhookEvent
) {
  let attempt: number | null = null;

  try {
    const claim = await claimWebhookEvent(event.id, true);

    if (!claim.claimed || claim.attempt === null) {
      console.log("Webhook Recovery übersprungen:", {
        eventId: event.id,
        reason: "Event bereits übernommen oder nicht verfügbar",
      });
      return;
    }

    attempt = claim.attempt;

    console.log("Webhook Recovery gestartet:", {
      eventId: event.id,
      orderId: event.shopify_order_id,
      attempt,
    });

    const result = await processPaidShopifyOrder(
      event.shopify_order_id
    );

    const completed = await finishClaimedWebhookEvent(
      event.id,
      attempt,
      "COMPLETED"
    );

    if (!completed) {
      console.warn("Webhook Recovery: Abschluss nicht mehr aktuell.", {
        eventId: event.id,
        attempt,
      });
      return;
    }

    console.log("Webhook Recovery erfolgreich:", {
      eventId: event.id,
      orderId: event.shopify_order_id,
      orderName: result?.orderName ?? null,
    });
  } catch (error: any) {
    const message = error?.message ?? String(error);
    const permanent = isPermanentWebhookFailure(message);

    if (attempt !== null) {
      try {
        const updated = await finishClaimedWebhookEvent(
          event.id,
          attempt,
          permanent ? "NEEDS_REVIEW" : "FAILED",
          message
        );

        if (!updated) {
          console.warn("Webhook Recovery: Fehlerstatus nicht mehr aktuell.", {
            eventId: event.id,
            attempt,
          });
        }
      } catch (statusError) {
        console.error("Webhook Recovery: Fehlerstatus konnte nicht gespeichert werden:", statusError);
      }
    }

    console.error(
      permanent
        ? "Webhook Recovery benötigt manuelle Prüfung:"
        : "Webhook Recovery fehlgeschlagen:",
      {
        eventId: event.id,
        orderId: event.shopify_order_id,
        error: message,
      }
    );
  }
}


// ============================================================
// LIEGENGEBLIEBENE EVENTS SUCHEN
// ============================================================

export async function recoverPendingShopifyWebhooks() {
  const result =
    await db.query<RecoverableWebhookEvent>(
      `
        SELECT
          id,
          shopify_order_id,
          status,
          attempts

        FROM shopify_webhook_events

        WHERE
          topic = 'orders/paid'
          AND shopify_order_id IS NOT NULL
          AND (
            status = 'PENDING'

            OR (
              status = 'PROCESSING'
              AND processing_started_at <
                NOW() - INTERVAL '30 minutes'
            )

            OR (
              status = 'FAILED'
              AND attempts < 3
            )
          )

        ORDER BY
          received_at ASC

        LIMIT 50
      `
    );

  const events =
    result.rows;

  if (
    events.length === 0
  ) {
    console.log(
      "Webhook Recovery: keine offenen Events."
    );

    return {
      recovered: 0,
    };
  }

  console.log(
    `Webhook Recovery: ${events.length} Event(s) gefunden.`
  );

  for (
    const event of events
  ) {
    await recoverEvent(
      event
    );
  }

  return {
    recovered:
      events.length,
  };
}

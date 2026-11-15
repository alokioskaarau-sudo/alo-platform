import { authorizeAloNowDeliveryV332 } from "./aloNowDeliveryAuthorization.v332.js";
import { randomUUID } from "node:crypto";
import { db } from "../../database/db.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AloNowStoredCheckoutIntent = {
  requestId: string;
  checkoutReference: string;
  shopifyOrderId: string | null;
};

export type AloNowCheckoutIntentResult =
  | { ok: true; intent: AloNowStoredCheckoutIntent; reused: boolean }
  | { ok: false; reason: string };

/**
 * Internal service function only.
 * Never accept checkoutReference from a browser.
 * This does not create Shopify checkouts or collect payments.
 */
export async function ensureAloNowCheckoutIntent(
  requestId: string
): Promise<AloNowCheckoutIntentResult> {
  if (!UUID.test(requestId)) {
    return { ok: false, reason: "INVALID_REQUEST_ID" };
  }

  const client = await db.connect();
  let transactionOpen = false;
  let destroy = false;

  try {
    await client.query("BEGIN");
    transactionOpen = true;

    // Parent-first row locking, compatible with existing payment flow.
    const request = await client.query<{
      status: string;
      driver_user_id: string | null;
      quote_status: string;
      verified_at: Date | null;
      verified_subtotal_chf: string | null;
      quoted_delivery_fee_chf: string | null;
      reservation_valid: boolean;
    }>(
      `SELECT status,driver_user_id,quote_status,verified_at,
              verified_subtotal_chf::text,
              quoted_delivery_fee_chf::text,
              COALESCE(
                reservation_expires_at > clock_timestamp(),
                FALSE
              ) AS reservation_valid
       FROM alo_now_order_requests
       WHERE id=$1 FOR UPDATE`,
      [requestId]
    );

    const r = request.rows[0];

    if (!r) {
      return { ok: false, reason: "REQUEST_NOT_FOUND" };
    }

    // ALO_NOW_V333C_DELIVERY_GUARD
    // Parent request locked before checking delivery.
    const delivery = await authorizeAloNowDeliveryV332(
      client, requestId, r
    );
    if (!delivery.ok) {
      const reason =
        delivery.reason === "DELIVERY_CONFIRMATION_REQUIRED"
          ? "DRIVER_RESERVATION_REQUIRED"
          : delivery.reason;
      return { ok:false, reason };
    }

    if (
      r.quote_status !== "STANDARD" ||
      !r.verified_at ||
      r.verified_subtotal_chf === null ||
      r.quoted_delivery_fee_chf === null
    ) {
      return { ok: false, reason: "VERIFIED_QUOTE_REQUIRED" };
    }

    const payment = await client.query<{
      phase: string;
      payment_method: string | null;
    }>(
      `SELECT phase,payment_method
       FROM alo_now_payment_states
       WHERE request_id=$1 FOR UPDATE`,
      [requestId]
    );

    const p = payment.rows[0];

    if (
      !p ||
      p.phase !== "AWAITING_PAYMENT" ||
      p.payment_method !== "ONLINE"
    ) {
      return { ok: false, reason: "ONLINE_PAYMENT_REQUIRED" };
    }

    const existing = await client.query<{
      checkout_reference: string;
      shopify_order_id: string | null;
    }>(
      `SELECT checkout_reference,shopify_order_id
       FROM alo_now_checkout_intents
       WHERE request_id=$1 FOR UPDATE`,
      [requestId]
    );

    const previous = existing.rows[0];

    if (previous) {
      await client.query("COMMIT");
      transactionOpen = false;

      return {
        ok: true,
        intent: {
          requestId,
          checkoutReference: previous.checkout_reference,
          shopifyOrderId: previous.shopify_order_id
        },
        reused: true
      };
    }

    const reference = randomUUID();

    await client.query(
      `INSERT INTO alo_now_checkout_intents
         (request_id,checkout_reference)
       VALUES ($1,$2)`,
      [requestId, reference]
    );

    await client.query("COMMIT");
    transactionOpen = false;

    return {
      ok: true,
      intent: {
        requestId,
        checkoutReference: reference,
        shopifyOrderId: null
      },
      reused: false
    };
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

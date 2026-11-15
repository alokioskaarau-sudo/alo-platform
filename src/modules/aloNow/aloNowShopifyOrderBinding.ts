
import { db } from "../../database/db.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SHOPIFY_ORDER =
  /^gid:\/\/shopify\/Order\/[1-9][0-9]*$/;

export type BindingResult =
  | {
      ok: true;
      shopifyOrderId: string;
      expectedTotalChf: string;
      alreadyBound: boolean;
    }
  | { ok: false; reason: string };

export function calculateAloNowExpectedTotal(
  subtotal: string,
  deliveryFee: string
): string | null {
  const parse = (value: string): bigint | null => {
    if (!/^(0|[1-9]\d{0,8})\.\d{2}$/.test(value))
      return null;

    const [francs, cents] = value.split(".");
    return BigInt(francs) * 100n + BigInt(cents);
  };

  const a = parse(subtotal);
  const b = parse(deliveryFee);

  if (a === null || b === null || a <= 0n)
    return null;

  const sum = a + b;
  return `${sum / 100n}.${String(sum % 100n).padStart(2, "0")}`;
}

/**
 * INTERNAL SERVICE ONLY.
 *
 * A trusted Shopify workflow must first establish that
 * this order belongs to this ALO NOW request.
 *
 * Never expose this function directly to browser input.
 * No payment or delivery authorization happens here.
 */
export async function bindAloNowShopifyOrder(
  requestId: string,
  shopifyOrderId: string
): Promise<BindingResult> {
  if (!UUID.test(requestId))
    return { ok: false, reason: "INVALID_REQUEST_ID" };

  if (!SHOPIFY_ORDER.test(shopifyOrderId))
    return { ok: false, reason: "INVALID_SHOPIFY_ORDER_ID" };

  const client = await db.connect();
  let active = false;
  let destroy = false;

  try {
    await client.query("BEGIN");
    active = true;

    const request = await client.query<{
      status: string;
      quote_status: string;
      driver_user_id: string | null;
      reservation_valid: boolean;
      verified_subtotal_chf: string | null;
      quoted_delivery_fee_chf: string | null;
      verified_at: Date | null;
    }>(
      `SELECT status, quote_status, driver_user_id,
              COALESCE(
                reservation_expires_at > clock_timestamp(),
                FALSE
              ) AS reservation_valid,
              verified_subtotal_chf,
              quoted_delivery_fee_chf,
              verified_at
       FROM alo_now_order_requests
       WHERE id=$1 FOR UPDATE`,
      [requestId]
    );

    const record = request.rows[0];

    if (!record)
      return { ok: false, reason: "REQUEST_NOT_FOUND" };

    if (
      record.status !== "DRIVER_ACCEPTED" ||
      !record.driver_user_id ||
      !record.reservation_valid
    )
      return {
        ok: false,
        reason: "VALID_DRIVER_RESERVATION_REQUIRED"
      };

    if (
      record.quote_status !== "STANDARD" ||
      !record.verified_at ||
      record.verified_subtotal_chf === null ||
      record.quoted_delivery_fee_chf === null
    )
      return {
        ok: false,
        reason: "VERIFIED_QUOTE_REQUIRED"
      };

    const expectedTotalChf =
      calculateAloNowExpectedTotal(
        String(record.verified_subtotal_chf),
        String(record.quoted_delivery_fee_chf)
      );

    if (!expectedTotalChf)
      return { ok: false, reason: "INVALID_VERIFIED_TOTAL" };

    const state = await client.query<{
      id: string;
      phase: string;
      payment_method: string | null;
      shopify_order_id: string | null;
    }>(
      `SELECT id,phase,payment_method,shopify_order_id
       FROM alo_now_payment_states
       WHERE request_id=$1 FOR UPDATE`,
      [requestId]
    );

    const payment = state.rows[0];

    if (
      !payment ||
      payment.phase !== "AWAITING_PAYMENT" ||
      payment.payment_method !== "ONLINE"
    )
      return {
        ok: false,
        reason: "ONLINE_PAYMENT_REQUEST_REQUIRED"
      };

    if (payment.shopify_order_id) {
      if (payment.shopify_order_id !== shopifyOrderId)
        return {
          ok: false,
          reason: "SHOPIFY_ORDER_ALREADY_BOUND"
        };

      await client.query("COMMIT");
      active = false;

      return {
        ok: true,
        shopifyOrderId,
        expectedTotalChf,
        alreadyBound: true
      };
    }

    const update = await client.query(
      `UPDATE alo_now_payment_states
       SET shopify_order_id=$2,
           updated_at=NOW()
       WHERE id=$1
         AND shopify_order_id IS NULL
         AND phase='AWAITING_PAYMENT'
         AND payment_method='ONLINE'`,
      [payment.id, shopifyOrderId]
    );

    if (update.rowCount !== 1)
      throw new Error("SHOPIFY_BINDING_CONFLICT");

    await client.query("COMMIT");
    active = false;

    return {
      ok: true,
      shopifyOrderId,
      expectedTotalChf,
      alreadyBound: false
    };

  } finally {
    if (active) {
      try {
        await client.query("ROLLBACK");
      } catch {
        destroy = true;
      }
    }
    client.release(destroy);
  }
}

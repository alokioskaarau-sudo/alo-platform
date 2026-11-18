
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
  shopifyOrderId: string,
  verifiedDraftTotalChf?: string,
  verifiedDraftOrderId?: string
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

    // V2470: compare trusted Draft evidence under the request lock,
    // before any Shopify order ID can be stored.
    if (verifiedDraftTotalChf !== undefined) {
      if (
        !/^(0|[1-9][0-9]{0,8})\.[0-9]{2}$/.test(
          verifiedDraftTotalChf
        ) ||
        verifiedDraftTotalChf !== expectedTotalChf
      ) {
        return {
          ok: false,
          reason: "VERIFIED_DRAFT_TOTAL_MISMATCH"
        };
      }
    }

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

    // V2471: When the caller supplies a verified Shopify Draft ID,
    // recheck the persistent checkout identity while holding row locks.
    if (verifiedDraftOrderId !== undefined) {
      if (
        typeof verifiedDraftTotalChf !== "string" ||
        !/^gid:\/\/shopify\/DraftOrder\/[1-9][0-9]*$/
          .test(verifiedDraftOrderId)
      ) {
        return {
          ok: false,
          reason: "VERIFIED_DRAFT_EVIDENCE_INVALID"
        };
      }

      const intent = await client.query<{
        checkout_reference: string;
        shopify_order_id: string | null;
      }>(
        `SELECT checkout_reference::text, shopify_order_id
         FROM alo_now_checkout_intents
         WHERE request_id=$1
         FOR UPDATE`,
        [requestId]
      );

      const checkout = intent.rows[0];

      if (
        !checkout ||
        (
          checkout.shopify_order_id !== null &&
          checkout.shopify_order_id !== shopifyOrderId
        )
      ) {
        return {
          ok: false,
          reason: "CHECKOUT_INTENT_BINDING_CONFLICT"
        };
      }

      // V2505: A confirmed payment must already have a
      // persisted checkout/order binding. Never create it
      // retroactively during a confirmed-payment retry.
      if (
        state.rows[0]?.phase === "PAYMENT_CONFIRMED" &&
        checkout.shopify_order_id !== shopifyOrderId
      ) {
        return {
          ok: false,
          reason: "CONFIRMED_CHECKOUT_BINDING_MISMATCH"
        };
      }

      // V2473: Serialise competing bindings for this Shopify
      // order even when they target different ALO requests.
      await client.query(
        `SELECT pg_advisory_xact_lock(
           hashtextextended($1::text, 2473)
         )`,
        [shopifyOrderId]
      );

      const other = await client.query<{ used: boolean }>(
        `SELECT (
           EXISTS (
             SELECT 1
             FROM alo_now_payment_states
             WHERE request_id <> $1
               AND shopify_order_id IN ($2, $3)
           )
           OR EXISTS (
             SELECT 1
             FROM alo_now_checkout_intents
             WHERE request_id <> $1
               AND shopify_order_id IN ($2, $3)
           )
         ) AS used`,
        [
          requestId,
          shopifyOrderId,
          shopifyOrderId.split("/").pop()
        ]
      );

      if (other.rows[0]?.used !== false) {
        return {
          ok: false,
          reason: "SHOPIFY_ORDER_USED_BY_ANOTHER_REQUEST"
        };
      }

      const draft = await client.query<{
        status: string;
        checkout_reference: string;
        draft_order_id: string | null;
        total_matches: boolean;
      }>(
        `SELECT
           status,
           checkout_reference::text,
           draft_order_id,
           expected_total_chf =
             $2::numeric AS total_matches
         FROM alo_now_draft_operations
         WHERE request_id=$1
         FOR UPDATE`,
        [requestId, verifiedDraftTotalChf]
      );

      const stored = draft.rows[0];

      if (
        !stored ||
        stored.status !== "CREATED" ||
        stored.draft_order_id !== verifiedDraftOrderId ||
        stored.checkout_reference !==
          checkout.checkout_reference ||
        !stored.total_matches
      ) {
        return {
          ok: false,
          reason: "LOCKED_DRAFT_IDENTITY_MISMATCH"
        };
      }
      // V2473: Persist checkout identity in the SAME
      // transaction as the payment binding. Any later
      // conflict rolls back both changes.
      // V2506B: confirmed resume never rewrites checkout.
      // Locked identity and Draft evidence were checked above.
      if (state.rows[0]?.phase !== "PAYMENT_CONFIRMED") {
        const intentUpdate = await client.query(
          `UPDATE alo_now_checkout_intents
           SET shopify_order_id=$2,
               updated_at=NOW()
           WHERE request_id=$1
             AND (
               shopify_order_id IS NULL
               OR shopify_order_id=$2
             )`,
          [requestId, shopifyOrderId]
        );

        if (intentUpdate.rowCount !== 1) {
          throw new Error("CHECKOUT_INTENT_UPDATE_CONFLICT");
        }
      }
    }

    const payment = state.rows[0];

    if (
      !payment ||
      payment.payment_method !== "ONLINE"
    )
      return {
        ok: false,
        reason: "ONLINE_PAYMENT_REQUEST_REQUIRED"
      };

    // V2505: Resume ONLY an already confirmed, already bound
    // payment. All earlier request, reservation, quote,
    // locked Draft and competing-order checks still apply.
    if (payment.phase === "PAYMENT_CONFIRMED") {
      if (
        payment.shopify_order_id !== shopifyOrderId ||
        verifiedDraftOrderId === undefined ||
        verifiedDraftTotalChf === undefined
      ) {
        return {
          ok: false,
          reason: "CONFIRMED_PAYMENT_BINDING_INVALID"
        };
      }

      await client.query("COMMIT");
      active = false;

      return {
        ok: true,
        shopifyOrderId,
        expectedTotalChf,
        alreadyBound: true
      };
    }

    if (payment.phase !== "AWAITING_PAYMENT")
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

import { randomUUID } from "node:crypto";

import {
  decideTipReservationConflictV173
} from "./aloNowTipReservationConflict.v173.js";

import type {
  ExistingTipIntentV173
} from "./aloNowTipReservationConflict.v173.js";

import {
  evaluateTipEligibilityV171
} from "./aloNowTipEligibility.v171.js";

import type {
  TipDeliveryRowV171
} from "./aloNowTipEligibility.v171.js";

/**
 * ALO NOW V172
 *
 * Internal reservation only.
 * No public route, payment request, Shopify mutation
 * or wallet write.
 *
 * Database writes restricted to an explicit local-test
 * environment. Production activation needs a separate
 * security review.
 */

type ReservationResult =
  | {
      ok: true;
      action: "RESERVED" | "ALREADY_RESERVED";
      checkoutReference?: string;
    }
  | {
      ok: false;
      reason: string;
    };

type ReservationInput = {
  requestId: string;
  amountRappen: number;
  taxable: boolean;
};

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const LOCAL_ONLY =
  process.env.NODE_ENV === "test" &&
  process.env.ALO_RUNTIME_MODE === "local_test" &&
  process.env.ALO_NOW_TIP_LOCAL_RESERVATIONS_ENABLED === "true";

export async function reserveTipCheckoutV172(
  input: ReservationInput
): Promise<ReservationResult> {
  // This function is intentionally unavailable in
  // production regardless of other feature flags.
  if (!LOCAL_ONLY) {
    return {
      ok: false,
      reason: "TIP_RESERVATIONS_DISABLED"
    };
  }

  if (
    !UUID.test(input.requestId) ||
    !Number.isSafeInteger(input.amountRappen) ||
    input.amountRappen < 100 ||
    input.amountRappen > 50000 ||
    typeof input.taxable !== "boolean"
  ) {
    return {
      ok: false,
      reason: "INVALID_RESERVATION_INPUT"
    };
  }

  const { db } = await import("../../database/db.js");
  const client = await db.connect();

  let active = false;
  let destroy = false;

  try {
    await client.query("BEGIN");
    active = true;

    // Prevent an unbounded wait on a competing lock.
    await client.query(
      "SET LOCAL lock_timeout = '3000ms'"
    );

    // Lock request first, following the existing
    // parent-first lifecycle locking convention.
    const request = await client.query(
      `SELECT id
       FROM alo_now_order_requests
       WHERE id=$1::uuid
       FOR UPDATE`,
      [input.requestId]
    );

    if (request.rows.length !== 1) {
      return {
        ok: false,
        reason: "REQUEST_NOT_FOUND"
      };
    }

    const payment = await client.query<{
      shopify_order_id: string | null;
      phase: string;
      payment_method: string | null;
    }>(
      `SELECT
         shopify_order_id,
         phase,
         payment_method
       FROM alo_now_payment_states
       WHERE request_id=$1::uuid
       FOR UPDATE`,
      [input.requestId]
    );

    if (payment.rows.length !== 1) {
      return {
        ok: false,
        reason: "PAYMENT_STATE_AMBIGUOUS"
      };
    }

    const p = payment.rows[0];

    if (
      p.phase !== "PAYMENT_CONFIRMED" ||
      p.payment_method !== "ONLINE" ||
      !p.shopify_order_id
    ) {
      return {
        ok: false,
        reason: "ONLINE_PAYMENT_NOT_CONFIRMED"
      };
    }

    const delivery = await client.query<{
      shopify_order_id: string;
      delivery_status: string;
      assigned_driver_user_id: string | null;
    }>(
      `SELECT
         shopify_order_id,
         delivery_status,
         assigned_driver_user_id::text
           AS assigned_driver_user_id
       FROM alo_now_deliveries
       WHERE shopify_order_id=$1
       FOR UPDATE`,
      [p.shopify_order_id]
    );

    const rows: TipDeliveryRowV171[] =
      delivery.rows.map(d => ({
        request_id: input.requestId,
        shopify_order_id: d.shopify_order_id,
        payment_phase: p.phase,
        delivery_status: d.delivery_status,
        driver_user_id: d.assigned_driver_user_id
      }));

    const eligibility =
      evaluateTipEligibilityV171(input.requestId, rows);

    if (!eligibility.eligible) {
      return {
        ok: false,
        reason: eligibility.reason
      };
    }

    // Protect against running this service before
    // the V171 migration has been applied.
    const schema = await client.query<{
      ready: boolean;
    }>(
      `SELECT to_regclass(
         'public.alo_now_tip_checkout_intents_v171'
       ) IS NOT NULL AS ready`
    );

    if (schema.rows[0]?.ready !== true) {
      return {
        ok: false,
        reason: "TIP_RESERVATION_SCHEMA_NOT_READY"
      };
    }

    // A reservation is permanent until explicitly
    // reconciled. Do not create another Shopify draft
    // simply because an earlier attempt timed out.
    const reference = randomUUID();

    const inserted = await client.query<{
      checkout_reference: string;
    }>(
      `INSERT INTO alo_now_tip_checkout_intents_v171 (
         request_id,
         checkout_reference,
         original_shopify_order_id,
         amount_rappen,
         currency,
         taxable,
         status
       ) VALUES (
         $1::uuid,$2::uuid,$3,$4,'CHF',$5,'RESERVED'
       )
       ON CONFLICT DO NOTHING
       RETURNING checkout_reference::text`,
      [
        input.requestId,
        reference,
        eligibility.originalOrderId,
        input.amountRappen,
        input.taxable
      ]
    );

    if (inserted.rowCount !== 1) {
      // Do not interpret an arbitrary unique-key
      // conflict as the same checkout attempt.
      const previous =
        await client.query<ExistingTipIntentV173>(
          `SELECT
             original_shopify_order_id,
             amount_rappen::text AS amount_rappen,
             taxable,
             status,
             draft_order_id
           FROM alo_now_tip_checkout_intents_v171
           WHERE request_id=$1::uuid
           FOR UPDATE`,
          [input.requestId]
        );

      const decision =
        decideTipReservationConflictV173(
          previous.rows,
          {
            originalOrderId:
              eligibility.originalOrderId,
            amountRappen: input.amountRappen,
            taxable: input.taxable
          }
        );

      if (!decision.ok) {
        return decision;
      }

      // The same reservation already exists.
      // Never create another Shopify draft here.
      await client.query("COMMIT");
      active = false;

      return {
        ok: true,
        action: decision.action
      };
    }

    await client.query("COMMIT");
    active = false;

    return {
      ok: true,
      action: "RESERVED",
      checkoutReference:
        inserted.rows[0].checkout_reference
    };
  } catch {
    return {
      ok: false,
      reason: "TIP_RESERVATION_FAILED"
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

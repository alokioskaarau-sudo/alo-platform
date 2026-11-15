/**
 * ALO NOW V175
 *
 * Internal, locally gated Shopify-draft creation claim.
 *
 * No Shopify request, no payment, no wallet credit.
 * Never retry an uncertain Shopify draft automatically.
 */

import {
  evaluateTipEligibilityV171
} from "./aloNowTipEligibility.v171.js";

export type TipDraftClaimRowV175 = {
  checkout_reference: string;
  original_shopify_order_id: string;
  amount_rappen: string;
  currency: string;
  taxable: boolean;
  status: string;
  draft_order_id: string | null;
};

export type TipDraftClaimDecisionV175 =
  | { ok: true; action: "CLAIMABLE" }
  | { ok: false; reason: string };

export type TipDraftClaimResultV175 =
  | {
      ok: true;
      action: "CLAIMED";
      checkoutReference: string;
      originalOrderId: string;
      amountRappen: number;
      taxable: boolean;
    }
  | { ok: false; reason: string };

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ORDER_PREFIX = "gid://shopify/Order/";

function validOrderId(value: string): boolean {
  return (
    value.startsWith(ORDER_PREFIX) &&
    /^[1-9][0-9]*$/.test(
      value.slice(ORDER_PREFIX.length)
    )
  );
}

export function decideTipDraftClaimV175(
  rows: TipDraftClaimRowV175[],
  checkoutReference: string
): TipDraftClaimDecisionV175 {
  if (!UUID.test(checkoutReference)) {
    return { ok: false, reason: "INVALID_REFERENCE" };
  }

  if (rows.length !== 1) {
    return { ok: false, reason: "INTENT_NOT_UNIQUE" };
  }

  const row = rows[0];

  if (
    row.checkout_reference.toLowerCase() !==
    checkoutReference.toLowerCase()
  ) {
    return { ok: false, reason: "REFERENCE_MISMATCH" };
  }

  if (
    !validOrderId(row.original_shopify_order_id) ||
    !/^[0-9]+$/.test(row.amount_rappen) ||
    Number(row.amount_rappen) < 100 ||
    Number(row.amount_rappen) > 50000 ||
    row.currency !== "CHF"
  ) {
    return { ok: false, reason: "INTENT_INVALID" };
  }

  if (
    row.status === "CREATE_UNCERTAIN" ||
    row.status === "DRAFT_CREATED"
  ) {
    return {
      ok: false,
      reason: "SHOPIFY_RECONCILIATION_REQUIRED"
    };
  }

  if (
    row.status !== "RESERVED" ||
    row.draft_order_id !== null
  ) {
    return {
      ok: false,
      reason: "INTENT_NOT_CLAIMABLE"
    };
  }

  return { ok: true, action: "CLAIMABLE" };
}

export async function claimTipDraftCreationV175(
  requestId: string,
  checkoutReference: string
): Promise<TipDraftClaimResultV175> {
  // This gate must remain local-test-only.
  if (
    process.env.NODE_ENV !== "test" ||
    process.env.ALO_RUNTIME_MODE !== "local_test" ||
    process.env.ALO_NOW_TIP_LOCAL_RESERVATIONS_ENABLED !== "true"
  ) {
    return {
      ok: false,
      reason: "TIP_DRAFT_CLAIMS_DISABLED"
    };
  }

  if (
    !UUID.test(requestId) ||
    !UUID.test(checkoutReference)
  ) {
    return {
      ok: false,
      reason: "INVALID_IDENTITY"
    };
  }

  const { db } = await import("../../database/db.js");

  const client = await db.connect();
  let transactionOpen = false;
  let destroy = false;

  try {
    await client.query("BEGIN");
    transactionOpen = true;

    await client.query(
      "SET LOCAL lock_timeout = '3000ms'"
    );

    // Keep the parent-first lock convention.
    const request = await client.query(
      `SELECT id
       FROM alo_now_order_requests
       WHERE id = $1::uuid
       FOR UPDATE`,
      [requestId]
    );

    if (request.rowCount !== 1) {
      return {
        ok: false,
        reason: "REQUEST_NOT_FOUND"
      };
    }

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
        reason: "TIP_SCHEMA_NOT_READY"
      };
    }

    // Re-read payment and delivery under transaction locks.
    // An old checkout reservation is not current delivery
    // authorization.
    const payments = await client.query<{
      shopify_order_id: string | null;
      phase: string;
      payment_method: string | null;
    }>(
      `SELECT shopify_order_id,phase,payment_method
       FROM alo_now_payment_states
       WHERE request_id=$1::uuid
       FOR UPDATE`,
      [requestId]
    );

    if (payments.rows.length !== 1) {
      return {
        ok: false,
        reason: "PAYMENT_BINDING_NOT_UNIQUE"
      };
    }

    const payment = payments.rows[0];

    if (
      payment.phase !== "PAYMENT_CONFIRMED" ||
      payment.payment_method !== "ONLINE" ||
      !payment.shopify_order_id
    ) {
      return {
        ok: false,
        reason: "ORIGINAL_PAYMENT_NOT_CONFIRMED"
      };
    }

    const deliveries = await client.query<{
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
      [payment.shopify_order_id]
    );

    const eligibility = evaluateTipEligibilityV171(
      requestId,
      deliveries.rows.map(row => ({
        request_id: requestId,
        shopify_order_id: row.shopify_order_id,
        payment_phase: payment.phase,
        delivery_status: row.delivery_status,
        driver_user_id: row.assigned_driver_user_id
      }))
    );

    if (!eligibility.eligible) {
      return {
        ok: false,
        reason: eligibility.reason
      };
    }

    const intent = await client.query<TipDraftClaimRowV175>(
      `SELECT
         checkout_reference::text,
         original_shopify_order_id,
         amount_rappen::text,
         currency,
         taxable,
         status,
         draft_order_id
       FROM alo_now_tip_checkout_intents_v171
       WHERE request_id=$1::uuid
       FOR UPDATE`,
      [requestId]
    );

    const decision = decideTipDraftClaimV175(
      intent.rows,
      checkoutReference
    );

    if (!decision.ok) return decision;

    const row = intent.rows[0];

    if (
      row.original_shopify_order_id !==
      eligibility.originalOrderId
    ) {
      return {
        ok: false,
        reason: "ORIGINAL_ORDER_BINDING_CHANGED"
      };
    }

    if (typeof row.taxable !== "boolean") {
      return {
        ok: false,
        reason: "TIP_TAX_POLICY_INVALID"
      };
    }

    // Persist uncertainty BEFORE any future Shopify
    // mutation. Do not make the external call here.
    const updated = await client.query(
      `UPDATE alo_now_tip_checkout_intents_v171
       SET status='CREATE_UNCERTAIN',
           updated_at=NOW()
       WHERE request_id=$1::uuid
         AND checkout_reference=$2::uuid
         AND original_shopify_order_id=$3
         AND amount_rappen=$4::bigint
         AND currency='CHF'
         AND taxable=$5
         AND status='RESERVED'
         AND draft_order_id IS NULL`,
      [
        requestId,
        checkoutReference,
        row.original_shopify_order_id,
        row.amount_rappen,
        row.taxable
      ]
    );

    if (updated.rowCount !== 1) {
      return {
        ok: false,
        reason: "DRAFT_CLAIM_CONFLICT"
      };
    }

    await client.query("COMMIT");
    transactionOpen = false;

    return {
      ok: true,
      action: "CLAIMED",
      checkoutReference,
      originalOrderId: row.original_shopify_order_id,
      amountRappen: Number(row.amount_rappen),
      taxable: row.taxable
    };
  } catch {
    return {
      ok: false,
      reason: "TIP_DRAFT_CLAIM_FAILED"
    };
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

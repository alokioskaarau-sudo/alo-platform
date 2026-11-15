/**
 * ALO NOW V175
 *
 * Internal, locally gated Shopify-draft creation claim.
 *
 * No Shopify request, no payment, no wallet credit.
 * Never retry an uncertain Shopify draft automatically.
 */

export type TipDraftClaimRowV175 = {
  checkout_reference: string;
  original_shopify_order_id: string;
  amount_rappen: string;
  currency: string;
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

    const intent = await client.query<TipDraftClaimRowV175>(
      `SELECT
         checkout_reference::text,
         original_shopify_order_id,
         amount_rappen::text,
         currency,
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
         AND status='RESERVED'
         AND draft_order_id IS NULL`,
      [
        requestId,
        checkoutReference,
        row.original_shopify_order_id,
        row.amount_rappen
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
      amountRappen: Number(row.amount_rappen)
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

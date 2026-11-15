import {
  parseAloNowDraftCreateResponse
} from "./aloNowDraftOrderAdapter.js";

/**
 * ALO NOW V178
 *
 * Local-test-only draft-result reconciliation.
 *
 * Shopify writes are NOT performed here.
 * Input must eventually originate from the trusted
 * server-side Shopify transport, never a customer.
 *
 * No invoice link is exposed.
 * No payment or wallet credit is authorized.
 */

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const DRAFT_PREFIX = "gid://shopify/DraftOrder/";

function validDraftId(value: string): boolean {
  return (
    value.startsWith(DRAFT_PREFIX) &&
    /^[1-9][0-9]*$/.test(
      value.slice(DRAFT_PREFIX.length)
    )
  );
}

function amountCHF(rappen: number): string | null {
  if (
    !Number.isSafeInteger(rappen) ||
    rappen < 100 ||
    rappen > 50000
  ) return null;

  return (
    Math.floor(rappen / 100) +
    "." +
    String(rappen % 100).padStart(2, "0")
  );
}

export type TipDraftRecordV178 = {
  request_id: string;
  checkout_reference: string;
  original_shopify_order_id: string;
  amount_rappen: string;
  status: string;
  draft_order_id: string | null;
};

export type TipDraftVerifiedV178 =
  | {
      ok: true;
      draftOrderId: string;
      expectedTotalCHF: string;
      walletAuthorized: false;
    }
  | {
      ok: false;
      reason: string;
    };

/**
 * The Shopify response must confirm all four
 * checkout identity attributes.
 *
 * Duplicate or missing attributes fail closed.
 * The response must originate from trusted Shopify
 * server-side transport, not a browser request.
 */
function matchesTipDraftAttributesV182(
  response: unknown,
  requestId: string,
  checkoutReference: string,
  originalOrderId: string
): boolean {
  if (
    response === null ||
    typeof response !== "object"
  ) return false;

  const root = response as Record<string, unknown>;

  const data =
    root.data && typeof root.data === "object"
      ? root.data as Record<string, unknown>
      : root;

  const mutation = data.draftOrderCreate;

  if (
    mutation === null ||
    typeof mutation !== "object"
  ) return false;

  const draft = (
    mutation as Record<string, unknown>
  ).draftOrder;

  if (
    draft === null ||
    typeof draft !== "object"
  ) return false;

  const attributes = (
    draft as Record<string, unknown>
  ).customAttributes;

  if (
    !Array.isArray(attributes) ||
    attributes.length !== 4
  ) return false;

  const values = new Map<string, string>();

  for (const attribute of attributes) {
    if (
      attribute === null ||
      typeof attribute !== "object"
    ) return false;

    const item = attribute as Record<string, unknown>;

    if (
      typeof item.key !== "string" ||
      typeof item.value !== "string" ||
      values.has(item.key)
    ) return false;

    values.set(item.key, item.value);
  }

  return (
    values.get("alo_now_tip_purpose") ===
      "POST_DELIVERY_TIP" &&
    values.get("alo_now_request_id") ===
      requestId &&
    values.get("alo_now_original_order_id") ===
      originalOrderId &&
    values.get("alo_now_tip_checkout_reference") ===
      checkoutReference
  );
}

export function verifyTipDraftResultV178(
  requestId: string,
  checkoutReference: string,
  records: TipDraftRecordV178[],
  shopifyResponse: unknown
): TipDraftVerifiedV178 {
  if (
    !UUID.test(requestId) ||
    !UUID.test(checkoutReference) ||
    records.length !== 1
  ) {
    return {
      ok: false,
      reason: "TIP_DRAFT_IDENTITY_INVALID"
    };
  }

  const record = records[0];

  if (
    record.request_id.toLowerCase() !==
      requestId.toLowerCase() ||
    record.checkout_reference.toLowerCase() !==
      checkoutReference.toLowerCase() ||
    record.status !== "CREATE_UNCERTAIN" ||
    record.draft_order_id !== null ||
    !record.original_shopify_order_id.startsWith(
      "gid://shopify/Order/"
    )
  ) {
    return {
      ok: false,
      reason: "TIP_DRAFT_STATE_MISMATCH"
    };
  }

  const expected = amountCHF(
    Number(record.amount_rappen)
  );

  if (
    expected === null ||
    String(Number(record.amount_rappen)) !==
      record.amount_rappen
  ) {
    return {
      ok: false,
      reason: "TIP_AMOUNT_INVALID"
    };
  }

  const parsed = parseAloNowDraftCreateResponse(
    shopifyResponse,
    expected
  );

  if (!parsed.ok) {
    return {
      ok: false,
      reason: parsed.reason
    };
  }

  if (!validDraftId(parsed.draftOrderId)) {
    return {
      ok: false,
      reason: "SHOPIFY_DRAFT_ID_INVALID"
    };
  }

  if (
    !matchesTipDraftAttributesV182(
      shopifyResponse,
      requestId,
      checkoutReference,
      record.original_shopify_order_id
    )
  ) {
    return {
      ok: false,
      reason: "SHOPIFY_DRAFT_IDENTITY_MISMATCH"
    };
  }

  return {
    ok: true,
    draftOrderId: parsed.draftOrderId,
    expectedTotalCHF: expected,
    walletAuthorized: false
  };
}

export async function confirmTipDraftResultV178(
  requestId: string,
  checkoutReference: string,
  trustedShopifyResponse: unknown
): Promise<
  | { ok: true; status: "DRAFT_CREATED" }
  | { ok: false; reason: string }
> {
  if (
    process.env.NODE_ENV !== "test" ||
    process.env.ALO_RUNTIME_MODE !== "local_test" ||
    process.env.ALO_NOW_TIP_LOCAL_RESERVATIONS_ENABLED !==
      "true"
  ) {
    return {
      ok: false,
      reason: "TIP_DRAFT_CONFIRMATION_DISABLED"
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

  let active = false;
  let destroy = false;

  try {
    await client.query("BEGIN");
    active = true;

    await client.query(
      "SET LOCAL lock_timeout = '3000ms'"
    );

    const request = await client.query(
      `SELECT id
       FROM alo_now_order_requests
       WHERE id=$1::uuid
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

    const intent = await client.query<TipDraftRecordV178>(
      `SELECT
         request_id::text,
         checkout_reference::text,
         original_shopify_order_id,
         amount_rappen::text,
         status,
         draft_order_id
       FROM alo_now_tip_checkout_intents_v171
       WHERE request_id=$1::uuid
       FOR UPDATE`,
      [requestId]
    );

    const verified = verifyTipDraftResultV178(
      requestId,
      checkoutReference,
      intent.rows,
      trustedShopifyResponse
    );

    if (!verified.ok) {
      // Preserve CREATE_UNCERTAIN.
      // The result must be reconciled, never blindly
      // retried as another Shopify creation.
      return verified;
    }

    const updated = await client.query(
      `UPDATE alo_now_tip_checkout_intents_v171
       SET status='DRAFT_CREATED',
           draft_order_id=$3,
           updated_at=NOW()
       WHERE request_id=$1::uuid
         AND checkout_reference=$2::uuid
         AND status='CREATE_UNCERTAIN'
         AND draft_order_id IS NULL`,
      [
        requestId,
        checkoutReference,
        verified.draftOrderId
      ]
    );

    if (updated.rowCount !== 1) {
      return {
        ok: false,
        reason: "TIP_DRAFT_UPDATE_CONFLICT"
      };
    }

    await client.query("COMMIT");
    active = false;

    return {
      ok: true,
      status: "DRAFT_CREATED"
    };
  } catch {
    return {
      ok: false,
      reason: "TIP_DRAFT_CONFIRMATION_FAILED"
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

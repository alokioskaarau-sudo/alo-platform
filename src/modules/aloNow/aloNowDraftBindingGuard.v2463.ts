
import { db } from "../../database/db.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type DraftRow = {
  workspace: string;
  checkout_reference: string;
  intent_reference: string | null;
  draft_status: string;
  draft_order_id: string | null;
  expected_total_chf: string;
  phase: string | null;
  payment_method: string | null;
  payment_order_id: string | null;
  intent_order_id: string | null;
};

export async function verifyAloNowCreatedDraftV2463(
  requestId: string
) {
  if (!UUID.test(requestId)) {
    return {
      ok: false as const,
      reason: "INVALID_REQUEST_ID"
    };
  }

  try {
    const result = await db.query<DraftRow>(`
      SELECT
        r.workspace,
        d.checkout_reference::text,
        i.checkout_reference::text AS intent_reference,
        d.status AS draft_status,
        d.draft_order_id,
        d.expected_total_chf::text,
        p.phase,
        p.payment_method,
        p.shopify_order_id AS payment_order_id,
        i.shopify_order_id AS intent_order_id
      FROM alo_now_draft_operations d
      JOIN alo_now_order_requests r
        ON r.id = d.request_id
      LEFT JOIN alo_now_checkout_intents i
        ON i.request_id = d.request_id
      LEFT JOIN alo_now_payment_states p
        ON p.request_id = d.request_id
      WHERE d.request_id = $1
    `, [requestId]);

    if (result.rows.length !== 1) {
      return {
        ok: false as const,
        reason: "DRAFT_NOT_FOUND"
      };
    }

    const row = result.rows[0];

    if (row.workspace !== "AARAU") {
      return {
        ok: false as const,
        reason: "AARAU_ONLY"
      };
    }

    if (
      row.draft_status !== "CREATED" ||
      !row.draft_order_id ||
      !/^gid:\/\/shopify\/DraftOrder\/[1-9][0-9]*$/
        .test(row.draft_order_id)
    ) {
      return {
        ok: false as const,
        reason: "DRAFT_NOT_CREATED"
      };
    }

    if (
      !UUID.test(row.checkout_reference) ||
      row.checkout_reference !== row.intent_reference
    ) {
      return {
        ok: false as const,
        reason: "CHECKOUT_REFERENCE_MISMATCH"
      };
    }

    if (
      !/^(0|[1-9][0-9]{0,8})(?:\.[0-9]{1,2})?$/
        .test(row.expected_total_chf) ||
      Number(row.expected_total_chf) <= 0
    ) {
      return {
        ok: false as const,
        reason: "EXPECTED_TOTAL_INVALID"
      };
    }

    if (
      row.payment_method !== "ONLINE" ||
      !["AWAITING_PAYMENT", "PAYMENT_CONFIRMED"]
        .includes(row.phase ?? "")
    ) {
      return {
        ok: false as const,
        reason: "PAYMENT_STATE_INVALID"
      };
    }

    if (
      row.intent_order_id !== null &&
      row.payment_order_id !== null &&
      row.intent_order_id !== row.payment_order_id
    ) {
      return {
        ok: false as const,
        reason: "ORDER_BINDING_CONFLICT"
      };
    }

    return {
      ok: true as const,
      draftOrderId: row.draft_order_id,
      checkoutReference: row.checkout_reference,
      expectedTotalCHF:
        Number(row.expected_total_chf).toFixed(2)
    };
  } catch {
    return {
      ok: false as const,
      reason: "DRAFT_DATABASE_UNAVAILABLE"
    };
  }
}

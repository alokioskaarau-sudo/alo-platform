import { db } from "../../database/db.js";
import {
  parseAloNowDraftCreateResponse
} from "./aloNowDraftOrderAdapter.js";

// Correct UUID format: 8-4-4-4-12.
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Result =
  | { ok: true; status: "CREATED"; draftOrderId: string }
  | { ok: true; status: "RECONCILE_REQUIRED" }
  | { ok: false; reason: string };

/**
 * Internal-only persistence of simulated or trusted outcomes.
 * Does not contact Shopify or establish origin of a DraftOrder.
 *
 * Must never be exposed directly to customer input.
 * Network errors must not trigger an automatic create retry.
 */
export async function recordAloNowDraftOutcome(
  requestId: string,
  attemptId: string,
  response: unknown
): Promise<Result> {
  if (!UUID.test(requestId) || !UUID.test(attemptId))
    return { ok: false, reason: "INVALID_OUTCOME_IDENTITY" };

  const client = await db.connect();
  let active = false;
  let destroy = false;

  try {
    await client.query("BEGIN");
    active = true;

    await client.query("SET LOCAL lock_timeout = '3s'");
    await client.query("SET LOCAL statement_timeout = '12s'");

    const request = await client.query(
      `SELECT id FROM alo_now_order_requests
       WHERE id=$1 FOR UPDATE`,
      [requestId]
    );

    if (request.rowCount !== 1)
      return { ok: false, reason: "REQUEST_NOT_FOUND" };

    const operation = await client.query<{
      status: string;
      attempt_id: string | null;
      expected_total_chf: string;
      draft_order_id: string | null;
      checkout_reference: string;
      intent_reference: string | null;
    }>(
      `SELECT o.status,
              o.attempt_id::text,
              o.expected_total_chf::text,
              o.draft_order_id,
              o.checkout_reference::text,
              i.checkout_reference::text AS intent_reference
       FROM alo_now_draft_operations o
       LEFT JOIN alo_now_checkout_intents i
         ON i.request_id=o.request_id
       WHERE o.request_id=$1
       FOR UPDATE OF o`,
      [requestId]
    );

    const row = operation.rows[0];

    if (!row)
      return { ok: false, reason: "DRAFT_OPERATION_NOT_FOUND" };

    if (row.attempt_id !== attemptId)
      return { ok: false, reason: "DRAFT_ATTEMPT_MISMATCH" };

    if (!row.intent_reference ||
        row.intent_reference !== row.checkout_reference)
      return { ok: false, reason: "CHECKOUT_IDENTITY_CHANGED" };

    if (row.status !== "CREATING")
      return { ok: false, reason: "DRAFT_NOT_CREATING" };

    const parsed = parseAloNowDraftCreateResponse(
      response,
      row.expected_total_chf
    );

    if (!parsed.ok) {
      const updated = await client.query(
        `UPDATE alo_now_draft_operations
         SET status='RECONCILE_REQUIRED'
         WHERE request_id=$1
           AND attempt_id=$2
           AND status='CREATING'
         RETURNING request_id`,
        [requestId, attemptId]
      );

      if (updated.rowCount !== 1)
        throw new Error("DRAFT_OUTCOME_CONFLICT");

      await client.query("COMMIT");
      active = false;

      return { ok: true, status: "RECONCILE_REQUIRED" };
    }

    const updated = await client.query(
      `UPDATE alo_now_draft_operations
       SET status='CREATED',draft_order_id=$3
       WHERE request_id=$1
         AND attempt_id=$2
         AND status='CREATING'
         AND draft_order_id IS NULL
       RETURNING request_id`,
      [requestId, attemptId, parsed.draftOrderId]
    );

    if (updated.rowCount !== 1)
      throw new Error("DRAFT_OUTCOME_CONFLICT");

    await client.query("COMMIT");
    active = false;

    return {
      ok: true,
      status: "CREATED",
      draftOrderId: parsed.draftOrderId
    };
  } catch {
    destroy = true;
    return { ok: false, reason: "DRAFT_OUTCOME_UNAVAILABLE" };
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

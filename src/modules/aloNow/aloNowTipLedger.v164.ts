import { randomUUID } from "node:crypto";
import { db } from "../../database/db.js";
import type {
  TipCreditDecisionV163
} from "./aloNowTipCreditDecision.v163.js";

/**
 * V164: internal-only, disabled by default.
 *
 * This is NOT a payment verifier.
 * The caller must supply a trusted payment-provider reader.
 * Never supply payment evidence from an HTTP request body.
 *
 * Only one online tip per delivery order is supported
 * by the current database uniqueness constraint.
 */

export type TipCaptureEvidenceV164 = {
  provider: "SHOPIFY";
  purpose: "POST_DELIVERY_TIP";
  captureId: string;
  orderId: string;
  status: "CAPTURED" | "PENDING" | "FAILED";
  amountRappen: number;
  refundedRappen: number;
  currency: string;
};

export type TipCaptureReaderV164 = (
  captureId: string
) => Promise<TipCaptureEvidenceV164 | null>;

export type TipLedgerResultV164 =
  | "RECORDED"
  | "ALREADY_RECORDED"
  | "BLOCKED"
  | "CONFLICT";

export function matchesVerifiedTipCaptureV164(
  decision: TipCreditDecisionV163,
  evidence: TipCaptureEvidenceV164 | null
): boolean {
  if (!decision.ok || !evidence) return false;

  return (
    evidence.provider === "SHOPIFY" &&
    evidence.purpose === "POST_DELIVERY_TIP" &&
    evidence.status === "CAPTURED" &&
    evidence.orderId === decision.orderId &&
    evidence.currency === "CHF" &&
    evidence.amountRappen === decision.amountRappen &&
    Number.isSafeInteger(evidence.amountRappen) &&
    evidence.amountRappen > 0 &&
    evidence.refundedRappen === 0 &&
    evidence.captureId.length > 0 &&
    decision.sourceReference ===
      `shopify-tip-capture:${evidence.captureId}`
  );
}

export async function recordVerifiedTipV164(
  decision: TipCreditDecisionV163,
  readCaptureFromProvider: TipCaptureReaderV164
): Promise<TipLedgerResultV164> {
  if (
    process.env.ALO_NOW_TIP_LEDGER_WRITES_ENABLED !== "true"
  ) {
    return "BLOCKED";
  }

  if (!decision.ok) return "BLOCKED";

  // Must be a trusted, fresh server-side provider lookup.
  // No implementation is connected yet.
  const captureId = decision.sourceReference.replace(
    /^shopify-tip-capture:/,
    ""
  );

  const evidence = await readCaptureFromProvider(captureId);

  if (!matchesVerifiedTipCaptureV164(decision, evidence)) {
    return "BLOCKED";
  }

  const client = await db.connect();

  let transactionOpen = false;

  try {
    await client.query("BEGIN");
    transactionOpen = true;

    // V165: refuse writes unless PostgreSQL enforces
    // global capture-source uniqueness.
    const sourceIndex = await client.query<{
      ready: boolean;
    }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
         WHERE schemaname = 'public'
           AND tablename = 'alo_now_driver_finance_events'
           AND indexname = 'alo_now_tip_source_unique_v165'
           AND indexdef ILIKE '%UNIQUE INDEX%'
           AND indexdef ILIKE '%(source_reference)%'
           AND indexdef ILIKE '%ONLINE_TIP_EARNED%'
       ) AS ready`
    );

    if (sourceIndex.rows[0]?.ready !== true) {
      await client.query("ROLLBACK");
      transactionOpen = false;
      return "BLOCKED";
    }

    const linked = await client.query<{
      workspace: string;
      phase: string;
      shopify_order_id: string;
      delivery_status: string;
      driver_user_id: string | null;
    }>(
      `SELECT
         r.workspace,
         p.phase,
         p.shopify_order_id,
         d.delivery_status,
         d.assigned_driver_user_id::text
           AS driver_user_id
       FROM alo_now_payment_states p
       JOIN alo_now_order_requests r
         ON r.id = p.request_id
       JOIN alo_now_deliveries d
         ON d.shopify_order_id = p.shopify_order_id
       WHERE p.shopify_order_id = $1
       FOR UPDATE OF p, r, d`,
      [decision.orderId]
    );

    if (linked.rows.length !== 1) {
      await client.query("ROLLBACK");
      transactionOpen = false;
      return "BLOCKED";
    }

    const order = linked.rows[0];

    if (
      order.workspace !== decision.workspace ||
      order.shopify_order_id !== decision.orderId ||
      order.delivery_status !== "DELIVERED" ||
      order.driver_user_id !== decision.driverUserId ||
      !["PAYMENT_CONFIRMED", "CASH_CONFIRMED"]
        .includes(order.phase)
    ) {
      await client.query("ROLLBACK");
      transactionOpen = false;
      return "BLOCKED";
    }

    // The row lock serializes competing tip credits
    // for the same delivery order.
    const existing = await client.query<{
      event_key: string;
      driver_user_id: string;
      workspace: string;
      amount_rappen: string;
      currency: string;
      source_reference: string;
    }>(
      `SELECT
         event_key,
         driver_user_id,
         workspace,
         amount_rappen::text,
         currency,
         source_reference
       FROM alo_now_driver_finance_events
       WHERE order_id = $1
         AND event_type = 'ONLINE_TIP_EARNED'
       LIMIT 2`,
      [decision.orderId]
    );

    if (existing.rows.length > 0) {
      const old = existing.rows[0];

      const identical =
        existing.rows.length === 1 &&
        old.event_key === decision.eventKey &&
        old.driver_user_id === decision.driverUserId &&
        old.workspace === decision.workspace &&
        old.amount_rappen ===
          String(decision.amountRappen) &&
        old.currency === decision.currency &&
        old.source_reference ===
          decision.sourceReference;

      await client.query("COMMIT");
      transactionOpen = false;

      return identical ? "ALREADY_RECORDED" : "CONFLICT";
    }

    // Prevent obvious reuse of the same provider reference
    // across different orders. A global unique index is
    // still required before enabling production writes.
    const sourceUsage = await client.query(
      `SELECT 1
       FROM alo_now_driver_finance_events
       WHERE event_type = 'ONLINE_TIP_EARNED'
         AND source_reference = $1
       LIMIT 1`,
      [decision.sourceReference]
    );

    if (sourceUsage.rows.length !== 0) {
      await client.query("ROLLBACK");
      transactionOpen = false;
      return "CONFLICT";
    }

    await client.query(
      `INSERT INTO alo_now_driver_finance_events
        (
          id,
          event_key,
          driver_user_id,
          workspace,
          cash_shift_id,
          order_id,
          event_type,
          amount_rappen,
          currency,
          source_reference,
          actor_user_id,
          reason
        )
       VALUES (
         $1, $2, $3, $4, NULL, $5,
         'ONLINE_TIP_EARNED',
         $6, 'CHF', $7,
         'SYSTEM:VERIFIED_TIP',
         'POST_DELIVERY_TIP'
       )`,
      [
        randomUUID(),
        decision.eventKey,
        decision.driverUserId,
        decision.workspace,
        decision.orderId,
        decision.amountRappen,
        decision.sourceReference
      ]
    );

    await client.query("COMMIT");
    transactionOpen = false;
    return "RECORDED";

  } catch (error) {
    if (transactionOpen) {
      await client.query("ROLLBACK").catch(() => {});
    }
    throw error;
  } finally {
    client.release();
  }
}

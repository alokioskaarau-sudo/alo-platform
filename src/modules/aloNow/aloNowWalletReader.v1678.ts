
/**
 * ALO NOW V1678
 * Server-side read-only evidence discovery.
 *
 * No payment verification, no wallet entitlement,
 * no client-controlled authorization and no payouts.
 */

export type WorkspaceV1678 = "AARAU" | "OLTEN";

export type WalletCandidateV1678 = {
  orderId: string;
  deliveryStatus: string;
  paymentPhase: string | null;
  paymentMethod: string | null;
  handoffState: string | null;
  settlementState: string | null;
  financeEventCount: number;
  blockers: string[];
  payableOutstandingRappen: null;
  payoutEnabled: false;
};

type Row = {
  order_id: string;
  delivery_status: string;
  delivered_at: Date | string | null;
  cancelled_at: Date | string | null;
  assigned_driver_user_id: string;
  payment_count: string;
  payment_phase: string | null;
  payment_method: string | null;
  handoff_count: string;
  handoff_state: string | null;
  settlement_state: string | null;
  finance_event_count: string;
  invalid_finance_event_count: string;
  reconciliation_count: string;
};

export type ReadOnlyQueryV1678 = (
  sql: string,
  params: unknown[]
) => Promise<{rows: Row[]}>;

const queryText = `
SELECT
  d.shopify_order_id AS order_id,
  d.delivery_status,
  d.delivered_at,
  d.cancelled_at,
  d.assigned_driver_user_id::text
    AS assigned_driver_user_id,

  (
    SELECT count(*)::text
    FROM alo_now_payment_states p
    WHERE p.shopify_order_id=d.shopify_order_id
  ) AS payment_count,

  (
    SELECT p.phase
    FROM alo_now_payment_states p
    WHERE p.shopify_order_id=d.shopify_order_id
    ORDER BY p.updated_at DESC,p.id DESC
    LIMIT 1
  ) AS payment_phase,

  (
    SELECT p.payment_method
    FROM alo_now_payment_states p
    WHERE p.shopify_order_id=d.shopify_order_id
    ORDER BY p.updated_at DESC,p.id DESC
    LIMIT 1
  ) AS payment_method,

  (
    SELECT count(*)::text
    FROM alo_now_handoff_ledger h
    WHERE h.shopify_order_id=d.shopify_order_id
  ) AS handoff_count,

  (
    SELECT h.handoff_state
    FROM alo_now_handoff_ledger h
    WHERE h.shopify_order_id=d.shopify_order_id
    LIMIT 1
  ) AS handoff_state,

  (
    SELECT h.settlement_state
    FROM alo_now_handoff_ledger h
    WHERE h.shopify_order_id=d.shopify_order_id
    LIMIT 1
  ) AS settlement_state,

  (
    SELECT count(*)::text
    FROM alo_now_driver_finance_events f
    WHERE f.order_id=d.shopify_order_id
      AND f.driver_user_id=d.assigned_driver_user_id::text
      AND f.workspace=d.fulfillment_workspace
      AND f.event_type IN (
        'COMMISSION_EARNED','ONLINE_TIP_EARNED'
      )
  ) AS finance_event_count,

  (
    SELECT count(*)::text
    FROM alo_now_driver_finance_events f
    WHERE f.order_id=d.shopify_order_id
      AND (
        f.driver_user_id<>d.assigned_driver_user_id::text
        OR f.workspace<>d.fulfillment_workspace
      )
  ) AS invalid_finance_event_count,

  (
    SELECT count(*)::text
    FROM alo_now_payment_reconciliations r
    WHERE r.shopify_order_id=d.shopify_order_id
      AND r.resolved_at IS NULL
  ) AS reconciliation_count

FROM alo_now_deliveries d
WHERE d.assigned_driver_user_id::text=$1
  AND d.fulfillment_workspace=$2
ORDER BY d.created_at DESC,d.id DESC
LIMIT 100
`;

function count(value: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error("INVALID_DB_COUNT");
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new Error("INVALID_DB_COUNT");
  }
  return n;
}

export async function readDriverWalletCandidatesV1678(
  query: ReadOnlyQueryV1678,
  driverUserId: string,
  workspace: WorkspaceV1678
): Promise<WalletCandidateV1678[]> {
  if (
    !/^[1-9][0-9]{0,18}$/.test(driverUserId) ||
    !["AARAU", "OLTEN"].includes(workspace)
  ) {
    throw new Error("INVALID_WALLET_SCOPE");
  }

  const result = await query(queryText, [
    driverUserId, workspace
  ]);

  if (!result || !Array.isArray(result.rows)) {
    throw new Error("INVALID_WALLET_DB_RESULT");
  }

  return result.rows.map(row => {
    if (
      !row.order_id ||
      row.assigned_driver_user_id !== driverUserId
    ) {
      throw new Error("WALLET_DB_IDENTITY_MISMATCH");
    }

    const blockers: string[] = [];

    if (
      row.delivery_status !== "DELIVERED" ||
      !row.delivered_at ||
      row.cancelled_at
    ) {
      blockers.push("DELIVERY_NOT_FINAL");
    }

    if (count(row.payment_count) !== 1) {
      blockers.push("PAYMENT_BINDING_NOT_UNIQUE");
    }

    if (!row.payment_phase || !row.payment_method) {
      blockers.push("PAYMENT_EVIDENCE_INCOMPLETE");
    }

    if (count(row.handoff_count) !== 1) {
      blockers.push("HANDOFF_EVIDENCE_INCOMPLETE");
    }

    if (!row.handoff_state || !row.settlement_state) {
      blockers.push("HANDOFF_SETTLEMENT_NOT_FINAL");
    }

    if (count(row.finance_event_count) === 0) {
      blockers.push("FINANCE_ENTITLEMENT_NOT_BOOKED");
    }

    if (count(row.invalid_finance_event_count) > 0) {
      blockers.push("FINANCE_DRIVER_OR_WORKSPACE_MISMATCH");
    }

    if (count(row.reconciliation_count) > 0) {
      blockers.push("PAYMENT_RECONCILIATION_OPEN");
    }

    // Critical: discovery is NOT authoritative verification.
    // Even a row without structural blockers cannot pay out.
    blockers.push("TRUSTED_PROVIDER_AND_AMOUNT_CHECK_PENDING");

    return {
      orderId: row.order_id,
      deliveryStatus: row.delivery_status,
      paymentPhase: row.payment_phase,
      paymentMethod: row.payment_method,
      handoffState: row.handoff_state,
      settlementState: row.settlement_state,
      financeEventCount: count(row.finance_event_count),
      blockers,
      payableOutstandingRappen: null,
      payoutEnabled: false
    };
  });
}

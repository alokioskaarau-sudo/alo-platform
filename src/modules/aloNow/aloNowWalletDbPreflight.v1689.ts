
/**
 * ALO NOW V1689 - read-only wallet database preflight.
 *
 * This module checks database evidence consistency.
 * PostgreSQL is NOT an independent Shopify payment provider.
 * No amounts or payout entitlement are exposed.
 */

export type WalletScopeV1689 = {
  driverUserId: string;
  workspace: "AARAU" | "OLTEN";
  orderId: string;
};

type QueryResult = {
  rows: Record<string, unknown>[];
};

export type ReadOnlyDbV1689 = (
  sql: string,
  params: readonly string[]
) => Promise<QueryResult>;

export type WalletDbPreflightV1689 = {
  status: "BLOCKED" | "AWAITING_PROVIDER_VERIFICATION";
  orderId: string;
  blockers: string[];
  dbEvidenceChecked: boolean;
  providerConfirmed: false;
  sourceVerified: false;
  payableOutstandingRappen: null;
  payoutEnabled: false;
};

const ORDER = /^gid:\/\/shopify\/Order\/[1-9][0-9]*$/;
const DRIVER = /^[1-9][0-9]{0,18}$/;

const SQL = `
SELECT
  d.shopify_order_id,
  d.fulfillment_workspace,
  d.assigned_driver_user_id::text AS driver_user_id,
  d.delivery_status,
  d.delivered_at,
  d.cancelled_at,

  (SELECT COUNT(*)::text
   FROM alo_now_handoff_ledger h
   WHERE h.shopify_order_id=d.shopify_order_id
  ) AS handoff_count,

  (SELECT h.handoff_state
   FROM alo_now_handoff_ledger h
   WHERE h.shopify_order_id=d.shopify_order_id
  ) AS handoff_state,

  (SELECT h.settlement_state
   FROM alo_now_handoff_ledger h
   WHERE h.shopify_order_id=d.shopify_order_id
  ) AS settlement_state,

  (SELECT h.assigned_driver_user_id::text
   FROM alo_now_handoff_ledger h
   WHERE h.shopify_order_id=d.shopify_order_id
  ) AS handoff_driver_id,

  (SELECT COUNT(*)::text
   FROM alo_now_payment_states p
   WHERE p.shopify_order_id=d.shopify_order_id
  ) AS payment_count,

  (SELECT p.payment_method
   FROM alo_now_payment_states p
   WHERE p.shopify_order_id=d.shopify_order_id
   ORDER BY p.updated_at DESC,p.id DESC
   LIMIT 1
  ) AS payment_method,

  (SELECT COUNT(*)::text
   FROM alo_now_payment_reconciliations r
   WHERE r.shopify_order_id=d.shopify_order_id
     AND r.resolved_at IS NULL
  ) AS open_reconciliations,

  (SELECT COUNT(*)::text
   FROM alo_now_driver_finance_events f
   WHERE f.order_id=d.shopify_order_id
     AND f.event_type='COMMISSION_EARNED'
  ) AS commission_count,

  (SELECT COUNT(*)::text
   FROM alo_now_driver_finance_events f
   WHERE f.order_id=d.shopify_order_id
     AND f.event_type='ONLINE_TIP_EARNED'
  ) AS online_tip_count,

  (SELECT COUNT(*)::text
   FROM alo_now_driver_finance_events f
   WHERE f.order_id=d.shopify_order_id
     AND f.event_type IN (
       'COMMISSION_EARNED','ONLINE_TIP_EARNED'
     )
     AND (
       f.driver_user_id<>d.assigned_driver_user_id::text
       OR f.workspace<>d.fulfillment_workspace
     )
  ) AS wrong_finance_count

FROM alo_now_deliveries d
WHERE d.shopify_order_id=$1
  AND d.assigned_driver_user_id::text=$2
  AND d.fulfillment_workspace=$3
LIMIT 2
`;

function count(value: unknown): number {
  const str = String(value);
  if (!/^(0|[1-9][0-9]*)$/.test(str)) {
    throw new Error("INVALID_DB_COUNT");
  }
  const n = Number(str);
  if (!Number.isSafeInteger(n)) {
    throw new Error("DB_COUNT_OVERFLOW");
  }
  return n;
}

export async function inspectWalletDbEvidenceV1689(
  query: ReadOnlyDbV1689,
  scope: WalletScopeV1689
): Promise<WalletDbPreflightV1689> {
  if (
    !DRIVER.test(scope.driverUserId) ||
    !ORDER.test(scope.orderId) ||
    !["AARAU", "OLTEN"].includes(scope.workspace)
  ) {
    throw new Error("INVALID_WALLET_SCOPE");
  }

  const blockers: string[] = [];

  const result = (
    dbEvidenceChecked: boolean
  ): WalletDbPreflightV1689 => ({
    status: blockers.length
      ? "BLOCKED"
      : "AWAITING_PROVIDER_VERIFICATION",
    orderId: scope.orderId,
    blockers,
    dbEvidenceChecked,
    providerConfirmed: false,
    sourceVerified: false,
    payableOutstandingRappen: null,
    payoutEnabled: false
  });

  let rows: Record<string, unknown>[];

  try {
    const response = await query(SQL, [
      scope.orderId,
      scope.driverUserId,
      scope.workspace
    ]);
    if (!response || !Array.isArray(response.rows)) {
      throw new Error("INVALID_QUERY_RESULT");
    }
    rows = response.rows;
  } catch {
    blockers.push("DATABASE_EVIDENCE_UNAVAILABLE");
    return result(false);
  }

  if (rows.length !== 1) {
    blockers.push("DELIVERY_NOT_UNIQUELY_BOUND");
    return result(true);
  }

  const row = rows[0];

  if (
    row.shopify_order_id !== scope.orderId ||
    String(row.driver_user_id) !== scope.driverUserId ||
    row.fulfillment_workspace !== scope.workspace
  ) {
    blockers.push("DELIVERY_IDENTITY_MISMATCH");
  }

  if (
    row.delivery_status !== "DELIVERED" ||
    !row.delivered_at ||
    row.cancelled_at !== null
  ) {
    blockers.push("DELIVERY_NOT_FINAL");
  }

  try {
    if (
      count(row.handoff_count) !== 1 ||
      row.handoff_state !== "FULL_HANDOFF" ||
      row.settlement_state !== "COMPLETED" ||
      String(row.handoff_driver_id) !== scope.driverUserId
    ) {
      blockers.push("HANDOFF_NOT_FINAL");
    }

    if (
      count(row.payment_count) !== 1 ||
      row.payment_method !== "CARD"
    ) {
      blockers.push("CARD_PAYMENT_BINDING_MISSING");
    }

    if (count(row.open_reconciliations) !== 0) {
      blockers.push("OPEN_PAYMENT_RECONCILIATION");
    }

    if (
      count(row.commission_count) !== 1 ||
      count(row.online_tip_count) > 1 ||
      count(row.wrong_finance_count) !== 0
    ) {
      blockers.push("FINANCE_EVENTS_NOT_UNIQUELY_BOUND");
    }
  } catch {
    blockers.push("INVALID_DATABASE_EVIDENCE");
  }

  return result(true);
}

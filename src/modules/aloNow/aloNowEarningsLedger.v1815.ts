/**
 * ALO NOW V1815
 * Read-only finance event structure check.
 * Does NOT independently verify event origins.
 * Does NOT authorize earnings or payouts.
 */

export type LedgerScopeV1815 = {
  orderId: string;
  driverUserId: string;
  workspace: "AARAU" | "OLTEN";
};

type LedgerRow = {
  event_key: string;
  event_type: string;
  driver_user_id: string;
  workspace: string;
  order_id: string;
  amount_rappen: string;
  source_reference: string | null;
};

export type LedgerQueryV1815 = (
  sql: string,
  params: readonly string[]
) => Promise<{ rows: LedgerRow[] }>;

export type LedgerResultV1815 = {
  status:
    | "BLOCKED"
    | "PENDING_BOOKING"
    | "BOOKINGS_PRESENT_UNVERIFIED";
  commissionCount: number;
  tipCount: number;
  sourceVerified: false;
  earningsAuthorized: false;
  payoutEnabled: false;
};

const ORDER = /^gid:\/\/shopify\/Order\/[1-9][0-9]*$/;
const DRIVER = /^[1-9][0-9]{0,18}$/;

const SQL = `
SELECT event_key, event_type,
       driver_user_id::text,
       workspace, order_id,
       amount_rappen::text,
       source_reference
FROM alo_now_driver_finance_events
WHERE order_id=$1
  AND event_type IN (
    'COMMISSION_EARNED',
    'ONLINE_TIP_EARNED'
  )
ORDER BY created_at, id
LIMIT 101
`;

function result(
  status: LedgerResultV1815["status"],
  commissionCount = 0,
  tipCount = 0
): LedgerResultV1815 {
  return {
    status,
    commissionCount,
    tipCount,
    sourceVerified: false,
    earningsAuthorized: false,
    payoutEnabled: false
  };
}

export async function readEarningsLedgerV1815(
  scope: LedgerScopeV1815,
  query: LedgerQueryV1815
): Promise<LedgerResultV1815> {
  if (
    !scope ||
    !ORDER.test(scope.orderId) ||
    !DRIVER.test(scope.driverUserId) ||
    !["AARAU", "OLTEN"].includes(scope.workspace)
  ) {
    return result("BLOCKED");
  }

  try {
    const response = await query(SQL, [scope.orderId]);

    if (!response || !Array.isArray(response.rows)) {
      return result("BLOCKED");
    }

    const rows = response.rows;

    // Bounded read: never silently ignore extra events.
    if (rows.length > 100) {
      return result("BLOCKED");
    }

    if (rows.length === 0) {
      return result("PENDING_BOOKING");
    }

    const keys = new Set<string>();
    const tipPaymentSources = new Set<string>();

    for (const row of rows) {
      const amount = Number(row.amount_rappen);

      if (
        row.order_id !== scope.orderId ||
        row.driver_user_id !== scope.driverUserId ||
        row.workspace !== scope.workspace ||
        !row.event_key?.trim() ||
        keys.has(row.event_key) ||
        !row.source_reference?.trim() ||
        !/^[1-9][0-9]*$/.test(row.amount_rappen) ||
        !Number.isSafeInteger(amount) ||
        amount <= 0 ||
        ![
          "COMMISSION_EARNED",
          "ONLINE_TIP_EARNED"
        ].includes(row.event_type)
      ) {
        return result("BLOCKED");
      }

      keys.add(row.event_key);
      if (row.event_type === "ONLINE_TIP_EARNED") {
        // A separate confirmed payment capture must back every tip.
        // Even read-only diagnostics reject repeated sources.
        if (tipPaymentSources.has(row.source_reference!)) {
          return result("BLOCKED");
        }
        tipPaymentSources.add(row.source_reference!);
      }
    }

    const commissionCount = rows.filter(
      row => row.event_type === "COMMISSION_EARNED"
    ).length;

    const tipCount = rows.filter(
      row => row.event_type === "ONLINE_TIP_EARNED"
    ).length;

    if (commissionCount !== 1) {
      return result("BLOCKED");
    }

    return result(
      "BOOKINGS_PRESENT_UNVERIFIED",
      commissionCount,
      tipCount
    );
  } catch {
    return result("BLOCKED");
  }
}

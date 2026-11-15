/**
 * ALO NOW V171
 *
 * Read-only internal delivery eligibility.
 *
 * This does not authenticate the customer.
 * A future customer endpoint must first validate
 * the existing customer-status token.
 *
 * No checkout, payment, wallet or database writes.
 */

export type TipEligibilityV171 =
  | {
      eligible: false;
      reason: string;
    }
  | {
      eligible: true;
      requestId: string;
      originalOrderId: string;
      driverUserId: string;
    };

export type TipDeliveryRowV171 = {
  request_id: string;
  shopify_order_id: string | null;
  payment_phase: string | null;
  delivery_status: string | null;
  driver_user_id: string | null;
};

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ORDER_PREFIX = "gid://shopify/Order/";

function validOrderId(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !value.startsWith(ORDER_PREFIX)
  ) return false;

  return /^[1-9][0-9]*$/.test(
    value.slice(ORDER_PREFIX.length)
  );
}

export function evaluateTipEligibilityV171(
  requestId: string,
  rows: TipDeliveryRowV171[]
): TipEligibilityV171 {
  if (!UUID.test(requestId)) {
    return {
      eligible: false,
      reason: "INVALID_REQUEST"
    };
  }

  if (rows.length !== 1) {
    return {
      eligible: false,
      reason: "ORDER_BINDING_AMBIGUOUS"
    };
  }

  const row = rows[0];

  if (
    row.request_id.toLowerCase() !==
    requestId.toLowerCase()
  ) {
    return {
      eligible: false,
      reason: "REQUEST_MISMATCH"
    };
  }

  if (
    !validOrderId(row.shopify_order_id) ||
    row.payment_phase !== "PAYMENT_CONFIRMED"
  ) {
    return {
      eligible: false,
      reason: "PAYMENT_NOT_CONFIRMED"
    };
  }

  if (row.delivery_status !== "DELIVERED") {
    return {
      eligible: false,
      reason: "NOT_DELIVERED"
    };
  }

  if (
    typeof row.driver_user_id !== "string" ||
    !/^[1-9][0-9]*$/.test(row.driver_user_id)
  ) {
    return {
      eligible: false,
      reason: "DRIVER_NOT_ASSIGNED"
    };
  }

  return {
    eligible: true,
    requestId,
    originalOrderId: row.shopify_order_id,
    driverUserId: row.driver_user_id
  };
}

export async function readTipEligibilityV171(
  requestId: string
): Promise<TipEligibilityV171> {
  if (!UUID.test(requestId)) {
    return {
      eligible: false,
      reason: "INVALID_REQUEST"
    };
  }

  // Lazy import: offline tests require no credentials.
  const { db } = await import("../../database/db.js");

  const result = await db.query<TipDeliveryRowV171>(
    `SELECT
       r.id::text AS request_id,
       p.shopify_order_id,
       p.phase AS payment_phase,
       d.delivery_status,
       d.assigned_driver_user_id::text
         AS driver_user_id
     FROM alo_now_order_requests r
     LEFT JOIN alo_now_payment_states p
       ON p.request_id=r.id
     LEFT JOIN alo_now_deliveries d
       ON d.shopify_order_id=p.shopify_order_id
     WHERE r.id=$1::uuid
     LIMIT 2`,
    [requestId]
  );

  return evaluateTipEligibilityV171(
    requestId,
    result.rows
  );
}

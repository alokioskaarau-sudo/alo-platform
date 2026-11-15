import { db } from "../../database/db.js";

/**
 * Customer GPS is read-only and order-scoped.
 * Authentication happens in the customer-status route.
 *
 * The DB query additionally verifies the request/order binding,
 * confirmed payment, assigned driver, active consent,
 * current delivery state and a recent GPS sample.
 */

export type CustomerGpsPosition = {
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  updatedAt: string;
};

export function customerGpsIsFresh(
  receivedAt: Date,
  now: Date = new Date()
): boolean {
  const age = now.getTime() - receivedAt.getTime();

  return Number.isFinite(age) &&
    age >= -5000 &&
    age <= 30000;
}

export async function readAloNowCustomerGps(
  requestId: string,
  shopifyOrderId: string
): Promise<CustomerGpsPosition | null> {
  const result = await db.query<{
    latitude: number;
    longitude: number;
    accuracy_meters: number;
    received_at: Date;
  }>(
    `SELECT
       l.latitude,
       l.longitude,
       l.accuracy_meters,
       l.received_at
     FROM alo_now_payment_states payment
     JOIN alo_now_deliveries d
       ON d.shopify_order_id = payment.shopify_order_id
     JOIN alo_now_gps_consents c
       ON c.delivery_id = d.id
     JOIN alo_now_driver_locations l
       ON l.delivery_id = d.id
     WHERE payment.request_id = $1::uuid
       AND payment.shopify_order_id = $2
       AND payment.phase IN (
         'PAYMENT_CONFIRMED',
         'CASH_CONFIRMED'
       )
       AND d.delivery_status = 'ON_THE_WAY'
       AND d.assigned_driver_user_id IS NOT NULL
       AND c.driver_user_id = d.assigned_driver_user_id
       AND l.driver_user_id = d.assigned_driver_user_id
       AND c.enabled IS TRUE
       AND c.updated_at > NOW() - INTERVAL '2 minutes'
       AND l.received_at > NOW() - INTERVAL '30 seconds'
       AND l.received_at <= NOW() + INTERVAL '5 seconds'
     ORDER BY l.received_at DESC
     LIMIT 1`,
    [requestId, shopifyOrderId]
  );

  const row = result.rows[0];

  if (!row) return null;

  const receivedAt = new Date(row.received_at);
  const latitude = Number(row.latitude);
  const longitude = Number(row.longitude);
  const accuracyMeters = Number(row.accuracy_meters);

  if (
    !customerGpsIsFresh(receivedAt) ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    !Number.isFinite(accuracyMeters) ||
    latitude < 45 ||
    latitude > 48.5 ||
    longitude < 5 ||
    longitude > 11 ||
    accuracyMeters < 0 ||
    accuracyMeters > 150
  ) {
    return null;
  }

  return {
    latitude,
    longitude,
    accuracyMeters,
    updatedAt: receivedAt.toISOString()
  };
}

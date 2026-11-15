import type { PoolClient } from "pg";

export type DeliveryAuthorization =
  | { ok:true; method:"INTERNAL_DELIVERY"|"ASSIGNED_DRIVER" }
  | { ok:false; reason:string };

export type LockedAloNowRequest = {
  status:string;
  driver_user_id:string|null;
  reservation_valid:boolean;
};

/**
 * Caller must FIRST lock alo_now_order_requests FOR UPDATE.
 * Afterwards call this function within the SAME transaction.
 *
 * No payment permission, no Shopify writes, no dispatch.
 */
export async function authorizeAloNowDeliveryV332(
  client:PoolClient,
  requestId:string,
  request:LockedAloNowRequest
):Promise<DeliveryAuthorization> {
  if (request.status === "REJECTED") {
    return {ok:false,reason:"REQUEST_REJECTED"};
  }

  const merchant = await client.query<{
    fulfillment_method:string;
    assigned_driver_id:string|null;
    accepted_by:string;
    valid:boolean;
  }>(`
    SELECT fulfillment_method,
           assigned_driver_id,
           accepted_by,
           (
             capacity_confirmed_at <= clock_timestamp()
             AND capacity_confirmed_until > clock_timestamp()
           ) AS valid
    FROM alo_now_merchant_acceptances
    WHERE request_id=$1
    FOR UPDATE
  `,[requestId]);

  const m = merchant.rows[0];

  // A merchant acceptance is an explicit alternative to
  // a driver's temporary reservation.
  if (m) {
    if (!m.valid)
      return {ok:false,reason:"MERCHANT_CAPACITY_EXPIRED"};

    if (!m.accepted_by?.trim())
      return {ok:false,reason:"MERCHANT_ACTOR_MISSING"};

    if (m.fulfillment_method === "INTERNAL_DELIVERY") {
      if (
        !["PENDING_REVIEW","CONTACTED"].includes(request.status) ||
        m.assigned_driver_id !== null
      ) return {ok:false,reason:"INTERNAL_DELIVERY_STATE_INVALID"};

      return {ok:true,method:"INTERNAL_DELIVERY"};
    }

    if (m.fulfillment_method === "ASSIGNED_DRIVER") {
      if (
        request.status !== "DRIVER_ACCEPTED" ||
        !request.driver_user_id ||
        !request.reservation_valid ||
        m.assigned_driver_id !== request.driver_user_id
      ) return {ok:false,reason:"ASSIGNED_DRIVER_INVALID"};

      return {ok:true,method:"ASSIGNED_DRIVER"};
    }

    return {ok:false,reason:"FULFILLMENT_METHOD_INVALID"};
  }

  // Preserve existing driver-reservation behavior.
  if (
    request.status === "DRIVER_ACCEPTED" &&
    !!request.driver_user_id &&
    request.reservation_valid
  ) return {ok:true,method:"ASSIGNED_DRIVER"};

  return {ok:false,reason:"DELIVERY_CONFIRMATION_REQUIRED"};
}

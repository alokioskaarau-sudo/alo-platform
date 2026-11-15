import { db } from "../../database/db.js";

type Method = "INTERNAL_DELIVERY" | "ASSIGNED_DRIVER";

type Input = {
  requestId: string;
  method: Method;
  // Trusted server-side actor only; authenticate in the caller.
  acceptedBy: string;
  assignedDriverId?: string | null;
  capacityMinutes: number;
};

type Result =
  | {ok:true; action:"CREATED"|"ALREADY_ACCEPTED";
     method:Method; validUntil:Date}
  | {ok:false; reason:string};

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Internal service only.
 * Caller MUST authenticate and authorize ADMIN/MANAGER.
 * Do not expose this function directly to a public route.
 *
 * No customer payment, Shopify mutation, or driver dispatch.
 */
export async function acceptAloNowDeliveryV330(
  input:Input
):Promise<Result> {
  if (!UUID.test(input.requestId))
    return {ok:false,reason:"INVALID_REQUEST_ID"};

  if (!["INTERNAL_DELIVERY","ASSIGNED_DRIVER"].includes(input.method))
    return {ok:false,reason:"INVALID_FULFILLMENT_METHOD"};

  if (!Number.isInteger(input.capacityMinutes) ||
      input.capacityMinutes < 5 ||
      input.capacityMinutes > 30)
    return {ok:false,reason:"INVALID_CAPACITY_WINDOW"};

  const actor = input.acceptedBy?.trim();
  if (!actor || actor.length > 150)
    return {ok:false,reason:"INVALID_ACCEPTANCE_ACTOR"};

  const driver = input.assignedDriverId?.trim() || null;

  if (
    (input.method === "INTERNAL_DELIVERY" && driver !== null) ||
    (input.method === "ASSIGNED_DRIVER" &&
      (!driver || driver.length > 150))
  ) return {ok:false,reason:"INVALID_DRIVER_ASSIGNMENT"};

  const client = await db.connect();
  let active = false;
  let destroy = false;

  try {
    await client.query("BEGIN");
    active = true;

    await client.query("SET LOCAL lock_timeout='3s'");
    await client.query("SET LOCAL statement_timeout='12s'");

    // Parent-first locking protects concurrent request changes.
    const request = await client.query<{
      status:string;
      quote_status:string;
      verified_at:Date|null;
      verified_subtotal_chf:string|null;
      quoted_delivery_fee_chf:string|null;
    }>(`
      SELECT status,quote_status,verified_at,
             verified_subtotal_chf::text,
             quoted_delivery_fee_chf::text
      FROM alo_now_order_requests
      WHERE id=$1
      FOR UPDATE
    `,[input.requestId]);

    const row = request.rows[0];

    if (!row)
      return {ok:false,reason:"REQUEST_NOT_FOUND"};

    if (!["PENDING_REVIEW","CONTACTED"].includes(row.status))
      return {ok:false,reason:"REQUEST_NOT_ACCEPTABLE"};

    if (
      row.quote_status !== "STANDARD" ||
      !row.verified_at ||
      row.verified_subtotal_chf === null ||
      row.quoted_delivery_fee_chf === null
    ) return {ok:false,reason:"VERIFIED_QUOTE_REQUIRED"};

    // Payment state is checked under the same transaction.
    const payment = await client.query<{
      phase:string;
      payment_method:string|null;
      shopify_order_id:string|null;
    }>(`
      SELECT phase,payment_method,shopify_order_id
      FROM alo_now_payment_states
      WHERE request_id=$1 FOR UPDATE
    `,[input.requestId]);

    const p = payment.rows[0];

    if (
      p && (
        p.phase !== "AWAITING_DRIVER" ||
        p.payment_method !== null ||
        p.shopify_order_id !== null
      )
    ) return {ok:false,reason:"PAYMENT_ALREADY_STARTED"};

    const existing = await client.query<{
      fulfillment_method:Method;
      accepted_by:string;
      assigned_driver_id:string|null;
      capacity_confirmed_until:Date;
      valid:boolean;
    }>(`
      SELECT fulfillment_method,accepted_by,
             assigned_driver_id,capacity_confirmed_until,
             capacity_confirmed_until > clock_timestamp()
               AS valid
      FROM alo_now_merchant_acceptances
      WHERE request_id=$1 FOR UPDATE
    `,[input.requestId]);

    const previous = existing.rows[0];

    if (previous) {
      if (
        previous.valid &&
        previous.fulfillment_method === input.method &&
        previous.accepted_by === actor &&
        previous.assigned_driver_id === driver
      ) {
        await client.query("COMMIT");
        active = false;
        return {
          ok:true,
          action:"ALREADY_ACCEPTED",
          method:previous.fulfillment_method,
          validUntil:previous.capacity_confirmed_until
        };
      }

      return {
        ok:false,
        reason:previous.valid
          ? "DELIVERY_ALREADY_ACCEPTED"
          : "CAPACITY_CONFIRMATION_EXPIRED"
      };
    }

    const inserted = await client.query<{
      fulfillment_method:Method;
      capacity_confirmed_until:Date;
    }>(`
      INSERT INTO alo_now_merchant_acceptances (
        request_id,fulfillment_method,accepted_by,
        assigned_driver_id,capacity_confirmed_at,
        capacity_confirmed_until
      )
      VALUES (
        $1,$2,$3,$4,clock_timestamp(),
        clock_timestamp()+($5::int * INTERVAL '1 minute')
      )
      RETURNING fulfillment_method,capacity_confirmed_until
    `,[
      input.requestId,input.method,actor,driver,
      input.capacityMinutes
    ]);

    await client.query("COMMIT");
    active = false;

    return {
      ok:true,
      action:"CREATED",
      method:inserted.rows[0].fulfillment_method,
      validUntil:inserted.rows[0].capacity_confirmed_until
    };
  } catch {
    destroy = true;
    return {ok:false,reason:"ACCEPTANCE_UNAVAILABLE"};
  } finally {
    if (active) {
      try { await client.query("ROLLBACK"); }
      catch { destroy = true; }
    }
    client.release(destroy);
  }
}

import { randomUUID } from "node:crypto";
import { db } from "../../database/db.js";
import {
  transitionAloNowPayment
} from "./aloNowPaymentLifecycle.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Result =
  | {ok:true; action:"AUTHORIZED"|"ALREADY_AUTHORIZED";
     version:number}
  | {ok:false; reason:string};

/**
 * Internal only. The caller must authenticate and authorize
 * the actor as ADMIN/MANAGER. Never expose directly to users.
 *
 * This prepares an internal payment state; it does NOT collect
 * a payment, issue a checkout URL, or contact Shopify.
 */
export async function authorizeAloNowMerchantPaymentV336(
  requestId:string,
  actorId:string
):Promise<Result> {
  if (!UUID.test(requestId))
    return {ok:false,reason:"INVALID_REQUEST_ID"};

  if (
    typeof actorId !== "string" ||
    actorId.trim().length < 1 ||
    actorId.trim().length > 150
  ) return {ok:false,reason:"INVALID_ACTOR"};

  const client = await db.connect();
  let active = false;
  let destroy = false;

  try {
    await client.query("BEGIN");
    active = true;
    await client.query("SET LOCAL lock_timeout='3s'");
    await client.query("SET LOCAL statement_timeout='12s'");

    // Always lock the parent first, consistent with other services.
    const request = await client.query<{
      status:string;
      delivery_address:string;
      quote_status:string;
      verified_at:Date|null;
      verified_subtotal_chf:string|null;
      quoted_delivery_fee_chf:string|null;
    }>(`
      SELECT status,delivery_address,quote_status,verified_at,
             verified_subtotal_chf::text,
             quoted_delivery_fee_chf::text
      FROM alo_now_order_requests
      WHERE id=$1 FOR UPDATE
    `,[requestId]);

    const r = request.rows[0];
    if (!r)
      return {ok:false,reason:"REQUEST_NOT_FOUND"};

    if (!["PENDING_REVIEW","CONTACTED"].includes(r.status))
      return {ok:false,reason:"REQUEST_NOT_ACCEPTABLE"};

    if (
      r.quote_status !== "STANDARD" ||
      !r.verified_at ||
      r.verified_subtotal_chf === null ||
      r.quoted_delivery_fee_chf === null ||
      !Number.isFinite(Number(r.verified_subtotal_chf)) ||
      Number(r.verified_subtotal_chf) <= 0 ||
      !Number.isFinite(Number(r.quoted_delivery_fee_chf)) ||
      Number(r.quoted_delivery_fee_chf) < 0
    ) return {ok:false,reason:"VERIFIED_QUOTE_REQUIRED"};

    const capacity = await client.query<{
      fulfillment_method:string;
      valid:boolean;
    }>(`
      SELECT fulfillment_method,
             (
               capacity_confirmed_at <= clock_timestamp()
               AND capacity_confirmed_until > clock_timestamp()
               AND btrim(accepted_by) <> ''
               AND assigned_driver_id IS NULL
             ) AS valid
      FROM alo_now_merchant_acceptances
      WHERE request_id=$1 FOR UPDATE
    `,[requestId]);

    const m = capacity.rows[0];
    if (!m || m.fulfillment_method !== "INTERNAL_DELIVERY" ||
        !m.valid)
      return {ok:false,reason:"MERCHANT_CAPACITY_REQUIRED"};

    const address = await client.query<{verified:boolean}>(`
      SELECT (
        btrim(verified_address) = btrim($2::text)
        AND verified_at IS NOT NULL
        AND btrim(verified_by) <> ''
      ) AS verified
      FROM alo_now_address_verifications_v336
      WHERE request_id=$1 FOR UPDATE
    `,[requestId,r.delivery_address]);

    if (!address.rows[0]?.verified)
      return {ok:false,reason:"VERIFIED_ADDRESS_REQUIRED"};

    // No payment-state insert until all other gates pass.
    await client.query(`
      INSERT INTO alo_now_payment_states
        (id,request_id,phase,version)
      VALUES ($1,$2,'AWAITING_DRIVER',1)
      ON CONFLICT (request_id) DO NOTHING
    `,[randomUUID(),requestId]);

    const payment = await client.query<{
      id:string;
      phase:string;
      payment_method:string|null;
      shopify_order_id:string|null;
      version:number;
    }>(`
      SELECT id,phase,payment_method,
             shopify_order_id,version
      FROM alo_now_payment_states
      WHERE request_id=$1 FOR UPDATE
    `,[requestId]);

    const p = payment.rows[0];
    if (!p)
      return {ok:false,reason:"PAYMENT_STATE_MISSING"};

    if (p.phase === "AWAITING_PAYMENT" &&
        p.payment_method === "ONLINE" &&
        p.shopify_order_id === null) {
      await client.query("COMMIT");
      active = false;
      return {
        ok:true,action:"ALREADY_AUTHORIZED",version:p.version
      };
    }

    if (
      p.phase !== "AWAITING_DRIVER" ||
      p.payment_method !== null ||
      p.shopify_order_id !== null
    ) return {ok:false,reason:"PAYMENT_STATE_CONFLICT"};

    const next = transitionAloNowPayment(
      {phase:"AWAITING_DRIVER",method:null},
      {type:"MERCHANT_PAYMENT_AUTHORIZED"}
    );

    if (!next.ok)
      return {ok:false,reason:next.reason};

    const version = p.version + 1;

    const updated = await client.query(`
      UPDATE alo_now_payment_states
      SET phase=$2,payment_method=$3,
          version=$4,updated_at=NOW()
      WHERE id=$1 AND version=$5
        AND phase='AWAITING_DRIVER'
        AND payment_method IS NULL
        AND shopify_order_id IS NULL
    `,[
      p.id,next.state.phase,next.state.method,
      version,p.version
    ]);

    if (updated.rowCount !== 1)
      throw Error("PAYMENT_VERSION_CONFLICT");

    await client.query(`
      INSERT INTO alo_now_payment_events
        (id,payment_state_id,event_type,
         previous_phase,next_phase,
         actor_type,actor_id,resulting_version)
      VALUES (
        $1,$2,'MERCHANT_PAYMENT_AUTHORIZED',
        'AWAITING_DRIVER','AWAITING_PAYMENT',
        'ADMIN',$3,$4
      )
    `,[randomUUID(),p.id,actorId.trim(),version]);

    await client.query("COMMIT");
    active = false;

    return {ok:true,action:"AUTHORIZED",version};
  } catch {
    destroy = true;
    return {ok:false,reason:"MERCHANT_PAYMENT_UNAVAILABLE"};
  } finally {
    if (active) {
      try { await client.query("ROLLBACK"); }
      catch { destroy = true; }
    }
    client.release(destroy);
  }
}

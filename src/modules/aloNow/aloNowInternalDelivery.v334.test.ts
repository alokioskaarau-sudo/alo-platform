import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {db} from "../../database/db.js";
import {
  acceptAloNowDeliveryV330
} from "./aloNowMerchantAcceptanceService.v330.js";
import {
  ensureAloNowCheckoutIntent
} from "./aloNowCheckoutIntentStore.js";
import {
  createAloNowDraftClaimService
} from "./aloNowDraftClaimService.js";

const URL =
  "postgresql://maxim@127.0.0.1:55433/alo_staff_test";

if (
  process.env.NODE_ENV !== "test" ||
  process.env.ALO_RUNTIME_MODE !== "local_test" ||
  process.env.DATABASE_URL !== URL
) throw Error("V334_LOCAL_TEST_GUARD");

const ids:string[] = [];

const item = {
  variantId:"gid://shopify/ProductVariant/123",
  quantity:2,
  unitPriceCHF:4.95,
  title:"ALO V334 Local Test"
};

const claim = createAloNowDraftClaimService(
  async () => ({
    items:[item],
    subtotalCHF:9.90,
    currency:"CHF" as const
  })
);

async function fixture() {
  const id=randomUUID();

  await db.query(`
    INSERT INTO alo_now_order_requests (
      id,client_request_id,workspace,
      delivery_address,items,quote_status,
      road_distance_km,status,
      verified_subtotal_chf,verified_at,
      quoted_delivery_fee_chf
    ) VALUES (
      $1,$2,'AARAU','V334 LOCAL TEST',
      $3::jsonb,'STANDARD',1,'PENDING_REVIEW',
      9.90,NOW(),4.50
    )
  `,[id,"V334-"+id,JSON.stringify([item])]);

  ids.push(id);
  return id;
}

async function fixturePaymentReady(id:string) {
  // TEST ONLY. Production must reach this state through
  // an authenticated, validated lifecycle transition.
  await db.query(`
    INSERT INTO alo_now_payment_states (
      id,request_id,phase,payment_method,version
    ) VALUES (
      $1,$2,'AWAITING_PAYMENT','ONLINE',1
    )
  `,[randomUUID(),id]);
}

async function cleanup() {
  if (!ids.length) return;

  const c=await db.connect();
  let active=false;

  try {
    await c.query("BEGIN");
    active=true;

    for (const id of ids) {
      await c.query(
        "DELETE FROM alo_now_draft_operations WHERE request_id=$1",
        [id]
      );
      await c.query(
        "DELETE FROM alo_now_checkout_intents WHERE request_id=$1",
        [id]
      );
      await c.query(
        "DELETE FROM alo_now_merchant_acceptances WHERE request_id=$1",
        [id]
      );
      await c.query(
        "DELETE FROM alo_now_payment_states WHERE request_id=$1",
        [id]
      );
      await c.query(
        "DELETE FROM alo_now_order_requests WHERE id=$1",
        [id]
      );
    }

    await c.query("COMMIT");
    active=false;

    const check=await db.query<{n:number}>(`
      SELECT COUNT(*)::int AS n FROM alo_now_order_requests
      WHERE id=ANY($1::uuid[])
    `,[ids]);

    assert.equal(check.rows[0].n,0);
    console.log("OK: Sämtliche V334-Testdaten entfernt.");
  } catch(e) {
    if(active) await c.query("ROLLBACK").catch(()=>{});
    console.error("CLEANUP FEHLER – Request IDs:",ids);
    throw e;
  } finally {
    c.release();
  }
}

async function main() {
  const identity=(await db.query<{
    name:string;host:string;port:number;
  }>(`
    SELECT current_database() name,
           host(inet_server_addr()) host,
           inet_server_port() port
  `)).rows[0];

  assert.equal(identity.name,"alo_staff_test");
  assert.equal(identity.host,"127.0.0.1");
  assert.equal(Number(identity.port),55433);
  console.log("OK: Lokale Testdatenbank bestätigt.");

  const id=await fixture();

  const before=await ensureAloNowCheckoutIntent(id);
  assert.equal(before.ok,false);
  console.log("OK: Ohne Lieferzusage kein Checkout-Intent.");

  const acceptance=await acceptAloNowDeliveryV330({
    requestId:id,
    method:"INTERNAL_DELIVERY",
    acceptedBy:"v334-local-manager",
    capacityMinutes:15
  });

  assert.equal(acceptance.ok,true);
  console.log("OK: ALO übernimmt Lieferung ohne Fahrer.");

  const premature=await ensureAloNowCheckoutIntent(id);
  assert.deepEqual(premature,{
    ok:false,
    reason:"ONLINE_PAYMENT_REQUIRED"
  });
  console.log("OK: Lieferzusage allein startet keinen Checkout.");

  await fixturePaymentReady(id);

  const intent=await ensureAloNowCheckoutIntent(id);
  assert.equal(intent.ok,true);
  if (!intent.ok) throw Error("INTENT_FAILED");

  assert.equal(intent.reused,false);
  console.log("OK: Eigenlieferung erreicht Checkout-Intent.");

  const again=await ensureAloNowCheckoutIntent(id);
  assert.equal(again.ok,true);
  if (!again.ok) throw Error("REUSE_FAILED");

  assert.equal(again.reused,true);
  assert.equal(
    again.intent.checkoutReference,
    intent.intent.checkoutReference
  );
  console.log("OK: Checkout-Referenz wird idempotent verwendet.");

  const attempts=await Promise.all([claim(id),claim(id)]);
  const successes=attempts.filter(r=>r.ok);
  assert.equal(successes.length,1);

  const success=successes[0];
  if (!success.ok) throw Error("CLAIM_FAILED");

  assert.equal(success.expectedTotalCHF,"14.40");

  const state=(await db.query<{
    status:string;
    total:string;
  }>(`
    SELECT status,expected_total_chf::text AS total
    FROM alo_now_draft_operations
    WHERE request_id=$1
  `,[id])).rows[0];

  assert.equal(state.status,"CREATING");
  assert.equal(Number(state.total),14.40);

  console.log("OK: Genau ein Draft-Claim für Eigenlieferung.");
  console.log("OK: Endbetrag CHF 14.40 verifiziert.");

  const expiredId=await fixture();

  const expiredAcceptance=await acceptAloNowDeliveryV330({
    requestId:expiredId,
    method:"INTERNAL_DELIVERY",
    acceptedBy:"v334-local-manager",
    capacityMinutes:15
  });

  assert.equal(expiredAcceptance.ok,true);

  await db.query(`
    UPDATE alo_now_merchant_acceptances
    SET capacity_confirmed_at=NOW()-INTERVAL '30 minutes',
        capacity_confirmed_until=NOW()-INTERVAL '20 minutes'
    WHERE request_id=$1
  `,[expiredId]);

  await fixturePaymentReady(expiredId);

  const expiredIntent=await ensureAloNowCheckoutIntent(expiredId);
  assert.equal(expiredIntent.ok,false);

  const expiredClaim=await claim(expiredId);
  assert.equal(expiredClaim.ok,false);

  console.log("OK: Abgelaufene Eigenlieferung bleibt gesperrt.");
  console.log("===== V334B – INTEGRATIONSTEST BESTANDEN =====");
}

try {
  await main();
} finally {
  try { await cleanup(); }
  finally { await db.end(); }
}

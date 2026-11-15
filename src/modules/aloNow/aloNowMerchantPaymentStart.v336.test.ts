import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {db} from "../../database/db.js";
import {
  transitionAloNowPayment
} from "./aloNowPaymentLifecycle.js";
import {
  authorizeAloNowMerchantPaymentV336
} from "./aloNowMerchantPaymentStart.v336.js";

const URL =
  "postgresql://maxim@127.0.0.1:55433/alo_staff_test";

if (process.env.NODE_ENV !== "test" ||
    process.env.ALO_RUNTIME_MODE !== "local_test" ||
    process.env.DATABASE_URL !== URL)
  throw Error("V336_LOCAL_TEST_GUARD");

const ids:string[] = [];

async function fixture() {
  const id = randomUUID();

  await db.query(`
    INSERT INTO alo_now_order_requests (
      id,client_request_id,workspace,delivery_address,
      items,quote_status,road_distance_km,status,
      verified_subtotal_chf,verified_at,
      quoted_delivery_fee_chf
    ) VALUES (
      $1,$2,'AARAU','V336 TESTADRESSE 1234 AARAU',
      '[]'::jsonb,'STANDARD',1,'PENDING_REVIEW',
      9.90,NOW(),4.50
    )
  `,[id,"V336-"+id]);

  ids.push(id);
  return id;
}

async function capacity(id:string) {
  await db.query(`
    INSERT INTO alo_now_merchant_acceptances
      (request_id,fulfillment_method,accepted_by,
       capacity_confirmed_until)
    VALUES (
      $1,'INTERNAL_DELIVERY','v336-manager',
      NOW()+INTERVAL '15 minutes'
    )
  `,[id]);
}

async function verifyAddress(id:string) {
  await db.query(`
    INSERT INTO alo_now_address_verifications_v336
      (request_id,verified_address,verified_by,
       verification_source)
    VALUES (
      $1,'V336 TESTADRESSE 1234 AARAU',
      'v336-manager','MANUAL_STAFF'
    )
  `,[id]);
}

async function cleanup() {
  if (!ids.length) return;
  const c=await db.connect();
  let active=false;
  try {
    await c.query("BEGIN");
    active=true;
    await c.query(`
      DELETE FROM alo_now_payment_events
      WHERE payment_state_id IN (
        SELECT id FROM alo_now_payment_states
        WHERE request_id=ANY($1::uuid[])
      )
    `,[ids]);
    for (const table of [
      "alo_now_payment_states",
      "alo_now_address_verifications_v336",
      "alo_now_merchant_acceptances",
      "alo_now_order_requests"
    ]) {
      const column=table==="alo_now_order_requests"
        ?"id":"request_id";
      await c.query(
        `DELETE FROM ${table} WHERE ${column}=ANY($1::uuid[])`,
        [ids]
      );
    }
    await c.query("COMMIT");
    active=false;
    console.log("OK: Alle V336-Testdaten entfernt.");
  } finally {
    if(active) await c.query("ROLLBACK").catch(()=>{});
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
  console.log("OK: Lokale Testdatenbank.");

  assert.deepEqual(
    transitionAloNowPayment(
      {phase:"AWAITING_DRIVER",method:null},
      {type:"MERCHANT_PAYMENT_AUTHORIZED"}
    ),
    {ok:true,state:{phase:"AWAITING_PAYMENT",method:"ONLINE"}}
  );

  assert.equal(
    transitionAloNowPayment(
      {phase:"DRIVER_ACCEPTED",method:null},
      {type:"MERCHANT_PAYMENT_AUTHORIZED"}
    ).ok,false
  );
  console.log("OK: Neue Lifecycle-Regel und Konfliktsperre.");

  const id=await fixture();

  assert.deepEqual(
    await authorizeAloNowMerchantPaymentV336(id,"staff-test"),
    {ok:false,reason:"MERCHANT_CAPACITY_REQUIRED"}
  );

  await capacity(id);

  assert.deepEqual(
    await authorizeAloNowMerchantPaymentV336(id,"staff-test"),
    {ok:false,reason:"VERIFIED_ADDRESS_REQUIRED"}
  );
  console.log("OK: Ohne Adressprüfung keine Zahlungsfreigabe.");

  await verifyAddress(id);

  const results=await Promise.all([
    authorizeAloNowMerchantPaymentV336(id,"staff-test"),
    authorizeAloNowMerchantPaymentV336(id,"staff-test")
  ]);

  assert.equal(
    results.filter(r=>r.ok && r.action==="AUTHORIZED").length,
    1
  );
  assert.equal(
    results.filter(r=>r.ok && r.action==="ALREADY_AUTHORIZED").length,
    1
  );

  const state=(await db.query<{
    phase:string;payment_method:string;version:number;
  }>(`
    SELECT phase,payment_method,version
    FROM alo_now_payment_states
    WHERE request_id=$1
  `,[id])).rows[0];

  assert.equal(state.phase,"AWAITING_PAYMENT");
  assert.equal(state.payment_method,"ONLINE");
  assert.equal(state.version,2);

  const events=(await db.query<{n:number}>(`
    SELECT COUNT(*)::int n
    FROM alo_now_payment_events e
    JOIN alo_now_payment_states p
      ON p.id=e.payment_state_id
    WHERE p.request_id=$1
      AND e.event_type='MERCHANT_PAYMENT_AUTHORIZED'
      AND e.actor_type='ADMIN'
  `,[id])).rows[0].n;

  assert.equal(events,1);
  console.log("OK: Parallele Freigabe erzeugt genau ein Event.");
  console.log("OK: Zahlungsstatus und Version korrekt.");

  const expired=await fixture();
  await capacity(expired);
  await verifyAddress(expired);

  await db.query(`
    UPDATE alo_now_merchant_acceptances
    SET capacity_confirmed_at=NOW()-INTERVAL '30 minutes',
        capacity_confirmed_until=NOW()-INTERVAL '10 minutes'
    WHERE request_id=$1
  `,[expired]);

  assert.deepEqual(
    await authorizeAloNowMerchantPaymentV336(
      expired,"staff-test"
    ),
    {ok:false,reason:"MERCHANT_CAPACITY_REQUIRED"}
  );
  console.log("OK: Abgelaufene Lieferzusage blockiert.");

  console.log("===== V336 TESTS BESTANDEN =====");
}

try {
  await main();
} finally {
  try { await cleanup(); }
  finally { await db.end(); }
}

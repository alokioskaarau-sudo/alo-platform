import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {db} from "../../database/db.js";
import {
  acceptAloNowDeliveryV330
} from "./aloNowMerchantAcceptanceService.v330.js";

const ids:string[] = [];

async function fixture(options?:{
  quote?:string;
  status?:string;
  verified?:boolean;
  paymentPhase?:string;
}) {
  const id=randomUUID();
  const client=await db.connect();
  let active=false;

  try {
    await client.query("BEGIN");
    active=true;

    await client.query(`
      INSERT INTO alo_now_order_requests (
        id,client_request_id,workspace,
        delivery_address,items,quote_status,
        road_distance_km,status,
        verified_subtotal_chf,verified_at,
        quoted_delivery_fee_chf
      ) VALUES (
        $1,$2,'AARAU','V330 LOCAL TEST',
        '[]'::jsonb,$3,1,$4,
        9.90,$5,4.50
      )
    `,[
      id,"V330-"+id,
      options?.quote??"STANDARD",
      options?.status??"PENDING_REVIEW",
      options?.verified===false ? null : new Date()
    ]);

    if (options?.paymentPhase) {
      await client.query(`
        INSERT INTO alo_now_payment_states (
          id,request_id,phase,payment_method,version
        ) VALUES ($1,$2,$3,$4,1)
      `,[
        randomUUID(),id,options.paymentPhase,
        options.paymentPhase==="AWAITING_PAYMENT"
          ? "ONLINE" : null
      ]);
    }

    await client.query("COMMIT");
    active=false;
    ids.push(id);
    return id;
  } catch(e) {
    if(active)
      await client.query("ROLLBACK").catch(()=>{});
    throw e;
  } finally {
    client.release();
  }
}

async function cleanup() {
  if(!ids.length) return;

  const client=await db.connect();
  let active=false;

  try {
    await client.query("BEGIN");
    active=true;

    for (const id of ids) {
      await client.query(
        "DELETE FROM alo_now_merchant_acceptances WHERE request_id=$1",
        [id]
      );
      await client.query(
        "DELETE FROM alo_now_payment_states WHERE request_id=$1",
        [id]
      );
      await client.query(
        "DELETE FROM alo_now_order_requests WHERE id=$1",
        [id]
      );
    }

    await client.query("COMMIT");
    active=false;

    const count=await db.query<{total:number}>(`
      SELECT COUNT(*)::int AS total
      FROM alo_now_order_requests
      WHERE id=ANY($1::uuid[])
    `,[ids]);

    assert.equal(count.rows[0].total,0);
    console.log("OK: Alle V330-Testdaten entfernt.");
  } catch(e) {
    if(active)
      await client.query("ROLLBACK").catch(()=>{});
    console.error("CLEANUP FEHLER. Request-IDs:",ids.join(","));
    throw e;
  } finally {
    client.release();
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

  const id=await fixture();
  const base={
    requestId:id,
    method:"INTERNAL_DELIVERY" as const,
    acceptedBy:"v330-manager-test",
    capacityMinutes:15
  };

  const first=await acceptAloNowDeliveryV330(base);
  assert.equal(first.ok,true);
  if(!first.ok) throw Error("FIRST_ACCEPTANCE_FAILED");
  assert.equal(first.action,"CREATED");
  console.log("OK: ALO-Eigenlieferung ohne Fahrer angenommen.");

  const repeat=await acceptAloNowDeliveryV330(base);
  assert.equal(repeat.ok,true);
  if(!repeat.ok) throw Error("REPEAT_FAILED");
  assert.equal(repeat.action,"ALREADY_ACCEPTED");
  assert.equal(
    repeat.validUntil.toISOString(),
    first.validUntil.toISOString()
  );
  console.log("OK: Wiederholung idempotent.");

  const conflict=await acceptAloNowDeliveryV330({
    ...base,
    acceptedBy:"another-manager"
  });
  assert.deepEqual(conflict,{
    ok:false,reason:"DELIVERY_ALREADY_ACCEPTED"
  });
  console.log("OK: Widersprüchliche Annahme blockiert.");

  const parallelId=await fixture();
  const results=await Promise.all([
    acceptAloNowDeliveryV330({
      ...base,requestId:parallelId
    }),
    acceptAloNowDeliveryV330({
      ...base,requestId:parallelId
    })
  ]);

  assert.equal(
    results.filter(r=>r.ok && r.action==="CREATED").length,
    1
  );
  assert.equal(
    results.filter(r=>r.ok && r.action==="ALREADY_ACCEPTED").length,
    1
  );
  console.log("OK: Parallele Annahmen konsistent.");

  const driverId=await fixture();
  const assigned=await acceptAloNowDeliveryV330({
    requestId:driverId,
    method:"ASSIGNED_DRIVER",
    assignedDriverId:"v330-driver-test",
    acceptedBy:"v330-manager-test",
    capacityMinutes:10
  });
  assert.equal(assigned.ok,true);
  console.log("OK: Fahrerlieferung unterstützt.");

  const noQuote=await fixture({verified:false});
  assert.deepEqual(
    await acceptAloNowDeliveryV330({
      ...base,requestId:noQuote
    }),
    {ok:false,reason:"VERIFIED_QUOTE_REQUIRED"}
  );

  const manual=await fixture({quote:"MANUAL_APPROVAL"});
  assert.deepEqual(
    await acceptAloNowDeliveryV330({
      ...base,requestId:manual
    }),
    {ok:false,reason:"VERIFIED_QUOTE_REQUIRED"}
  );
  console.log("OK: Ungeprüfte Preise blockiert.");

  const rejected=await fixture({status:"REJECTED"});
  assert.deepEqual(
    await acceptAloNowDeliveryV330({
      ...base,requestId:rejected
    }),
    {ok:false,reason:"REQUEST_NOT_ACCEPTABLE"}
  );
  console.log("OK: Abgelehnte Anfrage blockiert.");

  const payment=await fixture({
    paymentPhase:"AWAITING_PAYMENT"
  });
  assert.deepEqual(
    await acceptAloNowDeliveryV330({
      ...base,requestId:payment
    }),
    {ok:false,reason:"PAYMENT_ALREADY_STARTED"}
  );
  console.log("OK: Bereits gestartete Zahlung blockiert.");

  const expiredId=await fixture();
  const exp=await acceptAloNowDeliveryV330({
    ...base,requestId:expiredId
  });
  assert.equal(exp.ok,true);

  await db.query(`
    UPDATE alo_now_merchant_acceptances
    SET capacity_confirmed_at=NOW()-INTERVAL '25 minutes',
        capacity_confirmed_until=NOW()-INTERVAL '10 minutes'
    WHERE request_id=$1
  `,[expiredId]);

  assert.deepEqual(
    await acceptAloNowDeliveryV330({
      ...base,requestId:expiredId
    }),
    {ok:false,reason:"CAPACITY_CONFIRMATION_EXPIRED"}
  );
  console.log("OK: Abgelaufene Zusage nicht wiederverwendet.");

  const invalid=await acceptAloNowDeliveryV330({
    ...base,assignedDriverId:"some-driver"
  });
  assert.deepEqual(invalid,{
    ok:false,reason:"INVALID_DRIVER_ASSIGNMENT"
  });
  console.log("OK: Falsche Fahrerzuweisung blockiert.");

  console.log("===== V330 ALLE TESTS BESTANDEN =====");
}

if (
  process.env.NODE_ENV!=="test" ||
  process.env.ALO_RUNTIME_MODE!=="local_test" ||
  process.env.DATABASE_URL!==
    "postgresql://maxim@127.0.0.1:55433/alo_staff_test"
) throw Error("V330_LOCAL_TEST_GUARD");

try {
  await main();
} finally {
  try { await cleanup(); }
  finally { await db.end(); }
}

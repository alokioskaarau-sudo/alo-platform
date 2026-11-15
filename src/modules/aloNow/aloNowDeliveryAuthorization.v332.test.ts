import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {db} from "../../database/db.js";
import {
  authorizeAloNowDeliveryV332
} from "./aloNowDeliveryAuthorization.v332.js";

if (
  process.env.NODE_ENV!=="test" ||
  process.env.ALO_RUNTIME_MODE!=="local_test" ||
  process.env.DATABASE_URL!==
    "postgresql://maxim@127.0.0.1:55433/alo_staff_test"
) throw Error("LOCAL_TEST_GUARD");

const client=await db.connect();
let active=false;

try {
  const identity=(await client.query<{
    name:string;host:string;port:number;
  }>(`
    SELECT current_database() AS name,
           host(inet_server_addr()) AS host,
           inet_server_port() AS port
  `)).rows[0];

  assert.equal(identity.name,"alo_staff_test");
  assert.equal(identity.host,"127.0.0.1");
  assert.equal(Number(identity.port),55433);

  await client.query("BEGIN");
  active=true;
  await client.query("SET LOCAL lock_timeout='3s'");
  await client.query("SET LOCAL statement_timeout='15s'");
  console.log("OK: Lokale Testdatenbank.");

  async function fixture(
    status="PENDING_REVIEW",
    driver:string|null=null
  ) {
    const id=randomUUID();
    await client.query(`
      INSERT INTO alo_now_order_requests (
        id,client_request_id,workspace,
        delivery_address,items,quote_status,
        road_distance_km,status,
        driver_user_id
      ) VALUES (
        $1,$2,'AARAU','V332 LOCAL TEST',
        '[]'::jsonb,'STANDARD',1,$3,$4
      )
    `,[id,"V332-"+id,status,driver]);
    return id;
  }

  async function merchant(
    id:string,untilMinutes:number,
    method="INTERNAL_DELIVERY",
    driver:string|null=null
  ) {
    await client.query(`
      INSERT INTO alo_now_merchant_acceptances (
        request_id,fulfillment_method,accepted_by,
        assigned_driver_id,capacity_confirmed_at,
        capacity_confirmed_until
      ) VALUES (
        $1,$2,'v332-manager',$3,
        clock_timestamp(),
        clock_timestamp()+($4::int * INTERVAL '1 minute')
      )
    `,[id,method,driver,untilMinutes]);
  }

  const id=await fixture();
  const request={
    status:"PENDING_REVIEW",
    driver_user_id:null,
    reservation_valid:false
  };

  const before=await authorizeAloNowDeliveryV332(
    client,id,request
  );
  assert.deepEqual(before,{
    ok:false,
    reason:"DELIVERY_CONFIRMATION_REQUIRED"
  });
  console.log("OK: Unbestätigte Lieferung blockiert.");

  await merchant(id,15);
  const internal=await authorizeAloNowDeliveryV332(
    client,id,request
  );
  assert.deepEqual(internal,{
    ok:true,method:"INTERNAL_DELIVERY"
  });
  console.log("OK: ALO-Eigenlieferung ohne Fahrer zugelassen.");

  const legacy=await authorizeAloNowDeliveryV332(
    client,randomUUID(),{
      status:"DRIVER_ACCEPTED",
      driver_user_id:"v332-driver",
      reservation_valid:true
    }
  );
  assert.deepEqual(legacy,{
    ok:true,method:"ASSIGNED_DRIVER"
  });
  console.log("OK: Bestehende Fahrerreservierung bleibt gültig.");

  const expired=await fixture();
  await merchant(expired,15);
  await client.query(`
    UPDATE alo_now_merchant_acceptances
    SET capacity_confirmed_at=
          clock_timestamp()-INTERVAL '25 minutes',
        capacity_confirmed_until=
          clock_timestamp()-INTERVAL '10 minutes'
    WHERE request_id=$1
  `,[expired]);

  assert.deepEqual(
    await authorizeAloNowDeliveryV332(client,expired,request),
    {ok:false,reason:"MERCHANT_CAPACITY_EXPIRED"}
  );
  console.log("OK: Abgelaufene Eigenlieferung blockiert.");

  assert.deepEqual(
    await authorizeAloNowDeliveryV332(client,id,{
      ...request,status:"REJECTED"
    }),
    {ok:false,reason:"REQUEST_REJECTED"}
  );
  console.log("OK: Abgelehnte Anfrage blockiert.");

  const assigned=await fixture("DRIVER_ACCEPTED","driver-A");
  await merchant(assigned,10,"ASSIGNED_DRIVER","driver-A");

  assert.deepEqual(
    await authorizeAloNowDeliveryV332(client,assigned,{
      status:"DRIVER_ACCEPTED",
      driver_user_id:"driver-A",
      reservation_valid:true
    }),
    {ok:true,method:"ASSIGNED_DRIVER"}
  );

  assert.deepEqual(
    await authorizeAloNowDeliveryV332(client,assigned,{
      status:"DRIVER_ACCEPTED",
      driver_user_id:"driver-B",
      reservation_valid:true
    }),
    {ok:false,reason:"ASSIGNED_DRIVER_INVALID"}
  );

  console.log("OK: Falsche Fahrerzuweisung blockiert.");

  await client.query("ROLLBACK");
  active=false;

  console.log("OK: Sämtliche Testdaten zurückgerollt.");
  console.log("===== V332 ALLE TESTS BESTANDEN =====");
} finally {
  if(active) await client.query("ROLLBACK").catch(()=>{});
  client.release();
  await db.end();
}

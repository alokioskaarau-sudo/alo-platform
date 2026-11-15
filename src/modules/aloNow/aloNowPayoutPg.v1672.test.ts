
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import pg from "pg";

import {
  executePayoutV1666
} from "./aloNowPayoutTransaction.v1666.js";

import {
  quoteDriverWalletV961
} from "./aloNowDriverWallet.v961.js";

import type {
  PayoutStoreV1666,
  PayoutReceiptV1666
} from "./aloNowPayoutTransaction.v1666.js";

import type {
  PayoutContextV1665
} from "./aloNowPayoutPlan.v1665.js";

const {Pool} = pg;

const expected =
  "postgresql://maxim@127.0.0.1:55439/alo_now_v959_migration_test";

if(process.env.DATABASE_URL !== expected){
  throw Error("STOP_WRONG_TEST_DATABASE_URL");
}

const pool = new Pool({
  connectionString:expected,
  max:5
});

const drawerId = randomUUID();
const driverId = "V1672-DRIVER-" + randomUUID();
const adminId = "V1672-ADMIN-" + randomUUID();
const payoutKeyA = "V1672-A-" + randomUUID();
const payoutKeyB = "V1672-B-" + randomUUID();

let fixtureCreated = false;

async function assertTestDatabase(){
  const r=await pool.query(`
    SELECT
      current_database() AS name,
      host(inet_server_addr()) AS address,
      inet_server_port() AS port
  `);

  assert.equal(r.rows[0].name,"alo_now_v959_migration_test");
  assert.equal(r.rows[0].address,"127.0.0.1");
  assert.equal(Number(r.rows[0].port),55439);
}

async function readPayouts(client:pg.PoolClient){
  const r=await client.query<{
    payout_key:string;
    amount_rappen:string;
    card_tip_rappen:string;
    card_commission_rappen:string;
    cash_carryover_rappen:string;
  }>(`
    SELECT payout_key,
      amount_rappen::text,
      card_tip_rappen::text,
      card_commission_rappen::text,
      cash_carryover_rappen::text
    FROM alo_now_driver_payouts_v1669
    WHERE driver_user_id=$1
    ORDER BY created_at,id
  `,[driverId]);

  return r.rows;
}

const store:PayoutStoreV1666={
  withLockedDriver:async(driverUserId,callback)=>{
    if(driverUserId!==driverId)
      throw Error("UNTRUSTED_TEST_DRIVER");

    const client=await pool.connect();

    try{
      await client.query("BEGIN");
      await client.query(
        "SET LOCAL lock_timeout='5s'"
      );
      await client.query(
        "SET LOCAL statement_timeout='20s'"
      );

      // Every payout for this driver uses the same lock.
      await client.query(
        `SELECT pg_advisory_xact_lock(
          hashtextextended($1::text,0)
        )`,
        ["ALO-NOW-PAYOUT:"+driverId]
      );

      const result=await callback({
        loadVerifiedState:async()=>{
          const drawer=await client.query<{
            available_rappen:string;
            workspace:string;
            status:string;
          }>(`
            SELECT available_rappen::text,
              workspace,status
            FROM alo_now_shop_cash_drawers_v1669
            WHERE id=$1
            FOR UPDATE
          `,[drawerId]);

          assert.equal(drawer.rows.length,1);

          const payouts=await readPayouts(client);

          const paid=payouts.reduce(
            (n,r)=>n+Number(r.amount_rappen),0
          );

          const wallet=quoteDriverWalletV961({
            receipts:[{
              orderId:"V1672-CARD-ORDER",
              payment:"CARD",
              orderRappen:4500,
              commissionRappen:800,
              cardTipRappen:400
            }],
            openingFloatRappen:0,
            confirmedEnvelopeRappen:0,
            confirmedPayoutRappen:paid
          });

          const context:PayoutContextV1665={
            adminUserId:adminId,
            adminActive:true,
            adminApproved:true,
            adminRole:"ADMIN",
            allowedWorkspaces:["AARAU"],
            workspace:"AARAU",
            driverUserId:driverId,
            driverWorkspace:"AARAU",
            // Test-only mapping; not a real driver shift.
            payoutShiftId:drawerId,
            payoutShiftWorkspace:"AARAU",
            payoutShiftOpen:
              drawer.rows[0].status==="OPEN",
            availableCashRappen:Number(
              drawer.rows[0].available_rappen
            ),
            // Artificial fixture verified for THIS test only.
            verifiedSources:true,
            reconciliationComplete:true,
            priorPaidCardCommissionRappen:
              payouts.reduce(
                (n,r)=>n+Number(r.card_commission_rappen),0
              ),
            priorPaidCardTipsRappen:
              payouts.reduce(
                (n,r)=>n+Number(r.card_tip_rappen),0
              ),
            priorPaidCashCarryoverRappen:
              payouts.reduce(
                (n,r)=>n+Number(r.cash_carryover_rappen),0
              ),
            existingPayoutKeys:
              payouts.map(r=>r.payout_key)
          };

          return {wallet,context};
        },

        findReceipt:async(key)=>{
          const r=await client.query<{
            payout_key:string;
            driver_user_id:string;
            admin_user_id:string;
            drawer_id:string;
            amount_rappen:string;
            card_tip_rappen:string;
            card_commission_rappen:string;
            cash_carryover_rappen:string;
          }>(`
            SELECT payout_key,driver_user_id,
              admin_user_id,drawer_id,
              amount_rappen::text,
              card_tip_rappen::text,
              card_commission_rappen::text,
              cash_carryover_rappen::text
            FROM alo_now_driver_payouts_v1669
            WHERE payout_key=$1
          `,[key]);

          if(!r.rows[0])return null;

          const x=r.rows[0];

          // Only sufficient for the isolated test contract.
          const amount=Number(x.amount_rappen);

          return {
            payoutKey:x.payout_key,
            driverUserId:x.driver_user_id,
            adminUserId:x.admin_user_id,
            payoutShiftId:x.drawer_id,
            amountRappen:amount,
            cardTipRappen:Number(x.card_tip_rappen),
            cardCommissionRappen:
              Number(x.card_commission_rappen),
            cashCarryoverRappen:
              Number(x.cash_carryover_rappen),
            balanceAfterRappen:1200-amount
          } satisfies PayoutReceiptV1666;
        },

        savePayout:async(receipt)=>{
          if(
            receipt.driverUserId!==driverId ||
            receipt.adminUserId!==adminId ||
            receipt.payoutShiftId!==drawerId
          )throw Error("TEST_PAYOUT_CONTEXT_MISMATCH");

          const debit=await client.query(`
            UPDATE alo_now_shop_cash_drawers_v1669
            SET available_rappen=
              available_rappen-$2
            WHERE id=$1 AND workspace='AARAU'
              AND status='OPEN'
              AND available_rappen >= $2
            RETURNING id
          `,[drawerId,receipt.amountRappen]);

          if(debit.rowCount!==1)
            throw Error("DRAWER_DEBIT_FAILED");

          const payoutId=randomUUID();

          await client.query(`
            INSERT INTO alo_now_driver_payouts_v1669
            (
              id,payout_key,driver_user_id,
              admin_user_id,workspace,drawer_id,
              card_commission_rappen,
              card_tip_rappen,cash_carryover_rappen,
              amount_rappen
            )
            VALUES
            ($1,$2,$3,$4,'AARAU',$5,$6,$7,$8,$9)
          `,[
            payoutId,receipt.payoutKey,
            driverId,adminId,drawerId,
            receipt.cardCommissionRappen,
            receipt.cardTipRappen,
            receipt.cashCarryoverRappen,
            receipt.amountRappen
          ]);

          await client.query(`
            INSERT INTO
              alo_now_payout_cash_movements_v1669
            (
              id,payout_id,drawer_id,
              amount_rappen,movement_type
            )
            VALUES
            ($1,$2,$3,$4,'DRIVER_PAYOUT')
          `,[
            randomUUID(),payoutId,
            drawerId,receipt.amountRappen
          ]);
        }
      });

      await client.query("COMMIT");
      return result;

    }catch(error){
      try{await client.query("ROLLBACK");}
      catch{}
      throw error;
    }finally{
      client.release();
    }
  }
};

function command(key:string,amountRappen=1200){
  return {
    payoutKey:key,
    amountRappen,
    driverUserId:driverId,
    adminUserId:adminId
  };
}

async function main(){
  await assertTestDatabase();
  console.log("LOCAL_DATABASE_IDENTITY: PASS");

  await pool.query(`
    INSERT INTO alo_now_shop_cash_drawers_v1669
    (id,workspace,drawer_code,status,available_rappen)
    VALUES ($1,'AARAU',$2,'OPEN',3000)
  `,[drawerId,"V1672-"+drawerId]);

  fixtureCreated=true;

  const concurrent=await Promise.allSettled([
    executePayoutV1666(command(payoutKeyA),store),
    executePayoutV1666(command(payoutKeyB),store)
  ]);

  assert.equal(
    concurrent.filter(x=>x.status==="fulfilled").length,
    1
  );
  assert.equal(
    concurrent.filter(x=>x.status==="rejected").length,
    1
  );

  console.log("PARALLEL_OVERPAYMENT_BLOCK: PASS");

  const winner=concurrent[0].status==="fulfilled"
    ?payoutKeyA:payoutKeyB;

  const repeated=await executePayoutV1666(
    command(winner),store
  );

  assert.equal(repeated.status,"ALREADY_BOOKED");

  console.log("PAYOUT_IDEMPOTENCY: PASS");

  await assert.rejects(
    executePayoutV1666(command(winner,100),store),
    /PAYOUT_KEY_REUSED/
  );

  console.log("KEY_REUSE_DIFFERENT_AMOUNT: PASS");

  const drawer=await pool.query<{
    available_rappen:string
  }>(`
    SELECT available_rappen::text
    FROM alo_now_shop_cash_drawers_v1669
    WHERE id=$1
  `,[drawerId]);

  assert.equal(Number(drawer.rows[0].available_rappen),1800);

  const payouts=await pool.query(`
    SELECT id FROM alo_now_driver_payouts_v1669
    WHERE driver_user_id=$1
  `,[driverId]);

  assert.equal(payouts.rows.length,1);

  const movements=await pool.query(`
    SELECT id
    FROM alo_now_payout_cash_movements_v1669
    WHERE drawer_id=$1
  `,[drawerId]);

  assert.equal(movements.rows.length,1);

  console.log("ATOMIC_SINGLE_DEBIT_AND_RECEIPT: PASS");
}

async function cleanup(){
  if(!fixtureCreated)return;

  const client=await pool.connect();

  try{
    await client.query("BEGIN");

    await client.query(`
      DELETE FROM alo_now_payout_cash_movements_v1669
      WHERE drawer_id=$1
    `,[drawerId]);

    await client.query(`
      DELETE FROM alo_now_driver_payouts_v1669
      WHERE drawer_id=$1 AND driver_user_id=$2
    `,[drawerId,driverId]);

    await client.query(`
      DELETE FROM alo_now_shop_cash_drawers_v1669
      WHERE id=$1
    `,[drawerId]);

    await client.query("COMMIT");

  }catch(error){
    await client.query("ROLLBACK");
    throw error;
  }finally{
    client.release();
  }

  const remaining=await pool.query(`
    SELECT (
      SELECT count(*)
      FROM alo_now_shop_cash_drawers_v1669
      WHERE id=$1
    ) AS n
  `,[drawerId]);

  assert.equal(Number(remaining.rows[0].n),0);

  console.log("TEST_FIXTURE_CLEANUP: PASS");
}

try{
  await main();
  console.log("ALO_NOW_V1672_POSTGRES_CONCURRENCY_PASS");
}catch(error){
  console.error("V1672_FAILED:",
    error instanceof Error?error.message:String(error));
  process.exitCode=1;
}finally{
  try{await cleanup();}
  catch(error){
    console.error("V1672_CLEANUP_FAILED",error);
    process.exitCode=1;
  }
  await pool.end();
}

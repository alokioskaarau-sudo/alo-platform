// V2288: The real V2281 -> V1645 -> V1649 -> V1641 -> V1592 code path
// executes on real PostgreSQL, using contract-compatible predecessor tables.
// Fictitious order IDs, mocked Shopify. NOT a test of production FK/default schema.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomInt} from 'node:crypto';
import pg from 'pg';
import {executeLocalSessionDispatchV2281} from './aloNowLocalSessionDispatch.v2281.js';
import {fingerprintJournalPayloadV1586} from './aloNowFulfillmentJournal.v1586.js';
import {orderLockKeyV1643} from './aloNowOrderLock.v1643.js';

if (process.env.NODE_ENV !== 'test' ||
    process.env.ALO_NOW_V2281_LOCAL_DISPATCH_TEST !== 'true' ||
    process.env.ALO_NOW_V2288_LOCAL_DB_TEST !== 'true' ||
    !/^alo_v2288_\d+_\d+$/.test(process.env.PGDATABASE ?? '') ||
    process.env.PGHOST !== '127.0.0.1' ||
    process.env.PGPORT !== '55433' ||
    process.env.PGUSER !== 'maxim' ||
    process.env.DATABASE_URL) {
  throw new Error('V2288_TEST_DATABASE_GATE_REJECTED');
}
const config={host:'127.0.0.1',port:55433,user:'maxim',
  database:process.env.PGDATABASE!,ssl:false,connectionTimeoutMillis:5000};
let seq=0;
async function fixture(opts:{driver?:number;phase?:string}={}){
  seq++;
  const n=BigInt(Date.now())*10000n+BigInt(randomInt(1000,9999))+BigInt(seq);
  const shopifyOrderId='gid://shopify/Order/'+n;
  const fulfillmentOrderId='gid://shopify/FulfillmentOrder/'+n;
  const lineId='gid://shopify/FulfillmentOrderLineItem/'+n;
  const fulfillmentId='gid://shopify/Fulfillment/'+n;
  const selectionHash='a'.repeat(64);
  const lines=[{id:lineId,quantity:1}];
  const selected=[{lineItemId:'gid://shopify/LineItem/'+n,quantity:1}];
  const withheld=[{lineItemId:'gid://shopify/LineItem/'+(n+1n),quantity:1}];
  const manifest=[{fulfillmentOrderId,fulfillmentOrderLineItems:lines}];
  const payload={shopifyOrderId,fulfillmentOrderId,selectionHash,lines};
  const client=new pg.Client(config);
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO alo_now_deliveries
      (shopify_order_id,assigned_driver_user_id,delivery_status,age_verification_status)
      VALUES ($1,$2,'ON_THE_WAY','PENDING')`,[shopifyOrderId,opts.driver??7]);
    await client.query(`INSERT INTO alo_now_handoff_ledger
      (shopify_order_id,assigned_driver_user_id,handoff_state,delivered_lines,withheld_lines)
      VALUES($1,7,'PREPARED',$2::jsonb,$3::jsonb)`,
      [shopifyOrderId,JSON.stringify(selected),JSON.stringify(withheld)]);
    await client.query(`INSERT INTO alo_now_payment_states(shopify_order_id,payment_method,phase)
      VALUES($1,'ONLINE',$2)`,[shopifyOrderId,opts.phase??'PAYMENT_CONFIRMED']);
    await client.query(`INSERT INTO alo_now_partial_selections_v1586
      (shopify_order_id,driver_user_id,selection_hash,expected_fulfillments,
       selected_lines,withheld_lines,state)
      VALUES($1,7,$2,$3::jsonb,$4::jsonb,$5::jsonb,'PREPARED')`,
      [shopifyOrderId,selectionHash,JSON.stringify(manifest),JSON.stringify(selected),JSON.stringify(withheld)]);
    await client.query(`INSERT INTO alo_now_fulfillment_journal_v1586
      (shopify_order_id,fulfillment_order_id,selection_hash,payload_hash,fulfillment_lines,state)
      VALUES($1,$2,$3,$4,$5::jsonb,'PREPARED')`,
      [shopifyOrderId,fulfillmentOrderId,selectionHash,fingerprintJournalPayloadV1586(payload),JSON.stringify(lines)]);
    await client.query('COMMIT');
  } catch (error) {await client.query('ROLLBACK').catch(()=>{});throw error;}
  finally {await client.end();}
  return {shopifyOrderId,fulfillmentId,payload};
}
function deps(orderId:string,fulfillmentId:string,opts:{timeout?:boolean;unpaid?:boolean}={}){
  const pool=new pg.Pool({...config,max:3});
  let calls=0,reads=0;
  const d={
    pool,
    async readShopifyOrder(id:string){reads++;assert.equal(id,orderId);return {
      id,cancelledAt:null,displayFinancialStatus:opts.unpaid?'PENDING':'PAID',
      totalPriceSet:{shopMoney:{amount:'10.00',currencyCode:'CHF'}},
      totalOutstandingSet:{shopMoney:{amount:opts.unpaid?'10.00':'0.00',currencyCode:'CHF'}}
    };},
    async readWorkflow(){return {pack_status:'PACKED'};},
    classifyFulfillment(){return 'ALO_NOW';},
    async testOnlyCreateFulfillment(){
      calls++;
      const observer=new pg.Client(config);await observer.connect();
      try {
        const lock=(await observer.query('SELECT pg_try_advisory_lock($1::bigint) AS acquired',
          [orderLockKeyV1643(orderId)])).rows[0]?.acquired;
        assert.equal(lock,false,'same order lock must remain held while Shopify transport runs');
        const row=await observer.query('SELECT state FROM alo_now_fulfillment_journal_v1586 WHERE shopify_order_id=$1',[orderId]);
        assert.equal(row.rows[0]?.state,'DISPATCHING','claim committed before Shopify call');
      } finally {await observer.end();}
      if(opts.timeout)throw Error('SIMULATED_SHOPIFY_TIMEOUT');
      return {id:fulfillmentId,status:'SUCCESS'};
    }
  };
  return {d,pool,stats:()=>({calls,reads})};
}
async function state(orderId:string){
  const c=new pg.Client(config);await c.connect();
  try{return (await c.query('SELECT state FROM alo_now_fulfillment_journal_v1586 WHERE shopify_order_id=$1',[orderId])).rows[0]?.state;}
  finally{await c.end();}
}
const request=(shopifyOrderId:string)=>({shopifyOrderId,staffUserId:'7'});

test('V2288 full chain commits journal before simulated Shopify and refuses duplicate',async()=>{
 const f=await fixture();const h=deps(f.shopifyOrderId,f.fulfillmentId);
 try {
   const result=await executeLocalSessionDispatchV2281(request(f.shopifyOrderId),h.d);
   assert.deepEqual(result,{ok:true,mode:'LOCAL_TEST_DISPATCHED',dispatchedCount:1});
   assert.equal(await state(f.shopifyOrderId),'CONFIRMED');
   const again=await executeLocalSessionDispatchV2281(request(f.shopifyOrderId),h.d);
   assert.equal(again.mode,'ALREADY_CONFIRMED');assert.equal(again.dispatchedCount,0);
   assert.equal(h.stats().calls,1);
 } finally {await h.pool.end();}
});

test('V2288 incorrect assigned driver denies before Shopify read and write',async()=>{
 const f=await fixture({driver:9});const h=deps(f.shopifyOrderId,f.fulfillmentId);
 try {
   await assert.rejects(executeLocalSessionDispatchV2281(request(f.shopifyOrderId),h.d),/NOT_ASSIGNED_TO_DRIVER/);
   assert.deepEqual(h.stats(),{calls:0,reads:0});assert.equal(await state(f.shopifyOrderId),'PREPARED');
 } finally {await h.pool.end();}
});

test('V2288 unconfirmed database payment refuses Shopify fulfillment',async()=>{
 const f=await fixture({phase:'AWAITING_PAYMENT'});const h=deps(f.shopifyOrderId,f.fulfillmentId);
 try {
   await assert.rejects(executeLocalSessionDispatchV2281(request(f.shopifyOrderId),h.d),/ONLINE_PAYMENT_NOT_FULLY_VERIFIED/);
   assert.equal(h.stats().calls,0);assert.equal(await state(f.shopifyOrderId),'PREPARED');
 } finally {await h.pool.end();}
});

test('V2288 ambiguous Shopify outcome persists reconciliation and never retries',async()=>{
 const f=await fixture();const h=deps(f.shopifyOrderId,f.fulfillmentId,{timeout:true});
 try {
   await assert.rejects(executeLocalSessionDispatchV2281(request(f.shopifyOrderId),h.d),/SHOPIFY_RESULT_UNCERTAIN_RECONCILIATION_REQUIRED/);
   assert.equal(await state(f.shopifyOrderId),'RECONCILE_REQUIRED');
   await assert.rejects(executeLocalSessionDispatchV2281(request(f.shopifyOrderId),h.d),/JOURNAL_RECONCILIATION_REQUIRED/);
   assert.equal(h.stats().calls,1);
 } finally {await h.pool.end();}
});

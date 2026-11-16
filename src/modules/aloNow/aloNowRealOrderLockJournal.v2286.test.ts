// V2286: integration of the actual per-order advisory lock and journal SQL.
// Fictitious Shopify GIDs. No real Shopify, Railway, or production database access.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomInt} from 'node:crypto';
import pg from 'pg';
import {orderLockKeyV1643} from './aloNowOrderLock.v1643.js';
import {dispatchJournalEntryV1592} from './aloNowJournalDispatch.v1592.js';
import {fingerprintJournalPayloadV1586} from './aloNowFulfillmentJournal.v1586.js';

if (process.env.NODE_ENV !== 'test' ||
    process.env.ALO_NOW_V2286_LOCAL_DB_TEST !== 'true' ||
    !/^alo_v2286_\d+_\d+$/.test(process.env.PGDATABASE ?? '') ||
    process.env.PGHOST !== '127.0.0.1' ||
    process.env.PGPORT !== '55433' ||
    process.env.PGUSER !== 'maxim' ||
    process.env.DATABASE_URL) {
  throw new Error('V2286_LOCAL_DATABASE_GATE_REJECTED');
}
const config={host:'127.0.0.1',port:55433,user:'maxim',
  database:process.env.PGDATABASE!,ssl:false,connectionTimeoutMillis:5000};
const selectionHash='b'.repeat(64);
let counter=0;
async function setupFixture(){
  counter++;
  const orderNumber=BigInt(Date.now())*10000n+BigInt(randomInt(1000,9999))+BigInt(counter);
  const shopifyOrderId='gid://shopify/Order/'+String(orderNumber);
  const fulfillmentOrderId='gid://shopify/FulfillmentOrder/'+String(orderNumber);
  const lineId='gid://shopify/FulfillmentOrderLineItem/'+String(orderNumber);
  const fulfillmentId='gid://shopify/Fulfillment/'+String(orderNumber);
  const lines=[{id:lineId,quantity:1}];
  const payload={shopifyOrderId,fulfillmentOrderId,selectionHash,lines};
  const client=new pg.Client(config);
  await client.connect();
  try {
    await client.query(`INSERT INTO alo_now_partial_selections_v1586
      (shopify_order_id,driver_user_id,selection_hash,expected_fulfillments,
       selected_lines,withheld_lines,state)
      VALUES ($1,2286,$2,$3::jsonb,$4::jsonb,$5::jsonb,'PREPARED')`,
      [shopifyOrderId,selectionHash,JSON.stringify([{fulfillmentOrderId,fulfillmentOrderLineItems:lines}]),
       JSON.stringify([{lineItemId:'gid://shopify/LineItem/'+String(orderNumber),quantity:1}]),
       JSON.stringify([{lineItemId:'gid://shopify/LineItem/'+String(orderNumber+1n),quantity:1}])]);
    await client.query(`INSERT INTO alo_now_fulfillment_journal_v1586
      (shopify_order_id,fulfillment_order_id,selection_hash,payload_hash,fulfillment_lines,state)
      VALUES ($1,$2,$3,$4,$5::jsonb,'PREPARED')`,
      [shopifyOrderId,fulfillmentOrderId,selectionHash,fingerprintJournalPayloadV1586(payload),JSON.stringify(lines)]);
  } finally {await client.end();}
  return {shopifyOrderId,fulfillmentId,payload};
}

async function acquire(client:InstanceType<typeof pg.Client>,key:string){
  await client.query('SELECT pg_advisory_lock($1::bigint)',[key]);
}
async function release(client:InstanceType<typeof pg.Client>,key:string){
  const row=await client.query('SELECT pg_advisory_unlock($1::bigint) AS released',[key]);
  assert.equal(row.rows[0]?.released,true);
}

test('V2286 real session lock serializes journal and rejects subsequent dispatch',async()=>{
  const {shopifyOrderId,fulfillmentId,payload}=await setupFixture();
  const key=orderLockKeyV1643(shopifyOrderId);
  const first=new pg.Client(config),second=new pg.Client(config);
  await first.connect();await second.connect();
  let firstLocked=false,secondLocked=false,calls=0;
  try {
    await acquire(first,key);firstLocked=true;
    const blocked=await second.query('SELECT pg_try_advisory_lock($1::bigint) AS acquired',[key]);
    assert.equal(blocked.rows[0]?.acquired,false);
    const result=await dispatchJournalEntryV1592({payload,db:first,createFulfillment:async()=>{
      calls++;
      const independent=await second.query('SELECT state FROM alo_now_fulfillment_journal_v1586 WHERE shopify_order_id=$1',[shopifyOrderId]);
      assert.equal(independent.rows[0]?.state,'DISPATCHING');
      return {id:fulfillmentId,status:'SUCCESS'};
    }});
    assert.equal(result.shopifyFulfillmentId,fulfillmentId);
    await release(first,key);firstLocked=false;
    const next=await second.query('SELECT pg_try_advisory_lock($1::bigint) AS acquired',[key]);
    assert.equal(next.rows[0]?.acquired,true);secondLocked=true;
    await assert.rejects(dispatchJournalEntryV1592({payload,db:second,
      createFulfillment:async()=>{calls++;return {id:fulfillmentId,status:'SUCCESS'};}}),
      /JOURNAL_NOT_PREPARED_OR_ALREADY_DISPATCHED/);
    assert.equal(calls,1);
    const row=await second.query('SELECT state FROM alo_now_fulfillment_journal_v1586 WHERE shopify_order_id=$1',[shopifyOrderId]);
    assert.equal(row.rows[0]?.state,'CONFIRMED');
  }finally{
    if(firstLocked)await release(first,key).catch(()=>{});
    if(secondLocked)await release(second,key).catch(()=>{});
    await first.end();await second.end();
  }
});

test('V2286 real lock and journal block retry after Shopify timeout',async()=>{
  const {shopifyOrderId,fulfillmentId,payload}=await setupFixture();
  const key=orderLockKeyV1643(shopifyOrderId);
  const first=new pg.Client(config),second=new pg.Client(config);
  await first.connect();await second.connect();
  let firstLocked=false,secondLocked=false,calls=0;
  try {
    await acquire(first,key);firstLocked=true;
    await assert.rejects(dispatchJournalEntryV1592({payload,db:first,createFulfillment:async()=>{
      calls++;throw Error('MOCK_TIMEOUT');
    }}),/SHOPIFY_RESULT_UNCERTAIN_RECONCILIATION_REQUIRED/);
    await release(first,key);firstLocked=false;
    await acquire(second,key);secondLocked=true;
    await assert.rejects(dispatchJournalEntryV1592({payload,db:second,
      createFulfillment:async()=>{calls++;return {id:fulfillmentId,status:'SUCCESS'};}}),
      /JOURNAL_NOT_PREPARED_OR_ALREADY_DISPATCHED/);
    assert.equal(calls,1);
    const state=await second.query('SELECT state FROM alo_now_fulfillment_journal_v1586 WHERE shopify_order_id=$1',[shopifyOrderId]);
    assert.equal(state.rows[0]?.state,'RECONCILE_REQUIRED');
  }finally{
    if(firstLocked)await release(first,key).catch(()=>{});
    if(secondLocked)await release(second,key).catch(()=>{});
    await first.end();await second.end();
  }
});

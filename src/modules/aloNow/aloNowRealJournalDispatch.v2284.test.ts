// V2284: tests production SQL in the actual local schema on a disposable database.
// Uses fictitious GIDs and a MOCK transport; never connects to real Shopify.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {dispatchJournalEntryV1592} from './aloNowJournalDispatch.v1592.js';
import {fingerprintJournalPayloadV1586} from './aloNowFulfillmentJournal.v1586.js';

if (process.env.NODE_ENV !== 'test' ||
    process.env.ALO_NOW_V2284_LOCAL_DB_TEST !== 'true' ||
    !/^alo_v2284_\d+_\d+$/.test(process.env.PGDATABASE ?? '') ||
    process.env.PGHOST !== '127.0.0.1' ||
    process.env.PGPORT !== '55433' ||
    process.env.PGUSER !== 'maxim' ||
    process.env.DATABASE_URL) {
  throw new Error('V2284_LOCAL_DATABASE_GATE_REJECTED');
}
const config = {host:'127.0.0.1',port:55433,user:'maxim',
  database:process.env.PGDATABASE!,ssl:false,connectionTimeoutMillis:5000};
const selectionHash = 'a'.repeat(64);
const fulfillmentOrderId='gid://shopify/FulfillmentOrder/900002284';
const lineId='gid://shopify/FulfillmentOrderLineItem/900002284';
const fulfilledId='gid://shopify/Fulfillment/900002284';
async function fixture() {
  const client = new pg.Client(config);
  await client.connect();
  const shopifyOrderId='gid://shopify/Order/'+String(BigInt('900002284')+BigInt(Math.floor(Math.random()*10000000)));
  const payload={shopifyOrderId,fulfillmentOrderId,selectionHash,lines:[{id:lineId,quantity:1}]};
  const payloadHash=fingerprintJournalPayloadV1586(payload);
  try {
    await client.query(`INSERT INTO alo_now_partial_selections_v1586
      (shopify_order_id,driver_user_id,selection_hash,expected_fulfillments,
       selected_lines,withheld_lines,state)
      VALUES ($1,2284,$2,$3::jsonb,$4::jsonb,$5::jsonb,'PREPARED')`,
      [shopifyOrderId,selectionHash,JSON.stringify([{fulfillmentOrderId,fulfillmentOrderLineItems:payload.lines}]),
       JSON.stringify([{lineItemId:'gid://shopify/LineItem/900002284',quantity:1}]),
       JSON.stringify([{lineItemId:'gid://shopify/LineItem/900002285',quantity:1}])]);
    await client.query(`INSERT INTO alo_now_fulfillment_journal_v1586
      (shopify_order_id,fulfillment_order_id,selection_hash,payload_hash,fulfillment_lines,state)
      VALUES ($1,$2,$3,$4,$5::jsonb,'PREPARED')`,
      [shopifyOrderId,fulfillmentOrderId,selectionHash,payloadHash,JSON.stringify(payload.lines)]);
  } catch(e) { await client.end();throw e; }
  return {client,payload,shopifyOrderId};
}

test('V2284 real journal commit precedes mock Shopify and duplicate never dispatches',async()=>{
  const {client,payload,shopifyOrderId}=await fixture();let calls=0;
  try {
    const result=await dispatchJournalEntryV1592({payload,db:client,
      createFulfillment:async()=>{
        calls++;
        const state=(await client.query('SELECT state FROM alo_now_fulfillment_journal_v1586 WHERE shopify_order_id=$1',[shopifyOrderId])).rows[0]?.state;
        assert.equal(state,'DISPATCHING');
        const observer=new pg.Client(config);await observer.connect();
        try {assert.equal((await observer.query('SELECT state FROM alo_now_fulfillment_journal_v1586 WHERE shopify_order_id=$1',[shopifyOrderId])).rows[0]?.state,'DISPATCHING');}
        finally {await observer.end();}
        return {id:fulfilledId,status:'SUCCESS'};
      }});
    assert.equal(result.shopifyFulfillmentId,fulfilledId);
    assert.equal(calls,1);
    assert.equal((await client.query('SELECT state FROM alo_now_fulfillment_journal_v1586 WHERE shopify_order_id=$1',[shopifyOrderId])).rows[0]?.state,'CONFIRMED');
    await assert.rejects(dispatchJournalEntryV1592({payload,db:client,createFulfillment:async()=>{calls++;return {id:fulfilledId,status:'SUCCESS'};}}),/JOURNAL_NOT_PREPARED_OR_ALREADY_DISPATCHED/);
    assert.equal(calls,1);
  } finally {await client.end();}
});

test('V2284 real journal timeout becomes durable reconciliation, never retries',async()=>{
  const {client,payload,shopifyOrderId}=await fixture();let calls=0;
  try {
    await assert.rejects(dispatchJournalEntryV1592({payload,db:client,
      createFulfillment:async()=>{calls++;throw new Error('SIMULATED_SHOPIFY_TIMEOUT');}}),
      /SHOPIFY_RESULT_UNCERTAIN_RECONCILIATION_REQUIRED/);
    assert.equal((await client.query('SELECT state FROM alo_now_fulfillment_journal_v1586 WHERE shopify_order_id=$1',[shopifyOrderId])).rows[0]?.state,'RECONCILE_REQUIRED');
    await assert.rejects(dispatchJournalEntryV1592({payload,db:client,
      createFulfillment:async()=>{calls++;return {id:fulfilledId,status:'SUCCESS'};}}),
      /JOURNAL_NOT_PREPARED_OR_ALREADY_DISPATCHED/);
    assert.equal(calls,1);
  } finally {await client.end();}
});

test('V2285 concurrent journal dispatch permits one claim and one Shopify invocation', async()=>{
  const {client: first,payload,shopifyOrderId}=await fixture();
  const concurrentFulfillmentId='gid://shopify/Fulfillment/'+shopifyOrderId.split('/').at(-1);
  const second=new pg.Client(config); await second.connect();
  let calls=0;
  let startShopify!:()=>void;
  const shopifyEntered=new Promise<void>(resolve=>{startShopify=resolve;});
  let releaseShopify!:()=>void;
  const shopifyHold=new Promise<void>(resolve=>{releaseShopify=resolve;});
  try {
    const firstDispatch=dispatchJournalEntryV1592({payload,db:first,createFulfillment:async()=>{
      calls++;startShopify();await shopifyHold;
      return {id:concurrentFulfillmentId,status:'SUCCESS'};
    }});
    await shopifyEntered;
    const observed=await second.query(
      'SELECT state FROM alo_now_fulfillment_journal_v1586 WHERE shopify_order_id=$1',[shopifyOrderId]);
    assert.equal(observed.rows[0]?.state,'DISPATCHING');
    await assert.rejects(dispatchJournalEntryV1592({payload,db:second,
      createFulfillment:async()=>{calls++;return {id:concurrentFulfillmentId,status:'SUCCESS'};}}),
      /JOURNAL_NOT_PREPARED_OR_ALREADY_DISPATCHED/);
    assert.equal(calls,1);
    releaseShopify();
    await firstDispatch;
    const final=await second.query(
      'SELECT state,shopify_fulfillment_id FROM alo_now_fulfillment_journal_v1586 WHERE shopify_order_id=$1',[shopifyOrderId]);
    assert.equal(final.rows[0]?.state,'CONFIRMED');
    assert.equal(final.rows[0]?.shopify_fulfillment_id,concurrentFulfillmentId);
    assert.equal(calls,1);
  } finally {releaseShopify?.();await first.end();await second.end();}
});

test('V2285 altered line payload never claims journal or calls Shopify',async()=>{
  const {client,payload,shopifyOrderId}=await fixture();let calls=0;
  try {
    const changed={...payload,lines:[{...payload.lines[0],quantity:2}]};
    await assert.rejects(dispatchJournalEntryV1592({payload:changed,db:client,
      createFulfillment:async()=>{calls++;return {id:fulfilledId,status:'SUCCESS'};}}),
      /JOURNAL_NOT_PREPARED_OR_ALREADY_DISPATCHED/);
    assert.equal(calls,0);
    const row=await client.query(
      'SELECT state FROM alo_now_fulfillment_journal_v1586 WHERE shopify_order_id=$1',[shopifyOrderId]);
    assert.equal(row.rows[0]?.state,'PREPARED');
  } finally {await client.end();}
});

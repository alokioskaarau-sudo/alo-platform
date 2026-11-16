// V2283: real PostgreSQL transaction/lock proof on an ephemeral, isolated LOCAL DB.
// No real orders, no real Shopify integration, no production DB connection.
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {orderLockKeyV1643} from './aloNowOrderLock.v1643.js';

if (process.env.NODE_ENV !== 'test' || process.env.ALO_NOW_V2283_LOCAL_DB_TEST !== 'true' ||
    !/^alo_v2283_[0-9]+_[0-9]+$/.test(process.env.PGDATABASE ?? '') ||
    process.env.PGHOST !== '127.0.0.1' || process.env.PGPORT !== '55433' ||
    process.env.PGUSER !== 'maxim' || process.env.DATABASE_URL) {
  throw new Error('V2283_LOCAL_DATABASE_GATE_REJECTED');
}
const connection = { host:'127.0.0.1', port:55433, user:'maxim',
  database:process.env.PGDATABASE!, ssl:false, connectionTimeoutMillis:5000 };
const order='gid://shopify/Order/9000002283';
const key=orderLockKeyV1643(order);

async function clients() {
  const a=new pg.Client(connection); const b=new pg.Client(connection);
  await a.connect();
  try {await b.connect();} catch(e){await a.end();throw e;}
  return {a,b,close:async()=>{await b.end();await a.end();}};
}

test('V2283 session advisory lock blocks second client and releases correctly', async()=>{
  const {a,b,close}=await clients();
  try {
    const got=await a.query('SELECT pg_try_advisory_lock($1::bigint) AS ok',[key]);
    assert.equal(got.rows[0].ok,true);
    assert.equal((await b.query('SELECT pg_try_advisory_lock($1::bigint) AS ok',[key])).rows[0].ok,false);
    assert.equal((await a.query('SELECT pg_advisory_unlock($1::bigint) AS ok',[key])).rows[0].ok,true);
    assert.equal((await b.query('SELECT pg_try_advisory_lock($1::bigint) AS ok',[key])).rows[0].ok,true);
    assert.equal((await b.query('SELECT pg_advisory_unlock($1::bigint) AS ok',[key])).rows[0].ok,true);
  } finally {await close();}
});

test('V2283 uncommitted claim is invisible and committed claim persists on independent session',async()=>{
  const {a,b,close}=await clients();
  try {
    await a.query('BEGIN');
    await a.query('INSERT INTO alo_v2283_dispatch_probe(order_id,state) VALUES ($1,$2)',[order,'PREPARED']);
    assert.equal((await b.query('SELECT count(*)::int AS n FROM alo_v2283_dispatch_probe WHERE order_id=$1',[order])).rows[0].n,0);
    await a.query('COMMIT');
    assert.equal((await b.query('SELECT state FROM alo_v2283_dispatch_probe WHERE order_id=$1',[order])).rows[0].state,'PREPARED');
    await a.query('BEGIN');
    assert.equal((await a.query("UPDATE alo_v2283_dispatch_probe SET state='DISPATCHING' WHERE order_id=$1 AND state='PREPARED' RETURNING order_id",[order])).rowCount,1);
    assert.equal((await b.query('SELECT state FROM alo_v2283_dispatch_probe WHERE order_id=$1',[order])).rows[0].state,'PREPARED');
    await a.query('COMMIT');
    assert.equal((await b.query('SELECT state FROM alo_v2283_dispatch_probe WHERE order_id=$1',[order])).rows[0].state,'DISPATCHING');
    assert.equal((await b.query("UPDATE alo_v2283_dispatch_probe SET state='DISPATCHING' WHERE order_id=$1 AND state='PREPARED' RETURNING order_id",[order])).rowCount,0);
  } finally {await a.query('ROLLBACK').catch(()=>{});await close();}
});

test('V2283 rolled back transition cannot authorize external call',async()=>{
  const {a,b,close}=await clients();let simulatedShopifyCalls=0;
  try {
    await a.query('BEGIN');
    await a.query("UPDATE alo_v2283_dispatch_probe SET state='CONFIRMED' WHERE order_id=$1 AND state='DISPATCHING'",[order]);
    await a.query('ROLLBACK');
    const state=(await b.query('SELECT state FROM alo_v2283_dispatch_probe WHERE order_id=$1',[order])).rows[0].state;
    assert.equal(state,'DISPATCHING');
    const wouldDispatch = (value: string) => value === 'CONFIRMED';
    if(wouldDispatch(state)) simulatedShopifyCalls++;
    assert.equal(simulatedShopifyCalls,0);
  } finally {await a.query('ROLLBACK').catch(()=>{});await close();}
});

test('V2283 reconciliation status is durable and blocks repeated claim',async()=>{
  const {a,b,close}=await clients();
  try {
    assert.equal((await a.query("UPDATE alo_v2283_dispatch_probe SET state='RECONCILE_REQUIRED' WHERE order_id=$1 AND state='DISPATCHING' RETURNING order_id",[order])).rowCount,1);
    assert.equal((await b.query('SELECT state FROM alo_v2283_dispatch_probe WHERE order_id=$1',[order])).rows[0].state,'RECONCILE_REQUIRED');
    assert.equal((await b.query("UPDATE alo_v2283_dispatch_probe SET state='DISPATCHING' WHERE order_id=$1 AND state='PREPARED' RETURNING order_id",[order])).rowCount,0);
  } finally {await close();}
});

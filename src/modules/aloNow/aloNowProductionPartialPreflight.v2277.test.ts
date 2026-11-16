import test from "node:test";
import assert from "node:assert/strict";
import {inspectProductionPartialPreflightV2277} from "./aloNowProductionPartialPreflight.v2277.js";
import {fingerprintJournalPayloadV1586} from "./aloNowFulfillmentJournal.v1586.js";

const order="gid://shopify/Order/123";
const fulfillmentOrderId="gid://shopify/FulfillmentOrder/456";
const line={id:"gid://shopify/FulfillmentOrderLineItem/789",quantity:1};
const selectionHash="a".repeat(64);
const hash=fingerprintJournalPayloadV1586({shopifyOrderId:order,fulfillmentOrderId,selectionHash,lines:[line]});
function harness(opts:{denied?:boolean; unpaid?:boolean; badUnlock?:boolean}={}) {
  let locked=false, released=false, shopReads=0;
  const db={
    async query(sql:string) {
      if (sql.includes("pg_advisory_lock(")) {locked=true;return {rows:[],rowCount:1};}
      if (sql.includes("pg_advisory_unlock(")) {locked=false;return {rows:[{released:!opts.badUnlock}],rowCount:1};}
      assert.equal(locked,true,"read outside order lock");
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql.trim())) return {rows:[],rowCount:null};
      if (sql.includes("to_regclass(")) return {rows:[{handoff:"ok",selections:"ok",journal:"ok"}],rowCount:1};
      if (sql.includes("FROM alo_now_deliveries")) return {rows:[{assigned_driver_user_id:opts.denied?"99":"7",delivery_status:"ON_THE_WAY",age_verification_status:"PENDING"}],rowCount:1};
      if (sql.includes("FROM alo_now_handoff_ledger")) return {rows:[{assigned_driver_user_id:"7",handoff_state:"PREPARED",delivered_lines:[{lineItemId:"1",quantity:1}],withheld_lines:[{lineItemId:"2",quantity:1}]}],rowCount:1};
      if (sql.includes("FROM alo_now_partial_selections_v1586")) return {rows:[{driver_user_id:"7",selection_hash:selectionHash,state:"PREPARED",expected_fulfillments:[{fulfillmentOrderId,fulfillmentOrderLineItems:[line]}],selected_lines:[{lineItemId:"1",quantity:1}],withheld_lines:[{lineItemId:"2",quantity:1}]}],rowCount:1};
      if (sql.includes("FROM alo_now_fulfillment_journal_v1586")) return {rows:[{fulfillment_order_id:fulfillmentOrderId,selection_hash:selectionHash,payload_hash:hash,fulfillment_lines:[line],state:"PREPARED",shopify_fulfillment_id:null}],rowCount:1};
      if (sql.includes("FROM alo_now_payment_states")) return {rows:[{shopify_order_id:order,payment_method:"ONLINE",phase:opts.unpaid?"AWAITING_PAYMENT":"PAYMENT_CONFIRMED"}],rowCount:1};
      throw new Error("UNEXPECTED_SQL");
    },
    release(destroy?:boolean) {released=true;assert.equal(Boolean(destroy),Boolean(opts.badUnlock));},
  };
  const deps={pool:{async connect(){return db;}},async readShopifyOrder(id:string){shopReads++;assert.equal(id,order);return {id:order,cancelledAt:null,displayFinancialStatus:"PAID",totalPriceSet:{shopMoney:{amount:"10.00",currencyCode:"CHF"}},totalOutstandingSet:{shopMoney:{amount:"0.00",currencyCode:"CHF"}}};},async readWorkflow(){return {pack_status:"PACKED"};},classifyFulfillment(){return "ALO_NOW";}};
  return {deps,stats:()=>({locked,released,shopReads})};
}
test("V2277 successful preflight is NOT dispatch authorization",async()=>{
  const h=harness();const result=await inspectProductionPartialPreflightV2277({shopifyOrderId:order,staffUserId:"7"},h.deps);
  assert.deepEqual(result,{ok:true,status:"PREFLIGHT_ONLY_NOT_AUTHORIZED",pendingFulfillmentOrders:1});
  assert.equal(h.stats().locked,false);assert.equal(h.stats().released,true);
});
test("V2277 rejects a different assigned driver before Shopify read",async()=>{
  const h=harness({denied:true});await assert.rejects(inspectProductionPartialPreflightV2277({shopifyOrderId:order,staffUserId:"7"},h.deps),/NOT_ASSIGNED_TO_DRIVER/);
  assert.equal(h.stats().shopReads,0);assert.equal(h.stats().released,true);
});
test("V2277 rejects unpaid orders",async()=>{
  const h=harness({unpaid:true});await assert.rejects(inspectProductionPartialPreflightV2277({shopifyOrderId:order,staffUserId:"7"},h.deps),/ONLINE_PAYMENT_NOT_FULLY_VERIFIED/);
  assert.equal(h.stats().released,true);
});
test("V2277 rejects uncertain unlock and destroys session",async()=>{
  const h=harness({badUnlock:true});await assert.rejects(inspectProductionPartialPreflightV2277({shopifyOrderId:order,staffUserId:"7"},h.deps),/V2277_LOCK_RELEASE_UNCERTAIN/);
  assert.equal(h.stats().released,true);
});

// V2278 EXTRA FAILURE TESTS: Never dispatch or mutate Shopify.
test("V2278 invalid request is rejected without acquiring a DB connection",async()=>{
  let connects=0;
  const h=harness();
  const deps={...h.deps,pool:{async connect(){connects++;return h.deps.pool.connect();}}};
  await assert.rejects(
    inspectProductionPartialPreflightV2277({shopifyOrderId:"invalid",staffUserId:"7"},deps),
    /INVALID_V2277_PREFLIGHT_CONTEXT/
  );
  assert.equal(connects,0);
  assert.equal(h.stats().shopReads,0);
});

test("V2278 interrupted lock acquisition destroys uncertain session",async()=>{
  let destroyed: boolean | undefined;
  let shopReads=0;
  const h=harness();
  const deps={...h.deps,
    pool:{async connect(){return {
      async query(sql:string){
        if(sql.includes("pg_advisory_lock(")) throw new Error("SIMULATED_LOCK_INTERRUPTION");
        throw new Error("UNEXPECTED_SQL_AFTER_INTERRUPTED_LOCK");
      },
      release(destroy?:boolean){destroyed=destroy;}
    };}},
    async readShopifyOrder(...args:Parameters<typeof h.deps.readShopifyOrder>){shopReads++;return h.deps.readShopifyOrder(...args);}
  };
  await assert.rejects(
    inspectProductionPartialPreflightV2277({shopifyOrderId:order,staffUserId:"7"},deps),
    /SIMULATED_LOCK_INTERRUPTION/
  );
  assert.equal(destroyed,true);
  assert.equal(shopReads,0);
});

test("V2278 Shopify read failure still releases acquired lock",async()=>{
  const h=harness();
  const deps={...h.deps,
    async readShopifyOrder(_id:string):Promise<null>{throw new Error("SIMULATED_SHOPIFY_NETWORK_FAILURE");}
  };
  await assert.rejects(
    inspectProductionPartialPreflightV2277({shopifyOrderId:order,staffUserId:"7"},deps),
    /SIMULATED_SHOPIFY_NETWORK_FAILURE/
  );
  assert.equal(h.stats().locked,false);
  assert.equal(h.stats().released,true);
});


test("V2279 rollback uncertainty destroys DB session even when unlock succeeds",async()=>{
  const h=harness();
  let releasedWith: boolean | undefined;
  let unlocked=false;
  const deps={...h.deps,pool:{async connect(){
    const client=await h.deps.pool.connect();
    return {
      async query(sql:string,params?:unknown[]){
        if(sql.includes("FROM alo_now_deliveries")) throw new Error("SIMULATED_READ_FAILURE");
        if(sql.trim()==="ROLLBACK") throw new Error("SIMULATED_ROLLBACK_FAILURE");
        if(sql.includes("pg_advisory_unlock(")) unlocked=true;
        return client.query(sql);
      },
      release(destroy?:boolean){releasedWith=destroy;}
    };
  }}};
  await assert.rejects(
    inspectProductionPartialPreflightV2277({shopifyOrderId:order,staffUserId:"7"},deps),
    /SNAPSHOT_ROLLBACK_UNCERTAIN_DESTROY_CLIENT/
  );
  assert.equal(unlocked,true);
  assert.equal(releasedWith,true);
  assert.equal(h.stats().shopReads,0);
});

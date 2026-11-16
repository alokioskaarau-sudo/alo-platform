import test from "node:test";
import assert from "node:assert/strict";
import {executeLocalSessionDispatchV2281} from "./aloNowLocalSessionDispatch.v2281.js";
import {fingerprintJournalPayloadV1586} from "./aloNowFulfillmentJournal.v1586.js";

const order="gid://shopify/Order/123";
const fulfillmentOrderId="gid://shopify/FulfillmentOrder/456";
const line={id:"gid://shopify/FulfillmentOrderLineItem/789",quantity:1};
const selectionHash="a".repeat(64);
const hash=fingerprintJournalPayloadV1586({shopifyOrderId:order,fulfillmentOrderId,selectionHash,lines:[line]});
function harness(options:{denied?:boolean;timeout?:boolean;commitFail?:boolean;confirmationFail?:boolean;reconcileFail?:boolean;unlockFail?:boolean}={}) {
  let locked=false,tx=false,calls=0,connects=0,releaseCount=0,destroyed=false;
  let journal="PREPARED";
  const client={
    async query(sql:string, params?:unknown[]) {
      const s=sql.replace(/\s+/g," ").trim();
      if (s.includes("pg_advisory_lock(")) { assert.equal(locked,false);locked=true;return {rows:[],rowCount:1}; }
      if (s.includes("pg_advisory_unlock(")) {assert.equal(locked,true);if(options.unlockFail)throw Error("SIMULATED_UNLOCK_FAILURE");locked=false;return {rows:[{released:true}],rowCount:1};}
      assert.equal(locked,true,"All SQL on the lock-owning session");
      if (s.startsWith("BEGIN")){assert.equal(tx,false);tx=true;return {rows:[],rowCount:null};}
      if (s==="COMMIT"){assert.equal(tx,true);if(options.commitFail)throw Error("SIMULATED_COMMIT_FAILURE");tx=false;return {rows:[],rowCount:null};}
      if (s==="ROLLBACK"){tx=false;if(options.commitFail)journal="PREPARED";return {rows:[],rowCount:null};}
      if (s.includes("to_regclass("))return {rows:[{handoff:"ok",selections:"ok",journal:"ok"}],rowCount:1};
      if (s.includes("FROM alo_now_deliveries"))return {rows:[{assigned_driver_user_id:options.denied?"9":"7",delivery_status:"ON_THE_WAY",age_verification_status:"PENDING"}],rowCount:1};
      if (s.includes("FROM alo_now_handoff_ledger"))return {rows:[{assigned_driver_user_id:"7",handoff_state:"PREPARED",delivered_lines:[{lineItemId:"1",quantity:1}],withheld_lines:[{lineItemId:"2",quantity:1}]}],rowCount:1};
      if (s.includes("FROM alo_now_partial_selections_v1586") && s.startsWith("SELECT"))return {rows:[{driver_user_id:"7",selection_hash:selectionHash,state:"PREPARED",expected_fulfillments:[{fulfillmentOrderId,fulfillmentOrderLineItems:[line]}],selected_lines:[{lineItemId:"1",quantity:1}],withheld_lines:[{lineItemId:"2",quantity:1}]}],rowCount:1};
      if (s.includes("FROM alo_now_fulfillment_journal_v1586"))return {rows:[{fulfillment_order_id:fulfillmentOrderId,selection_hash:selectionHash,payload_hash:hash,fulfillment_lines:[line],state:journal,shopify_fulfillment_id:null}],rowCount:1};
      if (s.includes("FROM alo_now_payment_states"))return {rows:[{shopify_order_id:order,payment_method:"ONLINE",phase:"PAYMENT_CONFIRMED"}],rowCount:1};
      if (s.includes("SET state = 'DISPATCHING'")){assert.equal(tx,true);if(journal!=="PREPARED")return {rows:[],rowCount:0};journal="DISPATCHING";return {rows:[{}],rowCount:1};}
      if (s.includes("SET state = 'RECONCILE_REQUIRED'")){assert.equal(tx,false);if(options.reconcileFail)throw Error("SIMULATED_RECONCILE_FAILURE");journal="RECONCILE_REQUIRED";return {rows:[{}],rowCount:1};}
      if (s.includes("SET state = 'CONFIRMED'")){assert.equal(tx,false);if(options.confirmationFail)throw Error("SIMULATED_CONFIRMATION_FAILURE");journal="CONFIRMED";return {rows:[{}],rowCount:1};}
      throw new Error("UNEXPECTED_SQL:"+s.slice(0,100));
    },
    release(destroy?:boolean){releaseCount++;destroyed=!!destroy;if(destroy)locked=false;assert.equal(locked,false);}
  };
  const deps={
    pool:{async connect(){connects++;return client;}},
    async readShopifyOrder(){return {id:order,cancelledAt:null,displayFinancialStatus:"PAID",totalPriceSet:{shopMoney:{amount:"10.00",currencyCode:"CHF"}},totalOutstandingSet:{shopMoney:{amount:"0.00",currencyCode:"CHF"}}};},
    async readWorkflow(){return {pack_status:"PACKED"};},
    classifyFulfillment(){return "ALO_NOW";},
    async testOnlyCreateFulfillment(){assert.equal(locked,true);assert.equal(tx,false);assert.equal(journal,"DISPATCHING");calls++;if(options.timeout)throw new Error("SIMULATED_TIMEOUT");return {id:"gid://shopify/Fulfillment/999",status:"SUCCESS"};}
  };
  return {deps,stats:()=>({locked,tx,calls,connects,releaseCount,destroyed,journal})};
}
const request={shopifyOrderId:order,staffUserId:"7"};
test("V2281 production default gate refuses BEFORE obtaining a client",async()=>{
 const old=process.env.ALO_NOW_V2281_LOCAL_DISPATCH_TEST;
 delete process.env.ALO_NOW_V2281_LOCAL_DISPATCH_TEST;
 try {const h=harness();await assert.rejects(executeLocalSessionDispatchV2281(request,h.deps),/V2281_PRODUCTION_DISPATCH_FORBIDDEN/);assert.equal(h.stats().connects,0);}
 finally {if(old===undefined)delete process.env.ALO_NOW_V2281_LOCAL_DISPATCH_TEST;else process.env.ALO_NOW_V2281_LOCAL_DISPATCH_TEST=old;}
});
test("V2281 same session protects locked snapshot, payment and durable dispatch",async()=>{
 const h=harness();const result=await executeLocalSessionDispatchV2281(request,h.deps);
 assert.deepEqual(result,{ok:true,mode:"LOCAL_TEST_DISPATCHED",dispatchedCount:1});
 assert.deepEqual(h.stats(),{locked:false,tx:false,calls:1,connects:1,releaseCount:1,destroyed:false,journal:"CONFIRMED"});
});
test("V2281 rejects wrong driver before any Shopify read or write",async()=>{
 const h=harness({denied:true});await assert.rejects(executeLocalSessionDispatchV2281(request,h.deps),/NOT_ASSIGNED_TO_DRIVER/);
 assert.equal(h.stats().calls,0);assert.equal(h.stats().releaseCount,1);
});
test("V2281 uncertain Shopify response blocks a second fulfillment",async()=>{
 const h=harness({timeout:true});await assert.rejects(executeLocalSessionDispatchV2281(request,h.deps),/SHOPIFY_RESULT_UNCERTAIN_RECONCILIATION_REQUIRED/);
 assert.equal(h.stats().journal,"RECONCILE_REQUIRED");assert.equal(h.stats().calls,1);
 await assert.rejects(executeLocalSessionDispatchV2281(request,h.deps),/JOURNAL_RECONCILIATION_REQUIRED/);
 assert.equal(h.stats().calls,1);
});

// V2282: Failure paths through the same session-owning orchestrator.
test("V2282 simulated claim commit failure never reaches Shopify",async()=>{
 const h=harness({commitFail:true});
 await assert.rejects(executeLocalSessionDispatchV2281(request,h.deps),/SIMULATED_COMMIT_FAILURE/);
 assert.equal(h.stats().calls,0);
 assert.equal(h.stats().releaseCount,1);
 assert.equal(h.stats().tx,false);
});

test("V2282 Shopify success plus journal confirmation error never retries",async()=>{
 const h=harness({confirmationFail:true});
 await assert.rejects(executeLocalSessionDispatchV2281(request,h.deps),/SHOPIFY_SUCCEEDED_JOURNAL_CONFIRMATION_UNCERTAIN/);
 assert.equal(h.stats().calls,1);
 assert.equal(h.stats().journal,"DISPATCHING");
 await assert.rejects(executeLocalSessionDispatchV2281(request,h.deps),/JOURNAL_RECONCILIATION_REQUIRED/);
 assert.equal(h.stats().calls,1);
});

test("V2282 reconciliation persistence error destroys uncertain client",async()=>{
 const h=harness({timeout:true,reconcileFail:true});
 await assert.rejects(executeLocalSessionDispatchV2281(request,h.deps),/SHOPIFY_RESULT_UNCERTAIN_AND_JOURNAL_UNCERTAIN/);
 assert.equal(h.stats().calls,1);
 assert.equal(h.stats().destroyed,true);
 assert.equal(h.stats().releaseCount,1);
});

test("V2282 failed advisory unlock forces client destruction",async()=>{
 const h=harness({unlockFail:true});
 await assert.rejects(executeLocalSessionDispatchV2281(request,h.deps),/V2281_UNLOCK_UNCERTAIN/);
 assert.equal(h.stats().calls,1);
 assert.equal(h.stats().destroyed,true);
 assert.equal(h.stats().releaseCount,1);
});

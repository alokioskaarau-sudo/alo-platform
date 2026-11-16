// V2280: Isolated in-memory SQL and Shopify stubs. No live services.
import test from "node:test";
import assert from "node:assert/strict";
import {dispatchJournalEntryV1592} from "./aloNowJournalDispatch.v1592.js";
import {fingerprintJournalPayloadV1586} from "./aloNowFulfillmentJournal.v1586.js";

const payload={
  shopifyOrderId:"gid://shopify/Order/123",
  fulfillmentOrderId:"gid://shopify/FulfillmentOrder/456",
  selectionHash:"a".repeat(64),
  lines:[{id:"gid://shopify/FulfillmentOrderLineItem/789",quantity:1}],
};
const hash=fingerprintJournalPayloadV1586(payload);

type Options={
  failCommit?:boolean;
  timeout?:boolean;
  failConfirmation?:boolean;
  rejectClaim?:boolean;
};
function harness(options:Options={}){
  let state:"PREPARED"|"DISPATCHING"|"CONFIRMED"|"RECONCILE_REQUIRED"="PREPARED";
  let inTransaction=false;
  let shopifyCalls=0;
  const sqlHistory:string[]=[];
  const db={
    async query(sql:string,params?:unknown[]){
      const normalized=sql.replace(/\s+/g," ").trim();
      sqlHistory.push(normalized);
      if(normalized==="BEGIN"){
        assert.equal(inTransaction,false);
        inTransaction=true;
        return {rows:[],rowCount:null};
      }
      if(normalized==="COMMIT"){
        assert.equal(inTransaction,true);
        if(options.failCommit)throw new Error("SIMULATED_COMMIT_FAILURE");
        inTransaction=false;
        return {rows:[],rowCount:null};
      }
      if(normalized==="ROLLBACK"){
        inTransaction=false;
        return {rows:[],rowCount:null};
      }
      assert.deepEqual(params?.slice(0,4),[
        payload.shopifyOrderId,payload.fulfillmentOrderId,payload.selectionHash,hash
      ]);
      if(normalized.includes("state = 'DISPATCHING'") && normalized.includes("state = 'PREPARED'")){
        assert.equal(inTransaction,true,"Claim must be transactional");
        if(options.rejectClaim||state!=="PREPARED")return {rows:[],rowCount:0};
        state="DISPATCHING";
        return {rows:[{fulfillment_order_id:payload.fulfillmentOrderId}],rowCount:1};
      }
      if(normalized.includes("state = 'RECONCILE_REQUIRED'")){
        assert.equal(inTransaction,false);
        if(state!=="DISPATCHING")return {rows:[],rowCount:0};
        state="RECONCILE_REQUIRED";
        return {rows:[{fulfillment_order_id:payload.fulfillmentOrderId}],rowCount:1};
      }
      if(normalized.includes("state = 'CONFIRMED'")){
        assert.equal(inTransaction,false);
        assert.equal(params?.[4],"gid://shopify/Fulfillment/999");
        if(options.failConfirmation)throw new Error("SIMULATED_PERSIST_FAILURE");
        if(state!=="DISPATCHING")return {rows:[],rowCount:0};
        state="CONFIRMED";
        return {rows:[{fulfillment_order_id:payload.fulfillmentOrderId}],rowCount:1};
      }
      throw Error("UNEXPECTED_SQL: "+normalized.slice(0,100));
    }
  };
  const createFulfillment=async(input:{fulfillmentOrderId:string;fulfillmentOrderLineItems:Array<{id:string;quantity:number}>})=>{
    shopifyCalls++;
    assert.equal(inTransaction,false,"No Shopify mutation before durable claim");
    assert.equal(state,"DISPATCHING","Shopify mutation requires claimed journal");
    assert.equal(input.fulfillmentOrderId,payload.fulfillmentOrderId);
    assert.deepEqual(input.fulfillmentOrderLineItems,payload.lines);
    if(options.timeout)throw Error("SIMULATED_SHOPIFY_TIMEOUT");
    return {id:"gid://shopify/Fulfillment/999",status:"SUCCESS"};
  };
  return {db,createFulfillment,inspect:()=>({state,inTransaction,shopifyCalls,sqlHistory})};
}

test("V2280 successful dispatch commits claim before Shopify and confirms journal",async()=>{
  const h=harness();
  const result=await dispatchJournalEntryV1592({payload,db:h.db,createFulfillment:h.createFulfillment});
  assert.deepEqual(result,{ok:true,mode:"FULFILLMENT_CONFIRMED",shopifyFulfillmentId:"gid://shopify/Fulfillment/999"});
  assert.equal(h.inspect().state,"CONFIRMED");
  assert.equal(h.inspect().shopifyCalls,1);
  assert.equal(h.inspect().inTransaction,false);
});

test("V2280 Shopify timeout marks reconciliation and never auto-retries",async()=>{
  const h=harness({timeout:true});
  await assert.rejects(dispatchJournalEntryV1592({payload,db:h.db,createFulfillment:h.createFulfillment}),/SHOPIFY_RESULT_UNCERTAIN_RECONCILIATION_REQUIRED/);
  assert.equal(h.inspect().state,"RECONCILE_REQUIRED");
  assert.equal(h.inspect().shopifyCalls,1);
  await assert.rejects(dispatchJournalEntryV1592({payload,db:h.db,createFulfillment:h.createFulfillment}),/JOURNAL_NOT_PREPARED_OR_ALREADY_DISPATCHED/);
  assert.equal(h.inspect().shopifyCalls,1);
});

test("V2280 failed durable claim commit never invokes Shopify",async()=>{
  const h=harness({failCommit:true});
  await assert.rejects(dispatchJournalEntryV1592({payload,db:h.db,createFulfillment:h.createFulfillment}),/SIMULATED_COMMIT_FAILURE/);
  assert.equal(h.inspect().shopifyCalls,0);
  assert.equal(h.inspect().inTransaction,false);
});

test("V2280 rejected journal claim never invokes Shopify",async()=>{
  const h=harness({rejectClaim:true});
  await assert.rejects(dispatchJournalEntryV1592({payload,db:h.db,createFulfillment:h.createFulfillment}),/JOURNAL_NOT_PREPARED_OR_ALREADY_DISPATCHED/);
  assert.equal(h.inspect().shopifyCalls,0);
  assert.equal(h.inspect().inTransaction,false);
});

test("V2280 confirmed Shopify response with DB persistence failure is not retried",async()=>{
  const h=harness({failConfirmation:true});
  await assert.rejects(dispatchJournalEntryV1592({payload,db:h.db,createFulfillment:h.createFulfillment}),/SHOPIFY_SUCCEEDED_JOURNAL_CONFIRMATION_UNCERTAIN/);
  assert.equal(h.inspect().state,"DISPATCHING");
  assert.equal(h.inspect().shopifyCalls,1);
  await assert.rejects(dispatchJournalEntryV1592({payload,db:h.db,createFulfillment:h.createFulfillment}),/JOURNAL_NOT_PREPARED_OR_ALREADY_DISPATCHED/);
  assert.equal(h.inspect().shopifyCalls,1);
});

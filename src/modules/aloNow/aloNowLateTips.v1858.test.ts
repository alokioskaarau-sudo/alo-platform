import test from "node:test";
import assert from "node:assert/strict";
import {readEarningsLedgerV1815} from "./aloNowEarningsLedger.v1815.js";
import {evaluateCardWalletEvidenceV1676} from "./aloNowWalletEvidence.v1676.js";

const scope = {orderId:"gid://shopify/Order/123", driverUserId:"101", workspace:"AARAU" as const};
const event = (type:string, n:number, source:string) => ({event_key:`${type}-${source}`,event_type:type,driver_user_id:"101",workspace:"AARAU",order_id:scope.orderId,amount_rappen:String(n),source_reference:source});
const ledgerRows = [event("COMMISSION_EARNED",300,"commission-123"), event("ONLINE_TIP_EARNED",200,"capture-1"),event("ONLINE_TIP_EARNED",100,"capture-2")];

test("Ledger supports multiple independent tip captures without authorizing payout",async()=>{
 const r=await readEarningsLedgerV1815(scope,async()=>({rows:ledgerRows}));
 assert.equal(r.status,"BOOKINGS_PRESENT_UNVERIFIED");
 assert.equal(r.tipCount,2);
 assert.equal(r.payoutEnabled,false);
});
test("Ledger blocks duplicated capture reference",async()=>{
 const duplicate={...ledgerRows[2],event_key:"unique-key",source_reference:"capture-1"};
 const r=await readEarningsLedgerV1815(scope,async()=>({rows:[ledgerRows[0],ledgerRows[1],duplicate]}));
 assert.equal(r.status,"BLOCKED");
});
test("Ledger refuses unbounded query response",async()=>{
 const rows=[ledgerRows[0],...Array.from({length:100},(_,i)=>({...ledgerRows[1],event_key:`k-${i}`,source_reference:`source-${i}`}))];
 const r=await readEarningsLedgerV1815(scope,async()=>({rows}));
 assert.equal(r.status,"BLOCKED");
});
const evidence = () => ({
 ...scope,delivery:{orderId:scope.orderId,driverUserId:scope.driverUserId,workspace:scope.workspace,status:"DELIVERED",deliveredAt:"2026-11-08T10:00:00Z",cancelledAt:null},
 payment:{orderId:scope.orderId,method:"CARD",providerConfirmed:true,reconciliationOpen:false,reversedOrRefunded:false},
 handoff:{orderId:scope.orderId,driverUserId:scope.driverUserId,finalVerified:true,settlementFinal:true},
 orderRappen:5000,orderTotalVerified:true,
 financeEvents:[
 {orderId:scope.orderId,driverUserId:scope.driverUserId,workspace:scope.workspace,type:"COMMISSION_EARNED",amountRappen:300,sourceVerified:true,sourceReference:"commission"},
 {orderId:scope.orderId,driverUserId:scope.driverUserId,workspace:scope.workspace,type:"ONLINE_TIP_EARNED",amountRappen:200,sourceVerified:true,sourceReference:"capture-1"},
 {orderId:scope.orderId,driverUserId:scope.driverUserId,workspace:scope.workspace,type:"ONLINE_TIP_EARNED",amountRappen:100,sourceVerified:true,sourceReference:"capture-2"}
 ]
});
test("Wallet aggregates two verified tips in rappen",()=>{
 const r=evaluateCardWalletEvidenceV1676(evidence());
 assert.equal(r.eligible,true);
 if(r.eligible) {assert.equal(r.receipt.commissionRappen,300);assert.equal(r.receipt.cardTipRappen,300);}
});
test("Wallet blocks repeated provider reference",()=>{
 const e=evidence();e.financeEvents[2].sourceReference="capture-1";
 const r=evaluateCardWalletEvidenceV1676(e);
 assert.equal(r.eligible,false);
});

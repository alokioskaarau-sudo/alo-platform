
import test from "node:test";
import assert from "node:assert/strict";
import {quoteDriverWalletV961} from "./aloNowDriverWallet.v961.js";
import {executePayoutV1666} from "./aloNowPayoutTransaction.v1666.js";
import type {
  PayoutStoreV1666,
  PayoutReceiptV1666
} from "./aloNowPayoutTransaction.v1666.js";
import type {PayoutContextV1665} from "./aloNowPayoutPlan.v1665.js";

const receipts = [
  {
    orderId:"card-1",
    payment:"CARD" as const,
    orderRappen:4500,
    commissionRappen:800,
    cardTipRappen:400
  }
];

function mock() {
  let saved:PayoutReceiptV1666[] = [];
  let cash = 3000;
  let failSave = false;
  let verified = true;
  let role:"ADMIN"|"DRIVER" = "ADMIN";
  let workspace:"AARAU"|"OLTEN" = "AARAU";
  let tail:Promise<unknown> = Promise.resolve();

  const store:PayoutStoreV1666 = {
    withLockedDriver:async(_driver, callback) => {
      const previous = tail;
      let release!:()=>void;
      tail = new Promise<void>(r=>{release=r;});
      await previous.catch(()=>{});

      const staged = saved.slice();
      let stagedCash = cash;

      try {
        const output = await callback({
          loadVerifiedState:async() => {
            const paid = staged.reduce(
              (n,r)=>n+r.amountRappen,0
            );

            const paidTips = staged.reduce(
              (n,r)=>n+r.cardTipRappen,0
            );

            const paidCommission = staged.reduce(
              (n,r)=>n+r.cardCommissionRappen,0
            );

            const wallet = quoteDriverWalletV961({
              receipts,
              openingFloatRappen:0,
              confirmedEnvelopeRappen:0,
              confirmedPayoutRappen:paid
            });

            const context:PayoutContextV1665 = {
              adminUserId:"admin-1",
              adminActive:true,
              adminApproved:true,
              adminRole:role,
              allowedWorkspaces:["AARAU"],
              workspace,
              driverUserId:"driver-1",
              driverWorkspace:"AARAU",
              payoutShiftId:"shift-1",
              payoutShiftWorkspace:"AARAU",
              payoutShiftOpen:true,
              availableCashRappen:stagedCash,
              verifiedSources:verified,
              reconciliationComplete:verified,
              priorPaidCardCommissionRappen:paidCommission,
              priorPaidCardTipsRappen:paidTips,
              priorPaidCashCarryoverRappen:0,
              existingPayoutKeys:staged.map(r=>r.payoutKey)
            };
            return {wallet,context};
          },
          findReceipt:async(key) =>
            staged.find(r=>r.payoutKey===key)??null,
          savePayout:async(receipt) => {
            if(failSave) throw Error("SIMULATED_DB_FAILURE");
            if(staged.some(r=>r.payoutKey===receipt.payoutKey))
              throw Error("DUPLICATE_PAYOUT_KEY");
            if(stagedCash<receipt.amountRappen)
              throw Error("PAYOUT_CASH_INSUFFICIENT");
            stagedCash-=receipt.amountRappen;
            staged.push(receipt);
          }
        });
        saved=staged;
        cash=stagedCash;
        return output;
      }finally{
        release();
      }
    }
  };

  return {
    store,
    records:()=>saved.slice(),
    cash:()=>cash,
    fail:(v:boolean)=>{failSave=v;},
    verify:(v:boolean)=>{verified=v;},
    role:(v:"ADMIN"|"DRIVER")=>{role=v;},
    workspace:(v:"AARAU"|"OLTEN")=>{workspace=v;}
  };
}

const cmd = (
  key:string,
  amountRappen=1200
) => ({
  payoutKey:key,
  amountRappen,
  driverUserId:"driver-1",
  adminUserId:"admin-1"
});

test("Kartentrinkgeld und Provision atomar geplant",async()=>{
  const m=mock();
  const r=await executePayoutV1666(cmd("payout-1001"),m.store);
  assert.equal(r.status,"BOOKED");
  assert.equal(r.receipt.cardTipRappen,400);
  assert.equal(r.receipt.cardCommissionRappen,800);
  assert.equal(m.records().length,1);
  assert.equal(m.cash(),1800);
});

test("Gleiche Referenz bleibt idempotent",async()=>{
  const m=mock();
  await executePayoutV1666(cmd("payout-1002"),m.store);
  const again=await executePayoutV1666(cmd("payout-1002"),m.store);
  assert.equal(again.status,"ALREADY_BOOKED");
  assert.equal(m.records().length,1);
  assert.equal(m.cash(),1800);
});

test("Referenz mit anderem Betrag wird abgelehnt",async()=>{
  const m=mock();
  await executePayoutV1666(cmd("payout-1003",300),m.store);
  await assert.rejects(
    executePayoutV1666(cmd("payout-1003",400),m.store),
    /PAYOUT_KEY_REUSED/
  );
});

test("Zwei parallele Vollauszahlungen buchen nur einmal",async()=>{
  const m=mock();
  const result=await Promise.allSettled([
    executePayoutV1666(cmd("payout-1004"),m.store),
    executePayoutV1666(cmd("payout-1005"),m.store)
  ]);
  assert.equal(result.filter(x=>x.status==="fulfilled").length,1);
  assert.equal(result.filter(x=>x.status==="rejected").length,1);
  assert.equal(m.records().length,1);
  assert.equal(m.cash(),1800);
});

test("Zwei parallele Teilbeträge werden neu berechnet",async()=>{
  const m=mock();
  const result=await Promise.all([
    executePayoutV1666(cmd("payout-1006",300),m.store),
    executePayoutV1666(cmd("payout-1007",500),m.store)
  ]);
  assert.equal(result.length,2);
  assert.equal(m.records().length,2);
  assert.equal(m.cash(),2200);
  const total=m.records().reduce((n,r)=>n+r.amountRappen,0);
  assert.equal(total,800);
});

test("Datenbankfehler führt zu Rollback",async()=>{
  const m=mock();
  m.fail(true);
  await assert.rejects(
    executePayoutV1666(cmd("payout-1008"),m.store),
    /SIMULATED_DB_FAILURE/
  );
  assert.equal(m.records().length,0);
  assert.equal(m.cash(),3000);
});

test("Unverifizierte Finanzquellen blockieren",async()=>{
  const m=mock();
  m.verify(false);
  await assert.rejects(
    executePayoutV1666(cmd("payout-1009"),m.store),
    /PAYOUT_EVIDENCE_NOT_VERIFIED/
  );
  assert.equal(m.records().length,0);
});

test("Fahrerrolle blockiert Auszahlung",async()=>{
  const m=mock();
  m.role("DRIVER");
  await assert.rejects(
    executePayoutV1666(cmd("payout-1010"),m.store),
    /PAYOUT_ACTOR_MISMATCH/
  );
});

test("Falscher Standort blockiert Auszahlung",async()=>{
  const m=mock();
  m.workspace("OLTEN");
  await assert.rejects(
    executePayoutV1666(cmd("payout-1011"),m.store),
    /PAYOUT_WORKSPACE_MISMATCH/
  );
});

test("Zu grosse Auszahlung verändert keine Buchung",async()=>{
  const m=mock();
  await assert.rejects(
    executePayoutV1666(cmd("payout-1012",1201),m.store),
    /PAYOUT_EXCEEDS_BALANCE/
  );
  assert.equal(m.records().length,0);
  assert.equal(m.cash(),3000);
});

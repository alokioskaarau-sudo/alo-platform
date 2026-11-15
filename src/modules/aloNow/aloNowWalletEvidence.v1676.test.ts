
import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateCardWalletEvidenceV1676
} from "./aloNowWalletEvidence.v1676.js";
import type {
  EvidenceV1676
} from "./aloNowWalletEvidence.v1676.js";

function fixture():EvidenceV1676{
  return {
    orderId:"ORDER-TEST-1",
    workspace:"AARAU",
    driverUserId:"DRIVER-TEST-1",
    delivery:{
      orderId:"ORDER-TEST-1",
      workspace:"AARAU",
      driverUserId:"DRIVER-TEST-1",
      status:"DELIVERED",
      deliveredAt:"2026-11-04T12:00:00Z",
      cancelledAt:null
    },
    payment:{
      orderId:"ORDER-TEST-1",
      method:"CARD",
      providerConfirmed:true,
      reconciliationOpen:false,
      reversedOrRefunded:false
    },
    handoff:{
      orderId:"ORDER-TEST-1",
      driverUserId:"DRIVER-TEST-1",
      finalVerified:true,
      settlementFinal:true
    },
    orderRappen:4500,
    orderTotalVerified:true,
    financeEvents:[
      {
        orderId:"ORDER-TEST-1",
        driverUserId:"DRIVER-TEST-1",
        workspace:"AARAU",
        type:"COMMISSION_EARNED",
        amountRappen:800,
        sourceVerified:true
      },
      {
        orderId:"ORDER-TEST-1",
        driverUserId:"DRIVER-TEST-1",
        workspace:"AARAU",
        type:"ONLINE_TIP_EARNED",
        amountRappen:400,
        sourceVerified:true
      }
    ]
  };
}

test("vollständiger Kartennachweis",()=>{
  const r=evaluateCardWalletEvidenceV1676(fixture());
  assert.equal(r.eligible,true);
  if(!r.eligible)return;
  assert.equal(r.receipt.commissionRappen,800);
  assert.equal(r.receipt.cardTipRappen,400);
});

test("unvollständige Lieferung gesperrt",()=>{
  const e=fixture();
  e.delivery.status="ON_THE_WAY";
  assert.equal(
    evaluateCardWalletEvidenceV1676(e).eligible,false
  );
});

test("falscher Fahrer gesperrt",()=>{
  const e=fixture();
  e.delivery.driverUserId="OTHER-DRIVER";
  assert.equal(
    evaluateCardWalletEvidenceV1676(e).eligible,false
  );
});

test("nicht bestätigte Kartenzahlung gesperrt",()=>{
  const e=fixture();
  e.payment.providerConfirmed=false;
  assert.equal(
    evaluateCardWalletEvidenceV1676(e).eligible,false
  );
});

test("offene Zahlungsabweichung gesperrt",()=>{
  const e=fixture();
  e.payment.reconciliationOpen=true;
  assert.equal(
    evaluateCardWalletEvidenceV1676(e).eligible,false
  );
});

test("Rückerstattung gesperrt",()=>{
  const e=fixture();
  e.payment.reversedOrRefunded=true;
  assert.equal(
    evaluateCardWalletEvidenceV1676(e).eligible,false
  );
});

test("fehlender Handoff-Nachweis gesperrt",()=>{
  const e=fixture();
  e.handoff.finalVerified=false;
  assert.equal(
    evaluateCardWalletEvidenceV1676(e).eligible,false
  );
});

test("offene Abrechnung gesperrt",()=>{
  const e=fixture();
  e.handoff.settlementFinal=false;
  assert.equal(
    evaluateCardWalletEvidenceV1676(e).eligible,false
  );
});

test("unbelegte Provision gesperrt",()=>{
  const e=fixture();
  e.financeEvents[0].sourceVerified=false;
  assert.equal(
    evaluateCardWalletEvidenceV1676(e).eligible,false
  );
});

test("doppelte Provision gesperrt",()=>{
  const e=fixture();
  e.financeEvents=[
    ...e.financeEvents,e.financeEvents[0]
  ];
  assert.equal(
    evaluateCardWalletEvidenceV1676(e).eligible,false
  );
});

test("falsche Bestellreferenz gesperrt",()=>{
  const e=fixture();
  e.financeEvents[0].orderId="OTHER-ORDER";
  assert.equal(
    evaluateCardWalletEvidenceV1676(e).eligible,false
  );
});

test("Kassen-Trinkgeld nicht als Online-Tipp",()=>{
  const e=fixture();
  e.financeEvents=[
    e.financeEvents[0],
    {...e.financeEvents[1],type:"CASH_TIP_COLLECTED"}
  ];
  assert.equal(
    evaluateCardWalletEvidenceV1676(e).eligible,false
  );
});

test("Karte ohne Trinkgeld erlaubt",()=>{
  const e=fixture();
  e.financeEvents=[e.financeEvents[0]];
  const r=evaluateCardWalletEvidenceV1676(e);
  assert.equal(r.eligible,true);
  if(r.eligible)assert.equal(r.receipt.cardTipRappen,0);
});

test("ungeprüfter Bestellbetrag gesperrt",()=>{
  const e=fixture();
  e.orderTotalVerified=false;
  assert.equal(
    evaluateCardWalletEvidenceV1676(e).eligible,false
  );
});

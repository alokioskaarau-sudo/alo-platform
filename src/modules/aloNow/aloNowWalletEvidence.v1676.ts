
import type {
  VerifiedDriverReceiptV961
} from "./aloNowDriverWallet.v961.js";

/**
 * ALO NOW V1676 – pure evidence gate, staging only.
 *
 * Inputs MUST originate from independent, authoritative
 * backend sources. This function does not query Shopify
 * or PostgreSQL and does not itself authenticate evidence.
 *
 * Never expose this input directly to an HTTP client.
 */
export type EvidenceV1676 = {
  orderId:string;
  workspace:"AARAU"|"OLTEN";
  driverUserId:string;

  delivery:{
    orderId:string;
    workspace:string;
    driverUserId:string;
    status:string;
    deliveredAt:string|null;
    cancelledAt:string|null;
  };

  payment:{
    orderId:string;
    method:string;
    providerConfirmed:boolean;
    reconciliationOpen:boolean;
    reversedOrRefunded:boolean;
  };

  handoff:{
    orderId:string;
    driverUserId:string;
    finalVerified:boolean;
    settlementFinal:boolean;
  };

  financeEvents:readonly {
    orderId:string;
    driverUserId:string;
    workspace:string;
    type:string;
    amountRappen:number;
    sourceVerified:boolean;
    /** Required for each tip if an order has multiple tip captures. */
    sourceReference?: string;
  }[];

  orderRappen:number;
  orderTotalVerified:boolean;
};

export type EvidenceResultV1676 =
  | {
      eligible:true;
      receipt:VerifiedDriverReceiptV961;
    }
  | {
      eligible:false;
      reason:string;
    };

const money=(n:number)=>
  Number.isSafeInteger(n)&&n>=0;

const reject=(reason:string):EvidenceResultV1676=>
  ({eligible:false,reason});

export function evaluateCardWalletEvidenceV1676(
  e:EvidenceV1676
):EvidenceResultV1676 {

  if(!e || typeof e.orderId!=="string" ||
     !e.orderId.trim() ||
     !e.driverUserId?.trim() ||
     !["AARAU","OLTEN"].includes(e.workspace)){
    return reject("INVALID_IDENTITY");
  }

  if(!e.delivery ||
     e.delivery.orderId!==e.orderId ||
     e.delivery.driverUserId!==e.driverUserId ||
     e.delivery.workspace!==e.workspace ||
     e.delivery.status!=="DELIVERED" ||
     !e.delivery.deliveredAt ||
     e.delivery.cancelledAt){
    return reject("DELIVERY_NOT_VERIFIED");
  }

  if(!e.payment ||
     e.payment.orderId!==e.orderId ||
     e.payment.method!=="CARD" ||
     e.payment.providerConfirmed!==true ||
     e.payment.reconciliationOpen!==false ||
     e.payment.reversedOrRefunded!==false){
    return reject("PAYMENT_NOT_VERIFIED");
  }

  if(!e.handoff ||
     e.handoff.orderId!==e.orderId ||
     e.handoff.driverUserId!==e.driverUserId ||
     e.handoff.finalVerified!==true ||
     e.handoff.settlementFinal!==true){
    return reject("HANDOFF_NOT_VERIFIED");
  }

  if(e.orderTotalVerified!==true ||
     !money(e.orderRappen) ||
     e.orderRappen<=0){
    return reject("ORDER_TOTAL_NOT_VERIFIED");
  }

  if(!Array.isArray(e.financeEvents)){
    return reject("FINANCE_EVENTS_MISSING");
  }

  // Only commission and online tip events belong to
  // this card-wallet entitlement calculation.
  const allowed=new Set([
    "COMMISSION_EARNED",
    "ONLINE_TIP_EARNED"
  ]);

  const relevant=e.financeEvents.filter(
    x=>allowed.has(x.type)
  );

  if(relevant.length!==e.financeEvents.length){
    return reject("UNEXPECTED_FINANCE_EVENT");
  }

  if(relevant.some(x=>
    x.orderId!==e.orderId ||
    x.driverUserId!==e.driverUserId ||
    x.workspace!==e.workspace ||
    x.sourceVerified!==true ||
    !money(x.amountRappen) ||
    x.amountRappen<=0
  )){
    return reject("FINANCE_SOURCE_MISMATCH");
  }

  const commissions=relevant.filter(
    x=>x.type==="COMMISSION_EARNED"
  );
  const tips=relevant.filter(
    x=>x.type==="ONLINE_TIP_EARNED"
  );

  if(commissions.length!==1 || tips.length>99){
    return reject("FINANCE_EVENT_CARDINALITY");
  }

  // Multiple independent tip payments may arrive after delivery.
  // A validated provider reference is mandatory for each when there
  // is more than one; two events cannot reuse the same capture.
  if (tips.length > 1) {
    const captures = tips.map(x => x.sourceReference?.trim());
    if (captures.some(x => !x) || new Set(captures).size !== captures.length) {
      return reject("DUPLICATE_OR_UNVERIFIED_TIP_CAPTURE");
    }
  }
  const commissionRappen=commissions[0].amountRappen;
  let cardTipRappen=0;
  for (const tip of tips) {
    cardTipRappen += tip.amountRappen;
    if (!Number.isSafeInteger(cardTipRappen)) {
      return reject("FINANCE_AMOUNT_OVERFLOW");
    }
  }

  if(!Number.isSafeInteger(
    commissionRappen+cardTipRappen
  )){
    return reject("FINANCE_AMOUNT_OVERFLOW");
  }

  return {
    eligible:true,
    receipt:{
      orderId:e.orderId,
      payment:"CARD",
      orderRappen:e.orderRappen,
      commissionRappen,
      cardTipRappen
    }
  };
}

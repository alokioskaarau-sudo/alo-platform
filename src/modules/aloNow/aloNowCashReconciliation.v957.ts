/** ALO NOW V957 – pure reconciliation policy; no DB access or payment posting.
 * All money uses integer CHF rappen. Opening float is company property.
 * Cash tips must be explicitly additional to the charged order amount.
 */
export type DriverOrderReceiptV957 = {
  orderId: string;
  channel: "CASH" | "CARD";
  orderPaidRappen: number;
  commissionEarnedRappen: number;
  cashTipRappen: number;
  onlineTipRappen: number;
};
export type CashShiftSnapshotV957 = {
  shiftId: string;
  driverUserId: string;
  workspace: "AARAU" | "OLTEN";
  openingFloatRappen: number;
  receipts: readonly DriverOrderReceiptV957[];
  confirmedPriorEnvelopeRappen?: number;
  paidCardEarningsRappen?: number;
};
export type CashShiftQuoteV957 = {
  shiftId: string;
  cashOrdersRappen: number;
  cashTipsRetainedRappen: number;
  cashCommissionsRetainedRappen: number;
  cashCommissionCarryoverRappen: number;
  cardEarningsRappen: number;
  paidCardEarningsRappen: number;
  cardOutstandingRappen: number;
  expectedEnvelopeRemainingRappen: number;
  expectedOpeningFloatReturnRappen: number;
  expectedCashInCustodyRappen: number;
  retainedByDriverAlreadyRappen: number;
};
function money(n:number):number {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("INVALID_RAPPEN_AMOUNT");
  return n;
}
function plus(a:number,b:number):number { return money(a+b); }
export function quoteCashShiftV957(s:CashShiftSnapshotV957):CashShiftQuoteV957 {
  if (!s.shiftId?.trim() || !s.driverUserId?.trim() ||
    (s.workspace!=="AARAU" && s.workspace!=="OLTEN")) throw new Error("INVALID_SHIFT_CONTEXT");
  const opening=money(s.openingFloatRappen);
  const prior=money(s.confirmedPriorEnvelopeRappen ?? 0);
  const paid=money(s.paidCardEarningsRappen ?? 0);
  const ids=new Set<string>();
  let cashOrders=0,cashTips=0,cashCommission=0,cardEarnings=0;
  for(const r of s.receipts){
    if(!r.orderId?.trim() || ids.has(r.orderId)) throw new Error("DUPLICATE_OR_INVALID_ORDER");
    ids.add(r.orderId);
    money(r.orderPaidRappen);money(r.commissionEarnedRappen);
    money(r.cashTipRappen);money(r.onlineTipRappen);
    if(r.channel==="CASH"){
      if(r.onlineTipRappen!==0)throw new Error("CASH_ORDER_WITH_ONLINE_TIP_UNSUPPORTED");
      cashOrders=plus(cashOrders,r.orderPaidRappen);
      cashTips=plus(cashTips,r.cashTipRappen);
      cashCommission=plus(cashCommission,r.commissionEarnedRappen);
    }else if(r.channel==="CARD"){
      if(r.cashTipRappen!==0)throw new Error("CARD_ORDER_WITH_CASH_TIP_UNSUPPORTED");
      cardEarnings=plus(cardEarnings,plus(r.commissionEarnedRappen,r.onlineTipRappen));
    }else throw new Error("INVALID_PAYMENT_CHANNEL");
  }
  const retainedCommission=Math.min(cashOrders,cashCommission);
  const carryover=cashCommission-retainedCommission;
  const grossEnvelope=cashOrders-retainedCommission;
  if(prior>grossEnvelope)throw new Error("PRIOR_ENVELOPE_EXCEEDS_EXPECTED");
  const cardPlusCarryover=plus(cardEarnings,carryover);
  if(paid>cardPlusCarryover)throw new Error("CARD_PAYOUT_EXCEEDS_OUTSTANDING");
  const remaining=grossEnvelope-prior;
  return {
    shiftId:s.shiftId,cashOrdersRappen:cashOrders,
    cashTipsRetainedRappen:cashTips,
    cashCommissionsRetainedRappen:retainedCommission,
    cashCommissionCarryoverRappen:carryover,
    cardEarningsRappen:cardPlusCarryover,
    paidCardEarningsRappen:paid,
    cardOutstandingRappen:cardPlusCarryover-paid,
    expectedEnvelopeRemainingRappen:remaining,
    expectedOpeningFloatReturnRappen:opening,
    expectedCashInCustodyRappen:plus(opening,remaining),
    retainedByDriverAlreadyRappen:plus(cashTips,retainedCommission)
  };
}
export type EnvelopeDeclarationV957 = {
  envelopeId:string;
  driverDeclaredRappen:number;
  kioskCountedRappen?:number;
  kioskCounterUserId?:string;
};
export function assessEnvelopeV957(quote:CashShiftQuoteV957,d:EnvelopeDeclarationV957){
  if(!d.envelopeId?.trim())throw new Error("INVALID_ENVELOPE_ID");
  const declared=money(d.driverDeclaredRappen);
  const deltaDeclared=declared-quote.expectedEnvelopeRemainingRappen;
  if(d.kioskCountedRappen===undefined){
    return {status:"AWAITING_KIOSK_COUNT" as const,expectedRappen:quote.expectedEnvelopeRemainingRappen,
      declaredRappen:declared,declaredDifferenceRappen:deltaDeclared,
      countedRappen:null,countDifferenceRappen:null,acceptedRappen:0};
  }
  if(!d.kioskCounterUserId?.trim())throw new Error("COUNTER_ID_REQUIRED");
  const counted=money(d.kioskCountedRappen);
  return {status:counted===quote.expectedEnvelopeRemainingRappen?"MATCHED":"DISCREPANCY" as "MATCHED"|"DISCREPANCY",
    expectedRappen:quote.expectedEnvelopeRemainingRappen,declaredRappen:declared,
    declaredDifferenceRappen:deltaDeclared,countedRappen:counted,
    countDifferenceRappen:counted-quote.expectedEnvelopeRemainingRappen,
    acceptedRappen:counted};
}

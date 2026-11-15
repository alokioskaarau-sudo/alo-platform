// ALO NOW V842 – Schicht- und Finanzregeln.
// Pure validation. Keine DB-Buchung, keine Auszahlung.

import {
  calculateFinanceTotals,
  type FinanceEvent
} from "./aloNowDriverFinance.v841.js";

export type CashShiftSummary = {
  expectedRappen:number;
  countedRappen:number;
  differenceRappen:number;
  commissionRappen:number;
  tipsEarnedRappen:number;
  tipsPaidRappen:number;
  tipsOutstandingRappen:number;
};

function validMoney(n:number):boolean {
  return Number.isSafeInteger(n) && n>=0;
}

export function validateCashLedger(
  openingCashRappen:number,
  events:readonly FinanceEvent[]
):void {
  if(!validMoney(openingCashRappen)){
    throw new Error("INVALID_OPENING_CASH");
  }

  // Ein Anfangsbestand ist bereits in der Schicht gespeichert.
  // Er darf nicht zusätzlich als HANDOVER_IN gebucht werden.
  const keys=new Set<string>();
  let cash=openingCashRappen;
  let tipsEarned=0;
  let tipsPaid=0;

  for(const event of events){
    if(!event.eventKey || keys.has(event.eventKey)){
      throw new Error("DUPLICATE_FINANCE_EVENT");
    }
    keys.add(event.eventKey);

    const amount=event.amountRappen;
    if(!Number.isSafeInteger(amount) ||
       (event.type==="CASH_ADJUSTMENT"
         ? amount===0
         : amount<=0)){
      throw new Error("INVALID_FINANCE_AMOUNT");
    }

    switch(event.type){
      case "COMMISSION_EARNED":
        break;
      case "ONLINE_TIP_EARNED":
        tipsEarned+=amount;
        break;
      case "CASH_TIP_COLLECTED":
        cash+=amount;
        tipsEarned+=amount;
        break;
      case "CASH_ORDER_COLLECTED":
      case "CASH_HANDOVER_IN":
        cash+=amount;
        break;
      case "TIP_PAYOUT":
        tipsPaid+=amount;
        cash-=amount;
        if(tipsPaid>tipsEarned){
          throw new Error("TIP_PAYOUT_EXCEEDS_ENTITLEMENT");
        }
        break;
      case "CASH_HANDOVER_OUT":
        cash-=amount;
        break;
      case "CASH_ADJUSTMENT":
        cash+=amount;
        break;
      default:
        throw new Error("UNKNOWN_FINANCE_EVENT");
    }

    if(!Number.isSafeInteger(cash) ||
       !Number.isSafeInteger(tipsEarned) ||
       !Number.isSafeInteger(tipsPaid)){
      throw new Error("FINANCE_AMOUNT_OVERFLOW");
    }

    if(cash<0){
      throw new Error("INSUFFICIENT_CASH");
    }
  }

  // Abgleich mit der bestehenden V841-Funktion.
  calculateFinanceTotals(events);
}

export function calculateCashShiftSummary(
  openingCashRappen:number,
  events:readonly FinanceEvent[],
  countedCashRappen:number
):CashShiftSummary {
  if(!validMoney(countedCashRappen)){
    throw new Error("INVALID_COUNTED_CASH");
  }

  validateCashLedger(openingCashRappen,events);

  const totals=calculateFinanceTotals(events);
  const expectedRappen=
    openingCashRappen+totals.cashMovementRappen;

  if(!validMoney(expectedRappen)){
    throw new Error("INVALID_EXPECTED_CASH");
  }

  return {
    expectedRappen,
    countedRappen:countedCashRappen,
    differenceRappen:countedCashRappen-expectedRappen,
    commissionRappen:totals.commissionEarnedRappen,
    tipsEarnedRappen:totals.tipsEarnedRappen,
    tipsPaidRappen:totals.tipsPaidRappen,
    tipsOutstandingRappen:totals.tipsOutstandingRappen
  };
}

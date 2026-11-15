// ALO NOW V841 – pure finance calculation, NOT production activation.
// All monetary amounts are integer Swiss rappen.

export type FinanceEventType =
  | "COMMISSION_EARNED"
  | "CASH_ORDER_COLLECTED"
  | "CASH_TIP_COLLECTED"
  | "ONLINE_TIP_EARNED"
  | "TIP_PAYOUT"
  | "CASH_HANDOVER_IN"
  | "CASH_HANDOVER_OUT"
  | "CASH_ADJUSTMENT";

export type FinanceEvent = {
  eventKey: string;
  type: FinanceEventType;
  amountRappen: number;
};

export type FinanceTotals = {
  cashMovementRappen: number;
  commissionEarnedRappen: number;
  tipsEarnedRappen: number;
  tipsPaidRappen: number;
  tipsOutstandingRappen: number;
};

function validInteger(value:number):boolean {
  return Number.isSafeInteger(value);
}

export function calculateCommissionRappen(
  distanceMetres:number,
  baseRappen:number,
  rappenPerKm:number,
  capRappen:number
):number {
  if (
    !Number.isFinite(distanceMetres) ||
    distanceMetres<=0 ||
    ![baseRappen,rappenPerKm,capRappen].every(
      v=>validInteger(v)&&v>=0
    ) ||
    capRappen<baseRappen
  ) {
    throw new Error("INVALID_COMMISSION_INPUT");
  }

  return Math.min(
    capRappen,
    Math.round(
      baseRappen +
      distanceMetres*rappenPerKm/1000
    )
  );
}

export function calculateFinanceTotals(
  events:readonly FinanceEvent[]
):FinanceTotals {
  let cash=0;
  let commission=0;
  let tips=0;
  let paid=0;
  const seen=new Set<string>();

  for(const event of events){
    if (
      !event.eventKey ||
      seen.has(event.eventKey) ||
      !validInteger(event.amountRappen) ||
      (event.type==="CASH_ADJUSTMENT"
        ? event.amountRappen===0
        : event.amountRappen<=0)
    ){
      throw new Error("INVALID_OR_DUPLICATE_FINANCE_EVENT");
    }

    seen.add(event.eventKey);
    const amount=event.amountRappen;

    switch(event.type){
      case "COMMISSION_EARNED":
        commission+=amount;
        break;
      case "CASH_ORDER_COLLECTED":
      case "CASH_HANDOVER_IN":
        cash+=amount;
        break;
      case "CASH_TIP_COLLECTED":
        cash+=amount;
        tips+=amount;
        break;
      case "ONLINE_TIP_EARNED":
        tips+=amount;
        break;
      case "TIP_PAYOUT":
        cash-=amount;
        paid+=amount;
        break;
      case "CASH_HANDOVER_OUT":
        cash-=amount;
        break;
      case "CASH_ADJUSTMENT":
        cash+=amount;
        break;
    }

    if (![cash,commission,tips,paid].every(validInteger)){
      throw new Error("FINANCE_AMOUNT_OVERFLOW");
    }
  }

  return {
    cashMovementRappen:cash,
    commissionEarnedRappen:commission,
    tipsEarnedRappen:tips,
    tipsPaidRappen:paid,
    tipsOutstandingRappen:tips-paid
  };
}

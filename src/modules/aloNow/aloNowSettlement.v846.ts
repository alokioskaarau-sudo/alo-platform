// ALO NOW V846 – Abrechnungsvorschau.
// Keine Buchung und keine Zahlungsfreigabe.
// Alle Werte sind ganze CHF-Rappen.

export type SettlementInput = {
  openingCashRappen:number;
  cashOrdersRappen:number;
  cashTipsRappen:number;
  onlineTipsRappen:number;
  commissionRappen:number;
  previouslyPaidRappen:number;
  previousCashHandoversRappen:number;
};

export type SettlementQuote = {
  totalEarnedRappen:number;
  outstandingRappen:number;
  cashAvailableRappen:number;
  maxRetentionRappen:number;
  proposedRetentionRappen:number;
  cashToHandOverRappen:number;
  stillToPayRappen:number;
};

function valid(n:number):boolean {
  return Number.isSafeInteger(n)&&n>=0;
}

export function quoteDriverSettlementV846(
  x:SettlementInput,
  requestedRetentionRappen:number
):SettlementQuote {
  const amounts=[
    x.openingCashRappen,
    x.cashOrdersRappen,
    x.cashTipsRappen,
    x.onlineTipsRappen,
    x.commissionRappen,
    x.previouslyPaidRappen,
    x.previousCashHandoversRappen,
    requestedRetentionRappen
  ];

  if(!amounts.every(valid))
    throw new Error("INVALID_SETTLEMENT_AMOUNT");

  const safe=(n:number)=>{
    if(!valid(n))throw new Error("SETTLEMENT_OVERFLOW");
    return n;
  };

  const totalEarnedRappen=safe(
    x.commissionRappen+
    x.cashTipsRappen+
    x.onlineTipsRappen
  );

  if(x.previouslyPaidRappen>totalEarnedRappen)
    throw new Error("PAYOUT_EXCEEDS_EARNINGS");

  const outstandingRappen=
    totalEarnedRappen-x.previouslyPaidRappen;

  const cashReceipts=safe(
    x.cashOrdersRappen+x.cashTipsRappen
  );

  const cashBeforeHandover=safe(
    x.openingCashRappen+cashReceipts
  );

  if(x.previousCashHandoversRappen>cashBeforeHandover)
    throw new Error("HANDOVER_EXCEEDS_CASH");

  const cashAvailableRappen=
    cashBeforeHandover-x.previousCashHandoversRappen;

  // Das Wechselgeld darf durch eine Verrechnung
  // nicht unter den urspruenglichen Anfangsbestand sinken.
  const retainableCash=safe(Math.max(
    0,cashAvailableRappen-x.openingCashRappen
  ));

  const maxRetentionRappen=Math.min(
    outstandingRappen,retainableCash
  );

  if(requestedRetentionRappen>maxRetentionRappen)
    throw new Error("RETENTION_EXCEEDS_ALLOWED");

  const proposedRetentionRappen=requestedRetentionRappen;

  return {
    totalEarnedRappen,
    outstandingRappen,
    cashAvailableRappen,
    maxRetentionRappen,
    proposedRetentionRappen,
    cashToHandOverRappen:
      cashAvailableRappen-proposedRetentionRappen,
    stillToPayRappen:
      outstandingRappen-proposedRetentionRappen
  };
}

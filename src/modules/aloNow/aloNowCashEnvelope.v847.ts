// ALO NOW V847 – pure cash collection and envelope calculations.
// CHF amounts exclusively in integer Rappen.
// No API write, no payment confirmation.

function money(n:number):void {
  if(!Number.isSafeInteger(n)||n<0)
    throw new Error("INVALID_MONEY_AMOUNT");
}

function safe(n:number):number {
  money(n);
  return n;
}

export function calculateCashChangeV847(
  dueRappen:number,
  receivedRappen:number
){
  money(dueRappen);
  money(receivedRappen);
  if(dueRappen===0)
    throw new Error("NOT_A_CASH_PAYMENT");
  if(receivedRappen<dueRappen)
    throw new Error("INSUFFICIENT_CUSTOMER_CASH");

  return {
    dueRappen,
    receivedRappen,
    changeRappen:safe(receivedRappen-dueRappen),
    // Only this amount belongs to the order cash revenue.
    collectedRappen:dueRappen
  };
}

export type EnvelopeInputV847={
  openingFloatRappen:number;
  cashOrdersRappen:number;
  cashTipsRappen:number;
  onlineTipsRappen:number;
  commissionRappen:number;
  alreadyPaidRappen:number;
  cashAlreadyHandedOverRappen:number;
  desiredRetentionRappen:number;
  countedCashRappen:number;
};

export function calculateEnvelopeV847(x:EnvelopeInputV847){
  for(const value of Object.values(x))money(value);

  const earned=safe(
    x.commissionRappen+
    x.cashTipsRappen+
    x.onlineTipsRappen
  );

  if(x.alreadyPaidRappen>earned)
    throw new Error("PAYOUT_EXCEEDS_EARNINGS");

  const outstanding=earned-x.alreadyPaidRappen;

  const cashBeforeTransfers=safe(
    x.openingFloatRappen+
    x.cashOrdersRappen+
    x.cashTipsRappen
  );

  if(x.cashAlreadyHandedOverRappen>cashBeforeTransfers)
    throw new Error("CASH_HANDOVER_EXCEEDS_BALANCE");

  const cashAvailable=
    cashBeforeTransfers-x.cashAlreadyHandedOverRappen;

  // Preserve the full configured change float.
  const aboveFloat=Math.max(
    0,cashAvailable-x.openingFloatRappen
  );

  const maximumRetention=Math.min(
    outstanding,aboveFloat
  );

  if(x.desiredRetentionRappen>maximumRetention)
    throw new Error("RETENTION_EXCEEDS_ALLOWED");

  const expectedAfterRetention=
    cashAvailable-x.desiredRetentionRappen;

  const expectedEnvelope=Math.max(
    0,expectedAfterRetention-x.openingFloatRappen
  );

  const actualEnvelope=Math.max(
    0,x.countedCashRappen-x.openingFloatRappen
  );

  return {
    earnedRappen:earned,
    outstandingBeforeRappen:outstanding,
    retainedRappen:x.desiredRetentionRappen,
    outstandingAfterRappen:
      outstanding-x.desiredRetentionRappen,
    floatToKeepRappen:x.openingFloatRappen,
    expectedCashAfterRetentionRappen:expectedAfterRetention,
    expectedEnvelopeRappen:expectedEnvelope,
    countedCashRappen:x.countedCashRappen,
    actualEnvelopeRappen:actualEnvelope,
    differenceRappen:
      x.countedCashRappen-expectedAfterRetention
  };
}

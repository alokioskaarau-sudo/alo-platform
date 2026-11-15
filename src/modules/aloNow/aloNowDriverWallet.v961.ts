/** ALO NOW V961 — deterministic driver wallet projection (no I/O).
 * Source records must already be verified, fulfilled and attributed server-side.
 * Card tips are payable; optional cash tips are retained directly and must NOT
 * create a second payable claim. All amounts are integer CHF rappen.
 */
export type VerifiedDriverReceiptV961 = {
  orderId: string;
  payment: 'CASH' | 'CARD';
  orderRappen: number;
  commissionRappen: number;
  cardTipRappen: number;
  /** Optional, solely if a cash tip was explicitly reported; 0 otherwise. */
  reportedCashTipRappen?: number;
};

export type DriverWalletInputV961 = {
  receipts: readonly VerifiedDriverReceiptV961[];
  openingFloatRappen: number;
  confirmedEnvelopeRappen: number;
  confirmedPayoutRappen: number;
};

export type DriverWalletQuoteV961 = {
  cashOrdersRappen: number;
  earnedCashCommissionRappen: number;
  cashCommissionRetainedRappen: number;
  cashCommissionCarryoverRappen: number;
  earnedCardCommissionRappen: number;
  cardTipsRappen: number;
  reportedCashTipsRetainedRappen: number;
  payableEarnedRappen: number;
  confirmedPayoutRappen: number;
  payableOutstandingRappen: number;
  envelopeExpectedTotalRappen: number;
  envelopeConfirmedRappen: number;
  envelopeRemainingRappen: number;
  openingFloatToReturnRappen: number;
  cashInCustodyExpectedRappen: number;
};

function amount(n: number): number {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('V961_INVALID_RAPPEN');
  return n;
}
function plus(a: number, b: number): number { return amount(a + b); }

export function quoteDriverWalletV961(input: DriverWalletInputV961): DriverWalletQuoteV961 {
  const opening = amount(input.openingFloatRappen);
  const confirmed = amount(input.confirmedEnvelopeRappen);
  const paid = amount(input.confirmedPayoutRappen);
  const seen = new Set<string>();
  let cashOrders = 0, cashCommission = 0, cardCommission = 0, cardTips = 0, cashTips = 0;
  for (const r of input.receipts) {
    if (typeof r.orderId !== 'string' || !r.orderId.trim() || seen.has(r.orderId))
      throw new Error('V961_DUPLICATE_OR_INVALID_ORDER');
    seen.add(r.orderId);
    amount(r.orderRappen); amount(r.commissionRappen);
    amount(r.cardTipRappen);
    const reportedCashTip = amount(r.reportedCashTipRappen ?? 0);
    if (r.payment === 'CASH') {
      if (r.cardTipRappen !== 0) throw new Error('V961_CASH_WITH_CARD_TIP');
      cashOrders = plus(cashOrders, r.orderRappen);
      cashCommission = plus(cashCommission, r.commissionRappen);
      cashTips = plus(cashTips, reportedCashTip);
    } else if (r.payment === 'CARD') {
      if (reportedCashTip !== 0) throw new Error('V961_CARD_WITH_REPORTED_CASH_TIP');
      cardCommission = plus(cardCommission, r.commissionRappen);
      cardTips = plus(cardTips, r.cardTipRappen);
    } else throw new Error('V961_UNKNOWN_PAYMENT');
  }
  // Cash commission can only be retained against cash sales, NEVER against float.
  const retained = Math.min(cashOrders, cashCommission);
  const carryover = cashCommission - retained;
  const payable = plus(plus(cardCommission, cardTips), carryover);
  const envelopeTotal = cashOrders - retained;
  if (confirmed > envelopeTotal) throw new Error('V961_ENVELOPES_EXCEED_EXPECTED');
  if (paid > payable) throw new Error('V961_PAYOUT_EXCEEDS_PAYABLE');
  const remaining = envelopeTotal - confirmed;
  return {
    cashOrdersRappen: cashOrders,
    earnedCashCommissionRappen: cashCommission,
    cashCommissionRetainedRappen: retained,
    cashCommissionCarryoverRappen: carryover,
    earnedCardCommissionRappen: cardCommission,
    cardTipsRappen: cardTips,
    reportedCashTipsRetainedRappen: cashTips,
    payableEarnedRappen: payable,
    confirmedPayoutRappen: paid,
    payableOutstandingRappen: payable - paid,
    envelopeExpectedTotalRappen: envelopeTotal,
    envelopeConfirmedRappen: confirmed,
    envelopeRemainingRappen: remaining,
    openingFloatToReturnRappen: opening,
    cashInCustodyExpectedRappen: plus(opening, remaining),
  };
}

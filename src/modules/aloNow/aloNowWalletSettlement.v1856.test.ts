import test from "node:test";
import assert from "node:assert/strict";

import {
  quoteDriverWalletV961
} from "./aloNowDriverWallet.v961.js";

const cash = {
  orderId: "cash-order-1856",
  payment: "CASH" as const,
  orderRappen: 12000,
  commissionRappen: 450,
  cardTipRappen: 0,
  reportedCashTipRappen: 0
};

const card = {
  orderId: "card-order-1856",
  payment: "CARD" as const,
  orderRappen: 5000,
  commissionRappen: 600,
  cardTipRappen: 300,
  reportedCashTipRappen: 0
};

function quote(
  receipts: Array<typeof cash | typeof card>,
  confirmedPayoutRappen = 0,
  openingFloatRappen = 0
) {
  return quoteDriverWalletV961({
    receipts,
    openingFloatRappen,
    confirmedEnvelopeRappen: 0,
    confirmedPayoutRappen
  });
}

test("Cash commission is retained from cash sales", () => {
  const result = quote([cash]);

  assert.equal(result.cashOrdersRappen, 12000);
  assert.equal(result.earnedCashCommissionRappen, 450);
  assert.equal(result.cashCommissionRetainedRappen, 450);
  assert.equal(result.cashCommissionCarryoverRappen, 0);

  const handover = (
    result.cashOrdersRappen -
    result.cashCommissionRetainedRappen
  );

  assert.equal(handover, 11550);
});

test("Card commission and tips remain separate", () => {
  const result = quote([cash, card]);

  assert.equal(result.earnedCardCommissionRappen, 600);
  assert.equal(result.cardTipsRappen, 300);
  assert.equal(result.cashCommissionRetainedRappen, 450);

  const onlineEarnings = (
    result.earnedCardCommissionRappen +
    result.cardTipsRappen
  );

  assert.equal(onlineEarnings, 900);
});

test("Confirmed payouts reduce outstanding card earnings", () => {
  const result = quote([card], 200);

  assert.equal(result.earnedCardCommissionRappen, 600);
  assert.equal(result.cardTipsRappen, 300);
  assert.equal(result.confirmedPayoutRappen, 200);

  const outstanding = (
    result.earnedCardCommissionRappen +
    result.cardTipsRappen -
    result.confirmedPayoutRappen
  );

  assert.equal(outstanding, 700);
});

test("Opening float cannot fund retained commission", () => {
  const result = quote([{
    ...cash,
    orderRappen: 100,
    commissionRappen: 300
  }], 0, 10000);

  assert.equal(result.cashCommissionRetainedRappen, 100);
  assert.equal(result.cashCommissionCarryoverRappen, 200);
});

test("Duplicate order receipts are rejected", () => {
  assert.throws(
    () => quote([cash, cash]),
    /DUPLICATE|ORDER|V961/i
  );
});

test("Invalid negative commission is rejected", () => {
  assert.throws(
    () => quote([{
      ...card,
      commissionRappen: -100
    }])
  );
});

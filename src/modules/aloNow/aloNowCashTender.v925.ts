// ALO NOW V925: pure cash tender contract. No DB access, no payment confirmation.
// Every monetary value is an integer number of CHF rappen.
import { calculateCashChangeV847 } from "./aloNowCashEnvelope.v847.js";

export type CashTenderV925 = {
  dueRappen: number;
  receivedRappen: number;
  explicitCashTipRappen: number;
};

export type CashTenderQuoteV925 = {
  dueRappen: number;
  receivedRappen: number;
  changeRappen: number;
  cashOrderRevenueRappen: number;
  cashTipRappen: number;
  driverCashIntakeRappen: number;
  cashTipRetainedByDriver: false;
  paymentRecorded: false;
};

const valid = (n:number) => Number.isSafeInteger(n) && n >= 0;

export function quoteCashTenderV925(input: CashTenderV925): CashTenderQuoteV925 {
  const {dueRappen, receivedRappen, explicitCashTipRappen} = input;
  if (![dueRappen, receivedRappen, explicitCashTipRappen].every(valid))
    throw new Error("INVALID_CASH_TENDER_AMOUNT");
  if (dueRappen === 0) throw new Error("NO_CASH_DUE");
  const required = dueRappen + explicitCashTipRappen;
  if (!Number.isSafeInteger(required)) throw new Error("CASH_TENDER_OVERFLOW");
  if (receivedRappen < required) throw new Error("INSUFFICIENT_CUSTOMER_CASH");

  // Reuse V847's order cash calculation; explicit tip is NOT part of order turnover.
  const order = calculateCashChangeV847(dueRappen, receivedRappen);
  const changeRappen = order.changeRappen - explicitCashTipRappen;
  const driverCashIntakeRappen = dueRappen + explicitCashTipRappen;
  if (!valid(changeRappen) || !valid(driverCashIntakeRappen))
    throw new Error("CASH_TENDER_OVERFLOW");

  return {
    dueRappen, receivedRappen, changeRappen,
    cashOrderRevenueRappen: dueRappen,
    cashTipRappen: explicitCashTipRappen,
    driverCashIntakeRappen,
    cashTipRetainedByDriver: false,
    paymentRecorded: false,
  };
}

// UI helper: accepts CHF values with at most two decimals; no floats for money.
export function parseChfToRappenV925(input:string):number {
  const normalized=input.trim().replace(",", ".");
  if (!/^(0|[1-9][0-9]{0,8})(?:\.[0-9]{1,2})?$/.test(normalized))
    throw new Error("INVALID_CHF_INPUT");
  const [francs, cents=""] = normalized.split(".");
  const amount=Number(francs)*100 + Number(cents.padEnd(2,"0"));
  if (!valid(amount)) throw new Error("INVALID_CHF_INPUT");
  return amount;
}

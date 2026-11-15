import {
  checkCashCollectionV927,
  type CashGateInputV927
} from "./aloNowCashCollectionGate.v927.js";

export type CashBookingPlanV928 = {
  orderId: string;
  orderCashRappen: number;
  cashTipRappen: number;
  receivedRappen: number;
  changeRappen: number;
  eventKeys: {
    order: string;
    tip: string | null;
  };
};

/**
 * Creates a proposed booking only.
 * No database writes, no Shopify calls.
 *
 * The trusted caller must populate gate fields from
 * locked server-side database records.
 */
export function planCashBookingV928(
  gate: CashGateInputV927,
  receivedRappen: number,
  tipRappen: number
): CashBookingPlanV928 {
  const decision = checkCashCollectionV927(gate);

  if (!decision.allowed)
    throw new Error(decision.reason);

  if (!Number.isSafeInteger(receivedRappen) ||
      !Number.isSafeInteger(tipRappen) ||
      tipRappen < 0)
    throw new Error("INVALID_CASH_TENDER");

  const minimum = decision.dueRappen + tipRappen;

  if (!Number.isSafeInteger(minimum) ||
      receivedRappen < minimum)
    throw new Error("INSUFFICIENT_CUSTOMER_CASH");

  const orderId = gate.orderId;

  return {
    orderId,
    orderCashRappen: decision.dueRappen,
    cashTipRappen: tipRappen,
    receivedRappen,
    changeRappen: receivedRappen - minimum,
    eventKeys: {
      order: "ALO-CASH-ORDER:" + orderId,
      tip: tipRappen > 0
        ? "ALO-CASH-TIP:" + orderId
        : null
    }
  };
}

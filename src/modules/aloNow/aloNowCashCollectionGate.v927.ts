// ALO NOW V927 - Cash collection eligibility.
// Pure validation. No database writes or payment confirmation.

export type CashGateInputV927 = {
  orderId: string;
  driverId: string;
  assignedDriverId: string | null;
  shiftDriverId: string | null;
  shiftStatus: "OPEN" | "CLOSED" | null;
  deliveryStatus: string;
  paymentMethod: "CASH" | "ONLINE" | null;
  paymentPhase: string;
  alreadyCollected: boolean;
  dueRappen: number;
};

export type CashGateResultV927 =
  | { allowed: true; dueRappen: number }
  | { allowed: false; reason: string };

export function checkCashCollectionV927(
  x: CashGateInputV927
): CashGateResultV927 {
  const reject = (reason: string): CashGateResultV927 =>
    ({ allowed: false, reason });

  if (!x.orderId.trim() || !x.driverId.trim())
    return reject("INVALID_CASH_CONTEXT");

  if (!x.assignedDriverId ||
      x.assignedDriverId !== x.driverId)
    return reject("DELIVERY_NOT_ASSIGNED_TO_DRIVER");

  if (x.shiftDriverId !== x.driverId ||
      x.shiftStatus !== "OPEN")
    return reject("OPEN_CASH_SHIFT_REQUIRED");

  if (!["PICKED_UP", "ON_THE_WAY"].includes(
    x.deliveryStatus
  ))
    return reject("DELIVERY_NOT_READY_FOR_COLLECTION");

  if (x.paymentMethod !== "CASH" ||
      x.paymentPhase !== "CASH_CONFIRMED")
    return reject("CASH_AGREEMENT_NOT_VERIFIED");

  if (x.alreadyCollected)
    return reject("CASH_ALREADY_COLLECTED");

  if (!Number.isSafeInteger(x.dueRappen) ||
      x.dueRappen <= 0)
    return reject("INVALID_VERIFIED_CASH_TOTAL");

  return { allowed: true, dueRappen: x.dueRappen };
}

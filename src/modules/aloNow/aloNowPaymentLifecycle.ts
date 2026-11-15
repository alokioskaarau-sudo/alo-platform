
/**
 * ALO NOW Payment Lifecycle V1.
 *
 * Deterministic state machine. No I/O or DB writes.
 * The caller must authenticate and authorize every event,
 * verify the order identity, and persist changes atomically.
 */

export type PaymentPhase =
  | "AWAITING_DRIVER"
  | "DRIVER_ACCEPTED"
  | "AWAITING_PAYMENT"
  | "PAYMENT_CONFIRMED"
  | "CASH_CONFIRMED"
  | "EXPIRED"
  | "CANCELLED";

export type PaymentMethod = "ONLINE" | "CASH" | null;

export type PaymentLifecycle = {
  phase: PaymentPhase;
  method: PaymentMethod;
};

export type PaymentEvent =
  | { type: "DRIVER_ACCEPTED" }
  | { type: "ONLINE_PAYMENT_REQUESTED" }
  | { type: "MERCHANT_PAYMENT_AUTHORIZED" }
  | { type: "ONLINE_PAYMENT_VERIFIED" }
  | { type: "CASH_AGREEMENT_VERIFIED" }
  | { type: "RESERVATION_EXPIRED" }
  | { type: "CANCELLED" };

export type PaymentTransition =
  | { ok: true; state: PaymentLifecycle }
  | { ok: false; reason: string };

export function transitionAloNowPayment(
  current: PaymentLifecycle,
  event: PaymentEvent
): PaymentTransition {
  const reject = (reason: string): PaymentTransition =>
    ({ ok: false, reason });

  const next = (
    phase: PaymentPhase,
    method: PaymentMethod
  ): PaymentTransition => ({
    ok: true,
    state: { phase, method },
  });

  if (
    current.phase === "CANCELLED" ||
    current.phase === "EXPIRED"
  ) {
    return reject("TERMINAL_STATE");
  }

  switch (event.type) {
    case "DRIVER_ACCEPTED":
      return current.phase === "AWAITING_DRIVER"
        ? next("DRIVER_ACCEPTED", null)
        : reject("INVALID_DRIVER_ACCEPTANCE");

    case "ONLINE_PAYMENT_REQUESTED":
      return current.phase === "DRIVER_ACCEPTED"
        ? next("AWAITING_PAYMENT", "ONLINE")
        : reject("DRIVER_ACCEPTANCE_REQUIRED");

    // ALO_V336_MERCHANT_PAYMENT
    // Authorization is validated and audited by the DB service.
    case "MERCHANT_PAYMENT_AUTHORIZED":
      return current.phase === "AWAITING_DRIVER" &&
        current.method === null
        ? next("AWAITING_PAYMENT", "ONLINE")
        : reject("INVALID_MERCHANT_PAYMENT_TRANSITION");

    case "ONLINE_PAYMENT_VERIFIED":
      return current.phase === "AWAITING_PAYMENT" &&
        current.method === "ONLINE"
        ? next("PAYMENT_CONFIRMED", "ONLINE")
        : reject("PAYMENT_REQUEST_REQUIRED");

    case "CASH_AGREEMENT_VERIFIED":
      return current.phase === "DRIVER_ACCEPTED"
        ? next("CASH_CONFIRMED", "CASH")
        : reject("INVALID_CASH_AGREEMENT");

    case "RESERVATION_EXPIRED":
      return current.phase === "AWAITING_DRIVER" ||
        current.phase === "DRIVER_ACCEPTED" ||
        current.phase === "AWAITING_PAYMENT"
        ? next("EXPIRED", current.method)
        : reject("CONFIRMED_PAYMENT_REQUIRES_RECONCILIATION");

    case "CANCELLED":
      return current.phase === "PAYMENT_CONFIRMED" ||
        current.phase === "CASH_CONFIRMED"
        ? reject("CONFIRMED_PAYMENT_REQUIRES_RECONCILIATION")
        : next("CANCELLED", current.method);
  }
}

export function isAloNowPaymentReady(
  state: PaymentLifecycle
): boolean {
  return (
    state.phase === "PAYMENT_CONFIRMED" &&
    state.method === "ONLINE"
  ) || (
    state.phase === "CASH_CONFIRMED" &&
    state.method === "CASH"
  );
}

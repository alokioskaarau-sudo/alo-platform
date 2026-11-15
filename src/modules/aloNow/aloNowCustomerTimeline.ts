// ALO NOW V156 - customer-facing order request timeline.
// Read-only projection. No payment, packing or GPS claims
// without authoritative events from the corresponding systems.

export type CustomerTimelineStep =
  | "REQUESTED"
  | "ACCEPTED"
  | "PACKING"
  | "ON_THE_WAY"
  | "DELIVERED";

export type CustomerTimelineState =
  "complete" | "active" | "pending";

const STEPS: CustomerTimelineStep[] = [
  "REQUESTED",
  "ACCEPTED",
  "PACKING",
  "ON_THE_WAY",
  "DELIVERED"
];

export function buildAloNowCustomerTimeline(
  status: string,
  createdAt: Date,
  serverTime: Date = new Date(),
  paymentPhase: string | null = null
) {
  const validCreatedAt =
    createdAt instanceof Date &&
    Number.isFinite(createdAt.getTime());

  const waitingForReview =
    status === "PENDING_REVIEW" ||
    status === "CONTACTED";

  const reviewTargetAt = validCreatedAt && waitingForReview
    ? new Date(createdAt.getTime() + 10 * 60 * 1000)
    : null;

  const reviewSecondsRemaining = reviewTargetAt
    ? Math.max(
        0,
        Math.ceil(
          (reviewTargetAt.getTime() - serverTime.getTime()) / 1000
        )
      )
    : null;

  const messages: Record<string, string> = {
    PENDING_REVIEW: "Wir prüfen deine Lieferanfrage.",
    CONTACTED: "Wir klären deine Lieferung.",
    DRIVER_ACCEPTED:
      "Ein Fahrer hat zugesagt. Eine Zahlung ist damit noch nicht bestätigt.",
    REJECTED: "Deine Lieferanfrage wurde abgelehnt.",
    CANCELLED: "Deine Lieferanfrage wurde storniert.",
    EXPIRED: "Deine Lieferanfrage ist abgelaufen."
  };

  const isClosed = [
    "REJECTED",
    "CANCELLED",
    "EXPIRED"
  ].includes(status);

  return {
    status,
    message:
      messages[status] ??
      "Der aktuelle Auftragsstatus wird geprüft.",
    terminal: isClosed,
    serverTime: serverTime.toISOString(),
    review: {
      targetAt: reviewTargetAt?.toISOString() ?? null,
      secondsRemaining: reviewSecondsRemaining,
      kind: "INFORMATIONAL_TARGET_ONLY",
      automaticallyExpires: false
    },
    steps: STEPS.map((step, index) => ({
      step,
      state: (
        index === 0
          ? "complete"
          : "pending"
      ) as CustomerTimelineState
    })),
    driverReserved: status === "DRIVER_ACCEPTED",
    paymentConfirmed:
      paymentPhase === "PAYMENT_CONFIRMED" ||
      paymentPhase === "CASH_CONFIRMED",
    paymentPhase,
    packingConfirmed: false,
    driverEnRouteConfirmed: false,
    deliveredConfirmed: false,
    gpsAvailable: false,
    tipCheckoutAvailable: false
  };
}

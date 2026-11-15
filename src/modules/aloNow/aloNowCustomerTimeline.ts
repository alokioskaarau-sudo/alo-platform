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
  paymentPhase: string | null = null,
  fulfillment: {
    packStatus?: string | null;
    deliveryStatus?: string | null;
  } = {}
) {
  const validCreatedAt =
    createdAt instanceof Date &&
    Number.isFinite(createdAt.getTime());

  const paymentConfirmed =
    paymentPhase === "PAYMENT_CONFIRMED" ||
    paymentPhase === "CASH_CONFIRMED";

  const packStatus = fulfillment.packStatus ?? null;
  const deliveryStatus = fulfillment.deliveryStatus ?? null;

  const packingStarted =
    paymentConfirmed &&
    ["PACKING", "IN_PROGRESS", "PACKED", "COMPLETED"]
      .includes(packStatus ?? "");

  const packingConfirmed =
    paymentConfirmed &&
    ["PACKED", "COMPLETED"].includes(packStatus ?? "");

  const driverEnRouteConfirmed =
    paymentConfirmed &&
    ["PICKED_UP", "ON_THE_WAY", "DELIVERED"]
      .includes(deliveryStatus ?? "");

  const deliveredConfirmed =
    paymentConfirmed &&
    deliveryStatus === "DELIVERED";

  const highestStage =
    deliveredConfirmed ? 4 :
    driverEnRouteConfirmed ? 3 :
    packingStarted ? 2 :
    paymentConfirmed ? 1 : 0;

  const waitingForReview =
    status === "PENDING_REVIEW" ||
    status === "CONTACTED";

  const reviewTargetAt = validCreatedAt && waitingForReview && !paymentConfirmed
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
      deliveredConfirmed
        ? "Deine Bestellung wurde zugestellt."
        : driverEnRouteConfirmed
        ? "Dein Fahrer ist unterwegs."
        : packingConfirmed
        ? "Deine Bestellung ist gepackt und wartet auf die Abfahrt."
        : packingStarted
        ? "Wir packen deine Bestellung."
        : paymentConfirmed
        ? "Deine Zahlung ist bestätigt."
        : messages[status] ??
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
        index < highestStage
          ? "complete"
          : index === highestStage
          ? "active"
          : "pending"
      ) as CustomerTimelineState
    })),
    driverReserved: status === "DRIVER_ACCEPTED",
    paymentConfirmed,
    paymentPhase,
    packingStarted,
    packingConfirmed,
    driverEnRouteConfirmed,
    deliveredConfirmed,
    packStatus: paymentConfirmed ? packStatus : null,
    deliveryStatus: paymentConfirmed ? deliveryStatus : null,
    gpsAvailable: false,
    tipCheckoutAvailable: false
  };
}

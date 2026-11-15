// ALO_V1566_HANDOFF_STATE
// Pure state validation. No DB or Shopify writes.

export type AloHandoffStateV1566 =
  | "PENDING"
  | "PREPARED"
  | "FULL_HANDOFF"
  | "PARTIAL_HANDOFF"
  | "RETURN_CONFIRMED";

export type AloSettlementStateV1566 =
  | "NOT_STARTED"
  | "REVIEW_REQUIRED"
  | "APPROVED"
  | "PROCESSING"
  | "COMPLETED"
  | "FAILED";

const transitions: Record<
  AloHandoffStateV1566,
  readonly AloHandoffStateV1566[]
> = {
  PENDING: ["PREPARED"],
  PREPARED: ["FULL_HANDOFF", "PARTIAL_HANDOFF"],
  FULL_HANDOFF: [],
  PARTIAL_HANDOFF: ["RETURN_CONFIRMED"],
  RETURN_CONFIRMED: [],
};

export function assertAloHandoffTransitionV1566(
  current: AloHandoffStateV1566,
  next: AloHandoffStateV1566
): void {
  if (!Object.prototype.hasOwnProperty.call(transitions, current) ||
      !Object.prototype.hasOwnProperty.call(transitions, next)) {
    throw new Error("UNKNOWN_HANDOFF_STATE");
  }

  if (!transitions[current].includes(next)) {
    throw new Error("INVALID_HANDOFF_TRANSITION");
  }
}

export function assertAloSettlementReadyV1566(input: {
  handoffState: AloHandoffStateV1566;
  settlementState: AloSettlementStateV1566;
  refundAmountRappen: number;
  returnRequired: boolean;
}): void {
  // ALO_V1567_APPROVAL_ONLY
  // Reviewing a refund is NOT authorization to execute it.
  const allowedStates: AloSettlementStateV1566[] = [
    "APPROVED",
  ];

  if (!Number.isSafeInteger(input.refundAmountRappen) ||
      input.refundAmountRappen < 0) {
    throw new Error("INVALID_REFUND_AMOUNT");
  }

  if (!allowedStates.includes(input.settlementState)) {
    throw new Error("SETTLEMENT_NOT_REVIEWED");
  }

  if (input.returnRequired &&
      input.handoffState !== "RETURN_CONFIRMED") {
    throw new Error("RETURN_NOT_CONFIRMED");
  }

  if (!input.returnRequired &&
      input.handoffState !== "FULL_HANDOFF") {
    throw new Error("HANDOFF_NOT_COMPLETE");
  }
}

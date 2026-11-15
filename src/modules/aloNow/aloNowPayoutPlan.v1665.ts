
import type {
  DriverWalletQuoteV961
} from "./aloNowDriverWallet.v961.js";

export type PayoutWorkspaceV1665 = "AARAU" | "OLTEN";

export type PayoutContextV1665 = {
  adminUserId: string;
  adminActive: boolean;
  adminApproved: boolean;
  adminRole: "ADMIN" | "MANAGER" | "DRIVER";
  allowedWorkspaces: readonly PayoutWorkspaceV1665[];
  workspace: PayoutWorkspaceV1665;
  driverUserId: string;
  driverWorkspace: PayoutWorkspaceV1665;
  payoutShiftId: string;
  payoutShiftWorkspace: PayoutWorkspaceV1665;
  payoutShiftOpen: boolean;
  availableCashRappen: number;
  verifiedSources: boolean;
  reconciliationComplete: boolean;
  priorPaidCardCommissionRappen: number;
  priorPaidCardTipsRappen: number;
  priorPaidCashCarryoverRappen: number;
  existingPayoutKeys: readonly string[];
};

export type PayoutRequestV1665 = {
  amountRappen: number;
  payoutKey: string;
};

const valid = (n: number) =>
  Number.isSafeInteger(n) && n >= 0;

export function planAdminPayoutV1665(
  wallet: DriverWalletQuoteV961,
  ctx: PayoutContextV1665,
  request: PayoutRequestV1665
) {
  if (
    ctx.adminRole !== "ADMIN" ||
    !ctx.adminActive ||
    !ctx.adminApproved ||
    !ctx.adminUserId?.trim() ||
    !ctx.driverUserId?.trim() ||
    ctx.adminUserId === ctx.driverUserId
  ) {
    throw Error("PAYOUT_ADMIN_REQUIRED");
  }

  if (
    !ctx.allowedWorkspaces.includes(ctx.workspace) ||
    ctx.workspace !== ctx.driverWorkspace ||
    ctx.workspace !== ctx.payoutShiftWorkspace
  ) {
    throw Error("PAYOUT_WORKSPACE_MISMATCH");
  }

  if (!ctx.payoutShiftId?.trim() || !ctx.payoutShiftOpen) {
    throw Error("PAYOUT_SHIFT_NOT_OPEN");
  }

  if (
    ctx.verifiedSources !== true ||
    ctx.reconciliationComplete !== true
  ) {
    throw Error("PAYOUT_EVIDENCE_NOT_VERIFIED");
  }

  const key = request.payoutKey;

  if (
    typeof key !== "string" ||
    !/^[A-Za-z0-9_-]{8,100}$/.test(key)
  ) {
    throw Error("INVALID_PAYOUT_KEY");
  }

  if (ctx.existingPayoutKeys.includes(key)) {
    throw Error("DUPLICATE_PAYOUT_KEY");
  }

  const money = [
    ctx.availableCashRappen,
    ctx.priorPaidCardCommissionRappen,
    ctx.priorPaidCardTipsRappen,
    ctx.priorPaidCashCarryoverRappen,
    wallet.earnedCardCommissionRappen,
    wallet.cardTipsRappen,
    wallet.cashCommissionCarryoverRappen,
    wallet.confirmedPayoutRappen,
    wallet.payableOutstandingRappen,
    wallet.payableEarnedRappen,
    request.amountRappen
  ];

  if (!money.every(valid)) {
    throw Error("INVALID_PAYOUT_AMOUNT");
  }

  if (request.amountRappen === 0) {
    throw Error("ZERO_PAYOUT_FORBIDDEN");
  }

  const previous =
    ctx.priorPaidCardCommissionRappen +
    ctx.priorPaidCardTipsRappen +
    ctx.priorPaidCashCarryoverRappen;

  if (
    !Number.isSafeInteger(previous) ||
    previous !== wallet.confirmedPayoutRappen
  ) {
    throw Error("PAYOUT_HISTORY_MISMATCH");
  }

  const remainingCommission =
    wallet.earnedCardCommissionRappen -
    ctx.priorPaidCardCommissionRappen;

  const remainingTips =
    wallet.cardTipsRappen -
    ctx.priorPaidCardTipsRappen;

  const remainingCarryover =
    wallet.cashCommissionCarryoverRappen -
    ctx.priorPaidCashCarryoverRappen;

  if (
    ![
      remainingCommission,
      remainingTips,
      remainingCarryover
    ].every(valid) ||
    remainingCommission +
      remainingTips +
      remainingCarryover !== wallet.payableOutstandingRappen
  ) {
    throw Error("PAYOUT_LEDGER_MISMATCH");
  }

  if (request.amountRappen > wallet.payableOutstandingRappen) {
    throw Error("PAYOUT_EXCEEDS_BALANCE");
  }

  if (request.amountRappen > ctx.availableCashRappen) {
    throw Error("PAYOUT_CASH_INSUFFICIENT");
  }

  const cardTipRappen = Math.min(
    request.amountRappen,
    remainingTips
  );

  const cardCommissionRappen = Math.min(
    request.amountRappen - cardTipRappen,
    remainingCommission
  );

  const cashCarryoverRappen =
    request.amountRappen -
    cardTipRappen -
    cardCommissionRappen;

  if (
    !valid(cashCarryoverRappen) ||
    cashCarryoverRappen > remainingCarryover
  ) {
    throw Error("PAYOUT_ALLOCATION_INVALID");
  }

  return {
    status: "PLAN_ONLY_NOT_BOOKED" as const,
    payoutKey: key,
    driverUserId: ctx.driverUserId,
    adminUserId: ctx.adminUserId,
    workspace: ctx.workspace,
    payoutShiftId: ctx.payoutShiftId,
    amountRappen: request.amountRappen,
    cardTipRappen,
    cardCommissionRappen,
    cashCarryoverRappen,
    balanceAfterRappen:
      wallet.payableOutstandingRappen -
      request.amountRappen
  };
}

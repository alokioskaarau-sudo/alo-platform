
import {planAdminPayoutV1665} from "./aloNowPayoutPlan.v1665.js";
import type {
  PayoutContextV1665,
  PayoutRequestV1665
} from "./aloNowPayoutPlan.v1665.js";
import type {
  DriverWalletQuoteV961
} from "./aloNowDriverWallet.v961.js";

export type VerifiedPayoutStateV1666 = {
  wallet: DriverWalletQuoteV961;
  context: PayoutContextV1665;
};

export type PayoutReceiptV1666 = {
  payoutKey: string;
  driverUserId: string;
  adminUserId: string;
  payoutShiftId: string;
  amountRappen: number;
  cardTipRappen: number;
  cardCommissionRappen: number;
  cashCarryoverRappen: number;
  balanceAfterRappen: number;
};

export type PayoutTxV1666 = {
  // Must read authoritative records using THIS locked transaction.
  loadVerifiedState(): Promise<VerifiedPayoutStateV1666>;

  findReceipt(key: string): Promise<PayoutReceiptV1666 | null>;

  // Must atomically persist payout and cash debit.
  // Must NOT execute any external money transfer.
  savePayout(receipt: PayoutReceiptV1666): Promise<void>;
};

export type PayoutStoreV1666 = {
  // Implementations MUST lock the driver, serialize all
  // competing payouts, commit on success, rollback on error.
  withLockedDriver<T>(
    driverUserId: string,
    callback: (tx: PayoutTxV1666) => Promise<T>
  ): Promise<T>;
};

export type PayoutCommandV1666 = PayoutRequestV1665 & {
  driverUserId: string;
  adminUserId: string;
};

function validKey(key: string): boolean {
  return typeof key === "string" &&
    /^[A-Za-z0-9_-]{8,100}$/.test(key);
}

export async function executePayoutV1666(
  command: PayoutCommandV1666,
  store: PayoutStoreV1666
): Promise<{status:"BOOKED"|"ALREADY_BOOKED";receipt:PayoutReceiptV1666}> {
  if (
    !command ||
    !validKey(command.payoutKey) ||
    typeof command.driverUserId !== "string" ||
    !command.driverUserId.trim() ||
    typeof command.adminUserId !== "string" ||
    !command.adminUserId.trim() ||
    !Number.isSafeInteger(command.amountRappen) ||
    command.amountRappen <= 0
  ) {
    throw Error("INVALID_PAYOUT_COMMAND");
  }

  if (typeof store?.withLockedDriver !== "function") {
    throw Error("INVALID_PAYOUT_STORE");
  }

  return store.withLockedDriver(command.driverUserId, async tx => {
    const state = await tx.loadVerifiedState();
    const ctx = state.context;

    // Caller IDs cannot override authoritative transaction data.
    if (
      ctx.driverUserId !== command.driverUserId ||
      ctx.adminUserId !== command.adminUserId ||
      ctx.adminRole !== "ADMIN" ||
      !ctx.adminActive ||
      !ctx.adminApproved ||
      ctx.adminUserId === ctx.driverUserId
    ) {
      throw Error("PAYOUT_ACTOR_MISMATCH");
    }

    const existing = await tx.findReceipt(command.payoutKey);

    if (existing) {
      if (
        existing.driverUserId !== command.driverUserId ||
        existing.adminUserId !== command.adminUserId ||
        existing.amountRappen !== command.amountRappen ||
        existing.payoutShiftId !== ctx.payoutShiftId
      ) {
        throw Error("PAYOUT_KEY_REUSED_WITH_DIFFERENT_REQUEST");
      }
      return {status:"ALREADY_BOOKED" as const,receipt:existing};
    }

    const plan = planAdminPayoutV1665(
      state.wallet,
      ctx,
      {
        amountRappen:command.amountRappen,
        payoutKey:command.payoutKey
      }
    );

    const receipt:PayoutReceiptV1666 = {
      payoutKey:plan.payoutKey,
      driverUserId:plan.driverUserId,
      adminUserId:plan.adminUserId,
      payoutShiftId:plan.payoutShiftId,
      amountRappen:plan.amountRappen,
      cardTipRappen:plan.cardTipRappen,
      cardCommissionRappen:plan.cardCommissionRappen,
      cashCarryoverRappen:plan.cashCarryoverRappen,
      balanceAfterRappen:plan.balanceAfterRappen
    };

    await tx.savePayout(receipt);

    return {status:"BOOKED" as const,receipt};
  });
}

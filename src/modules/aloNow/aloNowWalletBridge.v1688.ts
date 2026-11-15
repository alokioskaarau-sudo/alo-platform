
/**
 * ALO NOW V1688 - internal, non-authoritative wallet bridge.
 *
 * Input evidence must be assembled by a trusted server-side
 * verifier. This module NEVER authenticates Shopify evidence,
 * never executes SQL and never authorizes payouts.
 *
 * Diagnostic monetary values must NOT be presented as balances.
 */

import {
  evaluateCardWalletEvidenceV1676
} from "./aloNowWalletEvidence.v1676.js";

import type {
  EvidenceV1676
} from "./aloNowWalletEvidence.v1676.js";

import {
  quoteDriverWalletV961
} from "./aloNowDriverWallet.v961.js";

export type WalletBridgeResultV1688 = {
  status:
    | "EMPTY"
    | "BLOCKED"
    | "DIAGNOSTIC_ONLY";
  driverUserId: string;
  workspace: "AARAU" | "OLTEN";
  candidatesChecked: number;
  acceptedReceipts: number;
  blockedReasons: string[];
  diagnosticCardCommissionRappen: number | null;
  diagnosticCardTipsRappen: number | null;
  payableOutstandingRappen: null;
  payoutEnabled: false;
  sourceVerificationPerformed: false;
  readOnly: true;
};

export function projectCardWalletEvidenceV1688(
  driverUserId: string,
  workspace: "AARAU" | "OLTEN",
  evidence: readonly EvidenceV1676[]
): WalletBridgeResultV1688 {
  if (
    !/^[1-9][0-9]{0,18}$/.test(driverUserId) ||
    (workspace !== "AARAU" && workspace !== "OLTEN") ||
    !Array.isArray(evidence)
  ) {
    throw new Error("V1688_INVALID_SCOPE");
  }

  const result = (
    status: WalletBridgeResultV1688["status"],
    acceptedReceipts: number,
    blockedReasons: string[],
    commission: number | null = null,
    tips: number | null = null
  ): WalletBridgeResultV1688 => ({
    status,
    driverUserId,
    workspace,
    candidatesChecked: evidence.length,
    acceptedReceipts,
    blockedReasons,
    diagnosticCardCommissionRappen: commission,
    diagnosticCardTipsRappen: tips,
    payableOutstandingRappen: null,
    payoutEnabled: false,
    sourceVerificationPerformed: false,
    readOnly: true
  });

  if (evidence.length === 0) {
    return result("EMPTY", 0, []);
  }

  const seen = new Set<string>();
  const receipts: Array<
    Extract<
      ReturnType<typeof evaluateCardWalletEvidenceV1676>,
      { eligible: true }
    >["receipt"]
  > = [];

  const blockers: string[] = [];

  for (const item of evidence) {
    if (
      item.driverUserId !== driverUserId ||
      item.workspace !== workspace
    ) {
      blockers.push("DRIVER_OR_WORKSPACE_MISMATCH");
      continue;
    }

    if (!item.orderId || seen.has(item.orderId)) {
      blockers.push("DUPLICATE_OR_INVALID_ORDER");
      continue;
    }

    seen.add(item.orderId);

    const checked = evaluateCardWalletEvidenceV1676(item);

    if (!checked.eligible) {
      blockers.push(checked.reason);
      continue;
    }

    receipts.push(checked.receipt);
  }

  // One blocked item invalidates the whole diagnostic projection.
  // Never calculate partial wallet totals and present them as final.
  if (blockers.length > 0) {
    return result("BLOCKED", receipts.length, blockers);
  }

  try {
    // All values are hypothetical until independent sourcing,
    // refunds, existing payouts and other channels are reconciled.
    const simulation = quoteDriverWalletV961({
      receipts,
      openingFloatRappen: 0,
      confirmedEnvelopeRappen: 0,
      confirmedPayoutRappen: 0
    });

    return result(
      "DIAGNOSTIC_ONLY",
      receipts.length,
      [],
      simulation.earnedCardCommissionRappen,
      simulation.cardTipsRappen
    );

  } catch {
    return result(
      "BLOCKED",
      0,
      ["WALLET_PROJECTION_INVALID"]
    );
  }
}

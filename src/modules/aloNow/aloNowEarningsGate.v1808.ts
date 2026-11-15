/**
 * ALO NOW V1808
 * Internal presentation gate; does not authenticate sources.
 * Callers must verify provider data independently on the backend.
 * Never accept attestation fields from an HTTP client.
 * No money mutation, entitlement creation or payout.
 */
import {
  evaluateCardWalletEvidenceV1676
} from "./aloNowWalletEvidence.v1676.js";

import type {
  EvidenceV1676
} from "./aloNowWalletEvidence.v1676.js";

export type IndependentAttestationV1808 = {
  orderId: string;
  driverUserId: string;
  workspace: "AARAU" | "OLTEN";
  providerPaymentChecked: boolean;
  refundsAndReversalsChecked: boolean;
  financeEventOriginsChecked: boolean;
  commissionBookingChecked: boolean;
  finalHandoffChecked: boolean;
};

export type EarningsPresentationV1808 =
  | {
      status: "PENDING_VERIFICATION";
      commissionRappen: null;
      tipRappen: null;
      verified: false;
    }
  | {
      status: "DISPLAY_READY";
      commissionRappen: number;
      tipRappen: number;
      verified: true;
    };

const pending = (): EarningsPresentationV1808 => ({
  status: "PENDING_VERIFICATION",
  commissionRappen: null,
  tipRappen: null,
  verified: false
});

export function evaluateEarningsPresentationV1808(
  evidence: EvidenceV1676,
  attestation: IndependentAttestationV1808 | null
): EarningsPresentationV1808 {
  if (!evidence || !attestation) return pending();

  if (
    attestation.orderId !== evidence.orderId ||
    attestation.driverUserId !== evidence.driverUserId ||
    attestation.workspace !== evidence.workspace ||
    attestation.providerPaymentChecked !== true ||
    attestation.refundsAndReversalsChecked !== true ||
    attestation.financeEventOriginsChecked !== true ||
    attestation.commissionBookingChecked !== true ||
    attestation.finalHandoffChecked !== true
  ) {
    return pending();
  }

  const checked = evaluateCardWalletEvidenceV1676(evidence);

  if (!checked.eligible) return pending();

  const commission = checked.receipt.commissionRappen;
  const tip = checked.receipt.cardTipRappen;

  if (
    !Number.isSafeInteger(commission) ||
    !Number.isSafeInteger(tip) ||
    commission < 0 ||
    tip < 0 ||
    !Number.isSafeInteger(commission + tip)
  ) {
    return pending();
  }

  return {
    status: "DISPLAY_READY",
    commissionRappen: commission,
    tipRappen: tip,
    verified: true
  };
}

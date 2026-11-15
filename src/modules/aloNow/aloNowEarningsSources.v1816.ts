/**
 * ALO NOW V1816 - Combined earnings source status.
 * No client-controlled attestation and no monetary release.
 * All sources remain non-authoritative for payout.
 */

import type {
  OnlineEvidenceV1810
} from "./aloNowOnlinePaymentEvidence.v1810.js";

import type {
  LedgerResultV1815
} from "./aloNowEarningsLedger.v1815.js";

export type EarningsSourceStatusV1816 = {
  status:
    | "BLOCKED"
    | "AWAITING_BOOKING"
    | "AWAITING_FINAL_VERIFICATION";
  paymentMatched: boolean;
  bookingPresent: boolean;
  sourceVerified: false;
  earningsAuthorized: false;
  payoutEnabled: false;
  commissionRappen: null;
  tipRappen: null;
};

export function combineEarningsSourcesV1816(
  payment: OnlineEvidenceV1810,
  ledger: LedgerResultV1815
): EarningsSourceStatusV1816 {
  const paymentMatched =
    payment?.status === "MATCHED_REFUND_CHECK_PENDING" &&
    payment.shopifyPaymentMatched === true &&
    payment.earningsAuthorized === false &&
    payment.payoutEnabled === false &&
    payment.refundVerificationCompleted === false;

  const bookingPresent =
    ledger?.status === "BOOKINGS_PRESENT_UNVERIFIED" &&
    ledger.commissionCount === 1 &&
    ledger.tipCount >= 0 &&
    ledger.tipCount <= 99 &&
    ledger.sourceVerified === false &&
    ledger.earningsAuthorized === false &&
    ledger.payoutEnabled === false;

  // ALO_NOW_V1817_STRICT_SOURCES
  // A pending booking must contain zero entitlement events.
  // Contradictory evidence always fails closed.
  const genuinelyPending =
    ledger?.status === "PENDING_BOOKING" &&
    ledger.commissionCount === 0 &&
    ledger.tipCount === 0 &&
    ledger.sourceVerified === false &&
    ledger.earningsAuthorized === false &&
    ledger.payoutEnabled === false;

  const status: EarningsSourceStatusV1816["status"] =
    !paymentMatched
      ? "BLOCKED"
      : bookingPresent
        ? "AWAITING_FINAL_VERIFICATION"
        : genuinelyPending
          ? "AWAITING_BOOKING"
          : "BLOCKED";

  return {
    status,
    paymentMatched:
      status !== "BLOCKED" && paymentMatched,
    bookingPresent:
      status === "AWAITING_FINAL_VERIFICATION",
    sourceVerified: false,
    earningsAuthorized: false,
    payoutEnabled: false,
    commissionRappen: null,
    tipRappen: null
  };
}

import {
  buildTipCheckoutV170
} from "./aloNowTipCheckout.v170.js";

import {
  claimTipDraftCreationV175
} from "./aloNowTipDraftClaim.v175.js";

import type {
  TipDraftClaimResultV175
} from "./aloNowTipDraftClaim.v175.js";

/**
 * ALO NOW V177
 *
 * Internal local-test-only preparation.
 *
 * The persisted claim is the sole source of amount,
 * original Shopify order and tax configuration.
 *
 * Does not execute the Shopify mutation.
 * Does not return an invoice URL.
 * Does not credit the driver wallet.
 */

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type PreparedDraftV177 =
  ReturnType<typeof buildTipCheckoutV170>;

export type TipDraftPreparationResultV177 =
  | {
      ok: true;
      status: "READY_FOR_CONTROLLED_TEST";
      draft: PreparedDraftV177;
      shopifyExecuted: false;
      walletAuthorized: false;
    }
  | {
      ok: false;
      reason: string;
    };

export function assembleClaimedTipDraftV177(
  requestId: string,
  checkoutReference: string,
  claim: TipDraftClaimResultV175
): TipDraftPreparationResultV177 {
  if (
    !UUID.test(requestId) ||
    !UUID.test(checkoutReference)
  ) {
    return {
      ok: false,
      reason: "INVALID_CHECKOUT_IDENTITY"
    };
  }

  if (!claim.ok) {
    return {
      ok: false,
      reason: claim.reason
    };
  }

  if (
    claim.action !== "CLAIMED" ||
    claim.checkoutReference.toLowerCase() !==
      checkoutReference.toLowerCase()
  ) {
    return {
      ok: false,
      reason: "CLAIM_REFERENCE_MISMATCH"
    };
  }

  try {
    const draft = buildTipCheckoutV170({
      requestId,
      checkoutReference,
      originalOrderId: claim.originalOrderId,
      amountRappen: claim.amountRappen,
      taxable: claim.taxable
    });

    if (
      draft.networkExecuted !== false ||
      draft.walletAuthorized !== false ||
      draft.checkoutReference.toLowerCase() !==
        checkoutReference.toLowerCase()
    ) {
      return {
        ok: false,
        reason: "DRAFT_CONTRACT_INVALID"
      };
    }

    return {
      ok: true,
      status: "READY_FOR_CONTROLLED_TEST",
      draft,
      shopifyExecuted: false,
      walletAuthorized: false
    };
  } catch {
    return {
      ok: false,
      reason: "DRAFT_PREPARATION_FAILED"
    };
  }
}

/**
 * Actual internal orchestration.
 *
 * Claim is committed before assembling the request.
 * If assembly fails, the claim remains uncertain;
 * no automatic retry is performed.
 *
 * Never call this from an unauthenticated route.
 */
export async function prepareTipDraftV177(
  requestId: string,
  checkoutReference: string
): Promise<TipDraftPreparationResultV177> {
  if (
    process.env.NODE_ENV !== "test" ||
    process.env.ALO_RUNTIME_MODE !== "local_test" ||
    process.env.ALO_NOW_TIP_LOCAL_RESERVATIONS_ENABLED !==
      "true"
  ) {
    return {
      ok: false,
      reason: "TIP_DRAFT_PREPARATION_DISABLED"
    };
  }

  if (
    !UUID.test(requestId) ||
    !UUID.test(checkoutReference)
  ) {
    return {
      ok: false,
      reason: "INVALID_CHECKOUT_IDENTITY"
    };
  }

  const claim = await claimTipDraftCreationV175(
    requestId,
    checkoutReference
  );

  return assembleClaimedTipDraftV177(
    requestId,
    checkoutReference,
    claim
  );
}

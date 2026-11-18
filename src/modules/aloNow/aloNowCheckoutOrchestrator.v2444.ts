import type {
  AloNowDraftClaimResult
} from "./aloNowDraftClaimService.js";

import type {
  LiveDraftResult
} from "./aloNowLiveDraftTransport.v2437.js";

import type {
  recordAloNowDraftOutcome
} from "./aloNowDraftOutcomeService.js";

type Claim = (
  requestId: string
) => Promise<AloNowDraftClaimResult>;

type Send = (
  graphql: Extract<
    AloNowDraftClaimResult, { ok: true }
  >["graphql"],
  totalCHF: string
) => Promise<LiveDraftResult>;

type Persist = typeof recordAloNowDraftOutcome;

export function createAloNowCheckoutOrchestratorV2444(
  dependencies: {
    claim: Claim;
    send: Send;
    persist: Persist;
  }
) {
  return async function execute(requestId: string) {

    // This service must never bypass the release gate.
    // There is intentionally no HTTP route here.
    if (
      process.env.NODE_ENV !== "production" ||
      process.env.ALO_RUNTIME_MODE !== "production" ||
      process.env.ALO_NOW_REAL_DRAFT_WRITES_ENABLED !== "true"
    ) {
      return {
        ok: false as const,
        reason: "CHECKOUT_RELEASE_DISABLED"
      };
    }

    const claimed = await dependencies.claim(requestId);

    if (!claimed.ok) {
      return {
        ok: false as const,
        reason: claimed.reason
      };
    }

    let sent: LiveDraftResult;

    try {
      sent = await dependencies.send(
        claimed.graphql,
        claimed.expectedTotalCHF
      );
    } catch {
      sent = {
        ok: false,
        reason: "SHOPIFY_OUTCOME_UNCERTAIN"
      };
    }

    // Every claimed attempt must be finalized or
    // flagged for reconciliation. Never auto-retry.
    const outcomeInput = sent.ok
      ? sent.shopifyResponse
      : {
          errors: [{
            message: "RECONCILE_REQUIRED"
          }]
        };

    let persisted: Awaited<ReturnType<Persist>>;

    try {
      persisted = await dependencies.persist(
        claimed.requestId,
        claimed.attemptId,
        outcomeInput
      );
    } catch {
      return {
        ok: false as const,
        reason: "DRAFT_PERSISTENCE_UNAVAILABLE"
      };
    }

    if (!persisted.ok) {
      return {
        ok: false as const,
        reason: "DRAFT_PERSISTENCE_UNAVAILABLE"
      };
    }

    if (
      !sent.ok ||
      persisted.status !== "CREATED"
    ) {
      return {
        ok: false as const,
        reason: "RECONCILE_REQUIRED"
      };
    }

    if (
      persisted.draftOrderId !== sent.draftOrderId
    ) {
      return {
        ok: false as const,
        reason: "DRAFT_ID_MISMATCH"
      };
    }

    return {
      ok: true as const,
      status: "CREATED" as const,
      requestId: claimed.requestId,
      draftOrderId: persisted.draftOrderId,
      invoiceUrl: sent.invoiceUrl
    };
  };
}

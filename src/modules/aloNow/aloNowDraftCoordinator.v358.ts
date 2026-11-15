/**
 * ALO NOW V358 – local-test-only draft coordinator.
 *
 * No Shopify credentials, HTTP requests, payment links,
 * customer routes, or production write capabilities.
 *
 * The caller supplies trusted adapters. Never pass an
 * untrusted browser response as a draft outcome.
 */

type IntentResult =
  | { ok: true; intent: { checkoutReference: string } }
  | { ok: false; reason: string };

type ClaimResult =
  | {
      ok: true;
      requestId: string;
      attemptId: string;
      checkoutReference: string;
      expectedTotalCHF: string;
      graphql: unknown;
    }
  | { ok: false; reason: string };

type OutcomeResult =
  | { ok: true; status: "CREATED"; draftOrderId: string }
  | { ok: true; status: "RECONCILE_REQUIRED" }
  | { ok: false; reason: string };

type Dependencies = {
  ensureIntent: (id: string) => Promise<IntentResult>;
  claim: (id: string) => Promise<ClaimResult>;
  sendSimulation: (
    graphql: unknown,
    expectedTotalCHF: string
  ) => Promise<unknown>;
  recordOutcome: (
    requestId: string,
    attemptId: string,
    response: unknown
  ) => Promise<OutcomeResult>;
};

type Result =
  | { ok: true; status: "CREATED"; draftOrderId: string }
  | { ok: false; reason: string };

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function localTestOnly(): boolean {
  if (
    process.env.NODE_ENV !== "test" ||
    process.env.ALO_RUNTIME_MODE !== "local_test" ||
    process.env.ALO_NOW_DRAFT_SIMULATION_ENABLED !== "true"
  ) return false;

  try {
    const url = new URL(process.env.DATABASE_URL ?? "");
    return (
      ["postgres:", "postgresql:"].includes(url.protocol) &&
      url.hostname === "127.0.0.1" &&
      url.port === "55433" &&
      url.pathname === "/alo_staff_test"
    );
  } catch {
    return false;
  }
}

export function createAloNowDraftCoordinatorV358(
  deps: Dependencies
) {
  return async function run(requestId: string): Promise<Result> {
    if (!localTestOnly())
      return { ok: false, reason: "LOCAL_SIMULATION_ONLY" };

    if (!UUID.test(requestId))
      return { ok: false, reason: "INVALID_REQUEST_ID" };

    let intent: IntentResult;
    try {
      intent = await deps.ensureIntent(requestId);
    } catch {
      return { ok: false, reason: "CHECKOUT_INTENT_UNAVAILABLE" };
    }

    if (!intent.ok)
      return { ok: false, reason: intent.reason };

    let claim: ClaimResult;
    try {
      claim = await deps.claim(requestId);
    } catch {
      return { ok: false, reason: "DRAFT_CLAIM_UNAVAILABLE" };
    }

    if (!claim.ok)
      return { ok: false, reason: claim.reason };

    if (
      claim.requestId !== requestId ||
      !UUID.test(claim.attemptId) ||
      claim.checkoutReference !== intent.intent.checkoutReference
    ) {
      // Claim has already entered CREATING. Never send.
      // Persist an uncertain outcome for manual reconciliation.
      try {
        await deps.recordOutcome(requestId, claim.attemptId, null);
      } catch {
        return { ok: false, reason: "OUTCOME_PERSISTENCE_UNCONFIRMED" };
      }
      return { ok: false, reason: "CLAIM_IDENTITY_MISMATCH" };
    }

    // Any transport exception is uncertain, NOT retryable.
    let response: unknown = null;
    try {
      response = await deps.sendSimulation(
        claim.graphql,
        claim.expectedTotalCHF
      );
    } catch {
      // Null is intentionally persisted as RECONCILE_REQUIRED.
    }

    let outcome: OutcomeResult;
    try {
      outcome = await deps.recordOutcome(
        requestId,
        claim.attemptId,
        response
      );
    } catch {
      return {
        ok: false,
        reason: "OUTCOME_PERSISTENCE_UNCONFIRMED"
      };
    }

    if (!outcome.ok)
      return { ok: false, reason: outcome.reason };

    if (outcome.status === "RECONCILE_REQUIRED")
      return { ok: false, reason: "RECONCILE_REQUIRED" };

    return {
      ok: true,
      status: "CREATED",
      draftOrderId: outcome.draftOrderId
    };
  };
}

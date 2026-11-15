import type {
  AloNowDraftClaimResult
} from "./aloNowDraftClaimService.js";

type Claim = (requestId: string) => Promise<AloNowDraftClaimResult>;

type Outcome = (
  requestId: string,
  attemptId: string,
  response: unknown
) => Promise<
  | { ok: true; status: "CREATED"; draftOrderId: string }
  | { ok: true; status: "RECONCILE_REQUIRED" }
  | { ok: false; reason: string }
>;

type Sender = (
  request: Extract<AloNowDraftClaimResult, {ok: true}>["graphql"]
) => Promise<unknown>;

export type DraftSimulationDependencies = {
  claim: Claim;
  recordOutcome: Outcome;
  simulatedSender: Sender;
};

export type DraftSimulationResult =
  | { ok: true; status: "CREATED"; draftOrderId: string }
  | { ok: true; status: "RECONCILE_REQUIRED" }
  | { ok: false; reason: string };

/**
 * V322: INTERNAL LOCAL-ONLY SIMULATION.
 *
 * Never import a real Shopify mutation transport here.
 * Never expose this as a public route.
 * No invoice URL or payment permission can be returned.
 */
export async function runAloNowDraftSimulation(
  requestId: string,
  dependencies: DraftSimulationDependencies
): Promise<DraftSimulationResult> {
  if (
    process.env.ALO_RUNTIME_MODE !== "local_test" ||
    process.env.ALO_NOW_DRAFT_SIMULATION_ENABLED !== "true"
  ) {
    return {ok:false,reason:"SIMULATION_DISABLED"};
  }

  const claim = await dependencies.claim(requestId);

  if (!claim.ok)
    return claim;

  let shopifyResponse: unknown = null;

  try {
    // Injected simulation only. No HTTP client is imported.
    shopifyResponse =
      await dependencies.simulatedSender(claim.graphql);
  } catch {
    // An uncertain result is never retried.
    // Record null to request reconciliation instead.
    shopifyResponse = null;
  }

  try {
    return await dependencies.recordOutcome(
      claim.requestId,
      claim.attemptId,
      shopifyResponse
    );
  } catch {
    return {
      ok:false,
      reason:"OUTCOME_PERSISTENCE_UNCONFIRMED"
    };
  }
}

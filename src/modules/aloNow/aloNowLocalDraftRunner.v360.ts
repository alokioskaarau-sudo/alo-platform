import {
  ensureAloNowCheckoutIntent
} from "./aloNowCheckoutIntentStore.js";
import {
  createAloNowDraftClaimService
} from "./aloNowDraftClaimService.js";
import {
  recordAloNowDraftOutcome
} from "./aloNowDraftOutcomeService.js";
import {
  createAloNowDraftCoordinatorV358
} from "./aloNowDraftCoordinator.v358.js";

type CartReader =
  Parameters<typeof createAloNowDraftClaimService>[0];

type Claim = Awaited<
  ReturnType<ReturnType<typeof createAloNowDraftClaimService>>
>;

type Graphql = Extract<Claim, { ok: true }>["graphql"];

type Sender = (
  graphql: Graphql,
  expectedTotalCHF: string
) => Promise<unknown>;

/**
 * Local DB-backed integration. No HTTP transport is imported.
 * The coordinator rejects every non-local-test runtime.
 */
export function createAloNowLocalDraftRunnerV360(
  readCart: CartReader,
  simulatedSender: Sender
) {
  const claim = createAloNowDraftClaimService(readCart);

  return createAloNowDraftCoordinatorV358({
    ensureIntent: ensureAloNowCheckoutIntent,
    claim,
    sendSimulation: (graphql, amount) =>
      simulatedSender(graphql as Graphql, amount),
    recordOutcome: recordAloNowDraftOutcome
  });
}

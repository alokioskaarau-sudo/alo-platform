import {
  createAloNowDraftClaimService
} from "./aloNowDraftClaimService.js";

import {
  sendAloNowLiveDraftV2437
} from "./aloNowLiveDraftTransport.v2437.js";

import {
  recordAloNowDraftOutcome
} from "./aloNowDraftOutcomeService.js";

import {
  createAloNowCheckoutOrchestratorV2444
} from "./aloNowCheckoutOrchestrator.v2444.js";

type ReadCart = Parameters<
  typeof createAloNowDraftClaimService
>[0];

type ShopifySender = Parameters<
  typeof sendAloNowLiveDraftV2437
>[2]["send"];

/**
 * Connects the real database claim and outcome services
 * to the Shopify Draft Order transport.
 *
 * No HTTP route is registered here.
 * No checkout is executed during initialization.
 */
export function createAloNowCheckoutWiringV2445(
  dependencies: {
    readCart: ReadCart;
    domain: string;
    accessToken: string;
    send: ShopifySender;
  }
) {
  const claim = createAloNowDraftClaimService(
    dependencies.readCart
  );

  return createAloNowCheckoutOrchestratorV2444({
    claim,

    send: async (graphql, totalCHF) =>
      sendAloNowLiveDraftV2437(
        graphql,
        totalCHF,
        {
          domain: dependencies.domain,
          accessToken: dependencies.accessToken,
          send: dependencies.send
        }
      ),

    persist: recordAloNowDraftOutcome
  });
}

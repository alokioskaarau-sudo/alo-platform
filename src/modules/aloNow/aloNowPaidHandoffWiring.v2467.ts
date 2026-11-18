
import {
  createAloNowPaidHandoffV2462
} from "./aloNowPaidHandoff.v2462.js";
type Step = {
  ok: boolean;
  reason?: string;
};

type Link = {
  ok: boolean;
  reason?: string;
  expectedTotalCHF?: string;
  draftOrderId?: string;
};

type Binding = {
  ok: boolean;
  reason?: string;
  shopifyOrderId?: string;
  expectedTotalChf?: string;
  alreadyBound?: boolean;
};

type Payment = {
  ok: boolean;
  reason?: string;
  action?: "CONFIRMED" | "ALREADY_CONFIRMED" | "RECONCILE";
  version?: number;
};

export type PaidHandoffServicesV2467 = {
  preflight: (
    requestId: string,
    orderId: string
  ) => Promise<Step>;

  verifyDraftLink: (
    requestId: string,
    orderId: string
  ) => Promise<Link>;

  bind: (
    requestId: string,
    orderId: string,
    verifiedDraftTotalChf?: string,
    verifiedDraftOrderId?: string
  ) => Promise<Binding>;

  commit: (
    requestId: string
  ) => Promise<Payment>;
};

function cents(value: string | undefined): bigint | null {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]{0,8})\.[0-9]{2}$/.test(value)
  ) return null;

  const [whole, fraction] = value.split(".");
  return BigInt(whole) * 100n + BigInt(fraction);
}

/**
 * Compose existing server-side payment services.
 * No webhook or customer route is registered here.
 */
export function createAloNowPaidHandoffWiringV2467(
  services: PaidHandoffServicesV2467
) {
  return async (requestId: string, orderId: string) => {
    // Scoped to this invocation: never share checkout evidence
    // between concurrent orders.
    let verifiedAmount: string | null = null;
    let verifiedDraftId: string | null = null;

    const handoff = createAloNowPaidHandoffV2462({
      verifyProvenance: async (id, order) => {
        const result = await services.preflight(id, order);
        return result.ok
          ? { ok: true }
          : {
              ok: false,
              reason: result.reason ?? "PREFLIGHT_FAILED"
            };
      },

      verifyCreatedDraft: async (id, order) => {
        const result = await services.verifyDraftLink(id, order);

        if (
          !result.ok ||
          cents(result.expectedTotalCHF) === null ||
          typeof result.draftOrderId !== "string" ||
          !/^gid:\/\/shopify\/DraftOrder\/[1-9][0-9]*$/
            .test(result.draftOrderId)
        ) {
          return {
            ok: false,
            reason: result.reason ?? "DRAFT_LINK_INVALID"
          };
        }

        verifiedAmount = result.expectedTotalCHF!;
        verifiedDraftId = result.draftOrderId ?? null;
        return { ok: true };
      },

      bindOrder: async (id, order) => {
        if (!verifiedAmount) {
          return {
            ok: false,
            reason: "DRAFT_EVIDENCE_MISSING"
          };
        }

        const result = await services.bind(
          id, order, verifiedAmount,
          verifiedDraftId ?? undefined
        );

        if (!result.ok) {
          return {
            ok: false,
            reason: result.reason ?? "BINDING_FAILED"
          };
        }

        if (
          result.shopifyOrderId !== order ||
          cents(result.expectedTotalChf) === null ||
          cents(result.expectedTotalChf) !==
            cents(verifiedAmount)
        ) {
          return {
            ok: false,
            reason: "VERIFIED_BINDING_TOTAL_MISMATCH"
          };
        }

        return {
          ok: true,
          shopifyOrderId: order,
          expectedTotalChf: result.expectedTotalChf!,
          alreadyBound: result.alreadyBound === true
        };
      },

      confirmPayment: async id => {
        const result = await services.commit(id);

        if (!result.ok || !result.action) {
          return {
            ok: false,
            reason: result.reason ?? "PAYMENT_COMMIT_FAILED"
          };
        }

        return {
          ok: true,
          action: result.action,
          version: result.version
        };
      }
    });

    return handoff(requestId, orderId);
  };
}

/**
 * V2469: Production dependencies are imported on demand.
 * Unit tests can import this module without loading live credentials.
 * No HTTP route is registered here.
 */
async function loadAloNowPaidHandoffServicesV2469():
  Promise<PaidHandoffServicesV2467> {

  const [
    preflightModule,
    draftModule,
    bindingModule,
    commitModule,
    paymentReaderModule
  ] = await Promise.all([
    import("./aloNowOrderBindingPreflight.js"),
    import("./aloNowDraftOrderLink.v2465.js"),
    import("./aloNowShopifyOrderBinding.js"),
    import("./aloNowVerifiedPaymentCommit.js"),
    import("./aloNowLiveShopifyPaymentReader.js")
  ]);

  return {
    preflight:
      preflightModule.preflightAloNowOrderBinding,

    verifyDraftLink:
      draftModule.verifyAloNowDraftOrderLinkV2465,

    bind:
      bindingModule.bindAloNowShopifyOrder,

    commit: requestId =>
      commitModule.commitVerifiedAloNowOnlinePayment(
        requestId,
        paymentReaderModule.readAloNowLiveShopifyPayment
      )
  };
}

/**
 * Separate release gate.
 * Cannot be invoked in local tests or development.
 * Existing webshop and webhook routes remain unchanged.
 */
export async function runAloNowPaidHandoffV2467(
  requestId: string,
  orderId: string
) {
  if (
    process.env.ALO_NOW_PAID_HANDOFF_ENABLED !== "true" ||
    process.env.ALO_RUNTIME_MODE !== "production" ||
    process.env.NODE_ENV !== "production"
  ) {
    return {
      ok: false as const,
      reason: "PAID_HANDOFF_DISABLED",
      staffReady: false
    };
  }

  const services =
    await loadAloNowPaidHandoffServicesV2469();

  return createAloNowPaidHandoffWiringV2467(
    services
  )(requestId, orderId);
}

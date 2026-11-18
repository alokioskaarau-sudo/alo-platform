/**
 * V2462: Internal payment handoff coordinator.
 *
 * No direct database or Shopify access in this module.
 * Dependencies are injected and must be trusted server-side.
 *
 * IMPORTANT: A successful result is NOT permission to dispatch
 * until the real webhook integration has passed its own tests.
 */

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ORDER =
  /^gid:\/\/shopify\/Order\/[1-9][0-9]*$/;

type Step =
  | { ok: true }
  | { ok: false; reason: string };

type Binding =
  | {
      ok: true;
      shopifyOrderId: string;
      expectedTotalChf: string;
      alreadyBound: boolean;
    }
  | { ok: false; reason: string };

type Payment =
  | {
      ok: true;
      action: "CONFIRMED" | "ALREADY_CONFIRMED" | "RECONCILE";
      version?: number;
    }
  | { ok: false; reason: string };

export type PaidHandoffDependenciesV2462 = {
  verifyProvenance: (
    requestId: string,
    orderId: string
  ) => Promise<Step>;

  verifyCreatedDraft: (
    requestId: string,
    orderId: string
  ) => Promise<Step>;

  bindOrder: (
    requestId: string,
    orderId: string
  ) => Promise<Binding>;

  confirmPayment: (
    requestId: string
  ) => Promise<Payment>;
};

export function createAloNowPaidHandoffV2462(
  deps: PaidHandoffDependenciesV2462
) {
  return async (requestId: string, orderId: string) => {
    if (!UUID.test(requestId) || !ORDER.test(orderId)) {
      return {
        ok: false as const,
        reason: "INVALID_HANDOFF_IDENTITY",
        staffReady: false
      };
    }

    try {
      const provenance =
        await deps.verifyProvenance(requestId, orderId);

      if (!provenance.ok) {
        return {
          ok: false as const,
          reason: provenance.reason,
          staffReady: false
        };
      }

      const draft =
        await deps.verifyCreatedDraft(requestId, orderId);

      if (!draft.ok) {
        return {
          ok: false as const,
          reason: draft.reason,
          staffReady: false
        };
      }

      const binding =
        await deps.bindOrder(requestId, orderId);

      if (!binding.ok) {
        return {
          ok: false as const,
          reason: binding.reason,
          staffReady: false
        };
      }

      if (
        binding.shopifyOrderId !== orderId ||
        !/^(0|[1-9][0-9]{0,8})\.[0-9]{2}$/.test(
          binding.expectedTotalChf
        )
      ) {
        return {
          ok: false as const,
          reason: "BINDING_RESULT_INVALID",
          staffReady: false
        };
      }

      const payment =
        await deps.confirmPayment(requestId);

      if (!payment.ok) {
        return {
          ok: false as const,
          reason: payment.reason,
          staffReady: false,
          bindingPersisted: true
        };
      }

      if (payment.action === "RECONCILE") {
        return {
          ok: true as const,
          action: "RECONCILE" as const,
          staffReady: false
        };
      }

      if (
        payment.action !== "CONFIRMED" &&
        payment.action !== "ALREADY_CONFIRMED"
      ) {
        return {
          ok: false as const,
          reason: "PAYMENT_RESULT_INVALID",
          staffReady: false
        };
      }

      return {
        ok: true as const,
        action: payment.action,
        shopifyOrderId: orderId,
        staffReady: true
      };
    } catch {
      return {
        ok: false as const,
        reason: "HANDOFF_UNAVAILABLE",
        staffReady: false
      };
    }
  };
}

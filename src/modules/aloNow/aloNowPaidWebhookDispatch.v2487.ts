import {
  decidePaidChannelV2486
} from "./aloNowPaidChannelDecision.v2486.js";
import type {
  PaidBindingV2484
} from "./aloNowPaidOrderBinding.v2484.js";

type Channel = "ALO_NOW" | "SHIPPING" | "PICKUP";

type Services<T> = {
  readOrder: (id: string) => Promise<unknown | null>;
  verifyChannel: (order: unknown) => Channel;
  resolveBinding: (id: string) => Promise<PaidBindingV2484>;
  resolveFirstPaid: (id: string) => Promise<
    | { ok: true; requestId: string; orderId: string }
    | { ok: false; reason: string }
  >;
  handoff: (
    requestId: string,
    orderId: string
  ) => Promise<{
    ok: boolean;
    staffReady: boolean;
    reason?: string;
  }>;
  process: (originalOrderId: string) => Promise<T>;
};

export function paidWebhookDispatchEnabledV2487(): boolean {
  return (
    process.env.ALO_NOW_PAID_WEBHOOK_DISPATCH_ENABLED === "true" &&
    process.env.ALO_NOW_PAID_HANDOFF_ENABLED === "true" &&
    process.env.NODE_ENV === "production" &&
    process.env.ALO_RUNTIME_MODE === "production"
  );
}

export function createPaidWebhookDispatchV2487<T>(
  services: Services<T>
) {
  return async (
    canonicalOrderId: string,
    originalOrderId: string
  ): Promise<T> => {
    const match =
      /^gid:\/\/shopify\/Order\/([1-9][0-9]*)$/
        .exec(canonicalOrderId);

    if (!match)
      throw new Error("INVALID_SHOPIFY_ORDER_ID");

    if (
      originalOrderId !== canonicalOrderId &&
      originalOrderId !== match[1]
    ) {
      throw new Error("SHOPIFY_ORDER_ID_MISMATCH");
    }

    const order = await services.readOrder(originalOrderId);

    if (!order)
      throw new Error("SHOPIFY_ORDER_NOT_FOUND");

    if (typeof order !== "object" || Array.isArray(order))
      throw new Error("SHOPIFY_ORDER_INVALID");

    const verified = order as {
      id?: unknown;
      displayFinancialStatus?: unknown;
      cancelledAt?: unknown;
    };

    if (verified.id !== canonicalOrderId)
      throw new Error("SHOPIFY_ORDER_ID_MISMATCH");

    if (verified.displayFinancialStatus !== "PAID")
      throw new Error("SHOPIFY_ORDER_NOT_PAID");

    if (verified.cancelledAt != null)
      throw new Error("SHOPIFY_ORDER_CANCELLED");

    const channel = services.verifyChannel(order);

    const binding =
      await services.resolveBinding(canonicalOrderId);

    const decision =
      decidePaidChannelV2486(binding, channel);

    // First paid ALO NOW orders can have no stored Shopify
    // order binding yet. Verify server-side checkout evidence
    // BEFORE allowing the existing atomic handoff to bind.
    let requestId: string | null = null;

    if (
      channel === "ALO_NOW" &&
      binding.kind === "WEBSHOP"
    ) {
      const first =
        await services.resolveFirstPaid(canonicalOrderId);

      if (!first.ok)
        throw new Error(first.reason);

      if (
        first.orderId !== canonicalOrderId ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
          .test(first.requestId)
      ) {
        throw new Error("FIRST_PAID_IDENTITY_MISMATCH");
      }

      requestId = first.requestId;
    } else {
      if (decision.kind === "BLOCKED")
        throw new Error(decision.reason);

      if (decision.kind === "ALO_NOW")
        requestId = decision.requestId;
    }

    if (requestId !== null) {
      const result = await services.handoff(
        requestId,
        canonicalOrderId
      );

      if (!result.ok || !result.staffReady)
        throw new Error(
          result.reason ?? "ALO_NOW_HANDOFF_NOT_READY"
        );
    }

    return services.process(originalOrderId);
  };
}

/**
 * Real adapters are loaded only after the explicit
 * production gate passes. No credentials at module import.
 */
export async function runAloNowPaidWebhookDispatchV2487(
  canonicalOrderId: string,
  originalOrderId: string
) {
  if (!paidWebhookDispatchEnabledV2487())
    throw new Error("PAID_WEBHOOK_DISPATCH_DISABLED");

  const [
    orders,
    channel,
    binding,
    handoff,
    shipping,
    database,
    firstPaid,
    provenance
  ] = await Promise.all([
    import("../../integrations/shopify/orders.js"),
    import("../orders/aloNowPaidChannelGuard.v2298.js"),
    import("./aloNowPaidOrderBinding.v2484.js"),
    import("./aloNowPaidHandoffWiring.v2467.js"),
    import("../shipping/paidOrderPipeline.service.js"),
    import("../../database/db.js"),
    import("./aloNowFirstPaidIntegration.v2492.js"),
    import("../../integrations/shopify/aloNowPaidProvenance.v2491.js")
  ]);

  return createPaidWebhookDispatchV2487({
    readOrder: orders.getShopifyOrderById,
    verifyChannel: channel.requireVerifiedAloNowChannelV2298,
    resolveBinding: id =>
      binding.resolvePaidOrderBindingV2484(id, database.db),
    resolveFirstPaid:
      firstPaid.createFirstPaidIntegrationV2492(
        provenance.readAloNowPaidProvenanceV2491,
        database.db
      ),
    handoff: handoff.runAloNowPaidHandoffV2467,
    process: shipping.processPaidShopifyOrder
  })(canonicalOrderId, originalOrderId);
}

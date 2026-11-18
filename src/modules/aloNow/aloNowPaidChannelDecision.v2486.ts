import type {
  PaidBindingV2484
} from "./aloNowPaidOrderBinding.v2484.js";

export type PaidDecisionV2486 =
  | { kind: "WEBSHOP" }
  | {
      kind: "ALO_NOW";
      requestId: string;
      orderId: string;
      workspace: "AARAU";
    }
  | { kind: "BLOCKED"; reason: string };

/**
 * Only combine a trusted Shopify fulfillment channel
 * with a database-resolved order binding.
 * No payments or fulfillment side effects.
 */
export function decidePaidChannelV2486(
  binding: PaidBindingV2484,
  verifiedShopifyChannel: string
): PaidDecisionV2486 {
  if (binding.kind === "BLOCKED") return binding;

  if (binding.kind === "WEBSHOP") {
    if (verifiedShopifyChannel === "ALO_NOW") {
      return {
        kind: "BLOCKED",
        reason: "ALO_NOW_BINDING_MISSING"
      };
    }

    if (
      verifiedShopifyChannel !== "SHIPPING" &&
      verifiedShopifyChannel !== "PICKUP"
    ) {
      return {
        kind: "BLOCKED",
        reason: "UNKNOWN_SHOPIFY_CHANNEL"
      };
    }

    return { kind: "WEBSHOP" };
  }

  if (verifiedShopifyChannel !== "ALO_NOW") {
    return {
      kind: "BLOCKED",
      reason: "SHOPIFY_CHANNEL_BINDING_CONFLICT"
    };
  }

  return binding;
}

/**
 * ALO NOW V2697. Shared orders/paid route for the initial webhook
 * and the background recovery worker.
 * Disabled: unchanged existing webshop fulfillment pipeline.
 * Enabled: canonicalize order ID and fail closed through the
 * verified ALO NOW / webshop dispatcher. No checkout or charge here.
 */
import { processPaidShopifyOrder } from "../shipping/paidOrderPipeline.service.js";
import {
  paidWebhookDispatchEnabledV2487,
  runAloNowPaidWebhookDispatchV2487
} from "./aloNowPaidWebhookDispatch.v2487.js";

export function canonicalPaidOrderIdV2697(raw: string): string | null {
  if (/^[1-9][0-9]*$/.test(raw))
    return `gid://shopify/Order/${raw}`;
  if (/^gid:\/\/shopify\/Order\/[1-9][0-9]*$/.test(raw))
    return raw;
  return null;
}

export async function processPaidOrderWithAloNowV2697(orderId: string) {
  if (!paidWebhookDispatchEnabledV2487()) {
    // Preserve normal orders/paid and existing shipping behavior
    // while ALO NOW is intentionally gated off.
    return processPaidShopifyOrder(orderId);
  }

  const canonicalId = canonicalPaidOrderIdV2697(orderId);
  if (!canonicalId)
    throw new Error("ALO_NOW_INVALID_WEBHOOK_ORDER_ID");

  // The dispatcher performs Shopify PAID evidence, channel and
  // request binding checks before any staff-ready handoff.
  // Failure bubbles up: do NOT mark the webhook COMPLETED.
  return runAloNowPaidWebhookDispatchV2487(canonicalId, orderId);
}

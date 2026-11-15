/**
 * ALO NOW – Payment verification before departure.
 *
 * Only trusted, server-side Shopify responses may authorize
 * online payment. No client-supplied payment flag.
 */
export type AloNowPaymentDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason:
        | "ALO_NOW_PAYMENT_ORDER_NOT_VERIFIED"
        | "ALO_NOW_PAYMENT_NOT_CONFIRMED"
        | "ALO_NOW_PAYMENT_PROVIDER_UNAVAILABLE";
    };

export async function verifyAloNowPaymentBeforeStart(
  orderId: string,
  getOrder: (
    orderId: string
  ) => Promise<{
    displayFinancialStatus?: string | null;
  } | null>
): Promise<AloNowPaymentDecision> {
  if (!orderId.trim()) {
    return {
      allowed: false,
      reason: "ALO_NOW_PAYMENT_ORDER_NOT_VERIFIED",
    };
  }

  let order: Awaited<ReturnType<typeof getOrder>>;
  try {
    order = await getOrder(orderId);
  } catch {
    return {
      allowed: false,
      reason: "ALO_NOW_PAYMENT_PROVIDER_UNAVAILABLE",
    };
  }

  if (!order) {
    return {
      allowed: false,
      reason: "ALO_NOW_PAYMENT_ORDER_NOT_VERIFIED",
    };
  }

  if (
    String(order.displayFinancialStatus ?? "")
      .trim()
      .toUpperCase() !== "PAID"
  ) {
    return {
      allowed: false,
      reason: "ALO_NOW_PAYMENT_NOT_CONFIRMED",
    };
  }

  return { allowed: true };
}

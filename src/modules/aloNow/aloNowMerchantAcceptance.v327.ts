/**
 * ALO NOW V327
 *
 * Customer ordering must not depend on the number
 * of drivers currently online.
 *
 * No database writes, Shopify mutations or payments.
 */

export type QuoteStatus =
  | "STANDARD"
  | "MANUAL_REVIEW"
  | "UNAVAILABLE";

export type FulfillmentDecision =
  | "INTERNAL_DELIVERY"
  | "ASSIGNED_DRIVER"
  | "NOT_CONFIRMED";

export type IntakeDecision =
  | { ok: true; stage: "REQUEST_RECEIVED" }
  | { ok: false; reason: string };

export type PaymentReadiness =
  | { ok: true; stage: "READY_FOR_PAYMENT_PREPARATION" }
  | { ok: false; reason: string };

export function decideAloNowRequestIntake(input: {
  insideDeliveryArea: boolean;
  shopAcceptingRequests: boolean;
  quoteStatus: QuoteStatus;
  cartVerified: boolean;
  driversOnline: number;
}): IntakeDecision {
  if (!input.shopAcceptingRequests)
    return {ok:false,reason:"SHOP_NOT_ACCEPTING_REQUESTS"};

  if (!input.insideDeliveryArea)
    return {ok:false,reason:"OUTSIDE_DELIVERY_AREA"};

  if (input.quoteStatus === "UNAVAILABLE")
    return {ok:false,reason:"DELIVERY_UNAVAILABLE"};

  if (!input.cartVerified)
    return {ok:false,reason:"CART_NOT_VERIFIED"};

  // Deliberately do not read driversOnline.
  // Zero drivers online does not block customer intake.
  return {ok:true,stage:"REQUEST_RECEIVED"};
}

export function decideAloNowPaymentReadiness(input: {
  requestAcceptedByMerchant: boolean;
  fulfillment: FulfillmentDecision;
  deliveryCapacityConfirmed: boolean;
  quoteStatus: QuoteStatus;
  finalTotalVerified: boolean;
  deliveryAddressVerified: boolean;
}): PaymentReadiness {
  if (!input.requestAcceptedByMerchant)
    return {ok:false,reason:"MERCHANT_ACCEPTANCE_REQUIRED"};

  if (input.fulfillment === "NOT_CONFIRMED" ||
      !input.deliveryCapacityConfirmed)
    return {ok:false,reason:"DELIVERY_CAPACITY_REQUIRED"};

  if (input.quoteStatus !== "STANDARD")
    return {ok:false,reason:"FINAL_DELIVERY_QUOTE_REQUIRED"};

  if (!input.finalTotalVerified)
    return {ok:false,reason:"FINAL_TOTAL_VERIFICATION_REQUIRED"};

  if (!input.deliveryAddressVerified)
    return {ok:false,reason:"DELIVERY_ADDRESS_REQUIRED"};

  return {
    ok:true,
    stage:"READY_FOR_PAYMENT_PREPARATION"
  };
}

export function publicAloNowRequestView(input: {
  requestId: string;
  status: "PENDING_REVIEW" | "ACCEPTED" | "REJECTED";
}) {
  return {
    requestId: input.requestId,
    status: input.status,
    message:
      input.status === "PENDING_REVIEW"
        ? "Wir prüfen deine Bestellung und bestätigen die Lieferung."
        : input.status === "ACCEPTED"
        ? "Deine Lieferung wurde bestätigt."
        : "Diese Lieferung können wir leider nicht übernehmen.",
    checkoutAllowed: false
  };
}

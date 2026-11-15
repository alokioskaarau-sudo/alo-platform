import { createHash } from "node:crypto";

/**
 * Internal finance decision only.
 *
 * IMPORTANT:
 * Input is NOT a payment verification.
 * A future trusted server-side adapter must retrieve and
 * verify the capture with the actual payment provider.
 *
 * Never construct this input directly from customer HTTP data.
 */

export type TipCreditInputV163 = {
  orderId: string;
  requestOrderId: string;
  delivered: boolean;

  assignedDriverUserId: string;
  earningDriverUserId: string;

  workspace: "AARAU" | "OLTEN";
  paymentProvider: "SHOPIFY";
  paymentPurpose: "POST_DELIVERY_TIP";

  captureId: string;
  captureOrderId: string;
  captureStatus: string;

  currency: string;
  amountRappen: number;
  refundedRappen: number;
};

export type TipCreditDecisionV163 =
  | {
      ok: false;
      reason: string;
    }
  | {
      ok: true;
      eventType: "ONLINE_TIP_EARNED";
      eventKey: string;
      orderId: string;
      driverUserId: string;
      workspace: "AARAU" | "OLTEN";
      amountRappen: number;
      currency: "CHF";
      sourceReference: string;
    };

const positiveId = /^[1-9][0-9]{0,18}$/;
const orderRef = /^[A-Za-z0-9:/_-]{1,180}$/;
const captureRef = /^[A-Za-z0-9:/_.-]{8,180}$/;

function blocked(reason: string): TipCreditDecisionV163 {
  return { ok: false, reason };
}

export function decideTipCreditV163(
  input: TipCreditInputV163
): TipCreditDecisionV163 {
  if (
    !orderRef.test(input.orderId) ||
    input.orderId !== input.requestOrderId ||
    input.orderId !== input.captureOrderId
  ) {
    return blocked("ORDER_BINDING_FAILED");
  }

  if (!input.delivered) {
    return blocked("DELIVERY_NOT_COMPLETED");
  }

  if (
    !positiveId.test(input.assignedDriverUserId) ||
    input.assignedDriverUserId !== input.earningDriverUserId
  ) {
    return blocked("DRIVER_BINDING_FAILED");
  }

  if (
    input.workspace !== "AARAU" &&
    input.workspace !== "OLTEN"
  ) {
    return blocked("INVALID_WORKSPACE");
  }

  if (
    input.paymentProvider !== "SHOPIFY" ||
    input.paymentPurpose !== "POST_DELIVERY_TIP" ||
    input.captureStatus !== "CAPTURED" ||
    !captureRef.test(input.captureId)
  ) {
    return blocked("CAPTURE_NOT_VERIFIED");
  }

  if (
    input.currency !== "CHF" ||
    !Number.isSafeInteger(input.amountRappen) ||
    input.amountRappen <= 0 ||
    !Number.isSafeInteger(input.refundedRappen) ||
    input.refundedRappen < 0 ||
    input.refundedRappen > input.amountRappen
  ) {
    return blocked("INVALID_PAYMENT_AMOUNT");
  }

  if (input.refundedRappen !== 0) {
    return blocked("CAPTURE_REFUNDED");
  }

  const sourceReference =
    `shopify-tip-capture:${input.captureId}`;

  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        input.paymentProvider,
        input.captureId,
        input.orderId
      ])
    )
    .digest("hex");

  return {
    ok: true,
    eventType: "ONLINE_TIP_EARNED",
    eventKey: `alo-now-tip:${digest}`,
    orderId: input.orderId,
    driverUserId: input.assignedDriverUserId,
    workspace: input.workspace,
    amountRappen: input.amountRappen,
    currency: "CHF",
    sourceReference
  };
}

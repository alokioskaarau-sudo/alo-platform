
import { db } from "../../database/db.js";
import {
  calculateAloNowExpectedTotal
} from "./aloNowShopifyOrderBinding.js";
import {
  evaluateAloNowShopifyPayment
} from "./aloNowShopifyPaymentEvidence.js";

export type ShopifyPaymentSnapshot = {
  id: string;
  displayFinancialStatus: string;
  cancelledAt: string | null;
  totalPriceSet: {
    shopMoney: {
      amount: string;
      currencyCode: string;
    };
  };
  // ALO_V1695C_REFUND_SNAPSHOT
  totalRefundedSet?: {
    shopMoney: {
      amount: string;
      currencyCode: string;
    };
  };
  // ALO_NOW_V869_OUTSTANDING_READER
  totalOutstandingSet?: {
    shopMoney: {
      amount: string;
      currencyCode: string;
    };
  };
};

export type ShopifyPaymentReader =
  (orderId: string) => Promise<ShopifyPaymentSnapshot | null>;

type ReadResult =
  | { ok: true; action: "CONFIRM" | "RECONCILE"; orderId: string }
  | { ok: false; reason: string };

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ORDER =
  /^gid:\/\/shopify\/Order\/[1-9][0-9]*$/;

/**
 * Server-internal read-only verification.
 *
 * The caller MUST inject a trusted Shopify Admin API reader.
 * Browser input or cached/untrusted order data is forbidden.
 *
 * No event, delivery permission, checkout URL or
 * payment confirmation is written by this function.
 */
export async function inspectAloNowBoundShopifyPayment(
  requestId: string,
  readShopifyOrder: ShopifyPaymentReader
): Promise<ReadResult> {
  if (!UUID.test(requestId))
    return { ok: false, reason: "INVALID_REQUEST_ID" };

  const result = await db.query<{
    request_id: string;
    order_id: string | null;
    phase: string;
    method: string | null;
    status: string;
    reservation_valid: boolean;
    subtotal: string | null;
    delivery_fee: string | null;
    verified_at: Date | null;
  }>(
    `SELECT r.id AS request_id,
            p.shopify_order_id AS order_id,
            p.phase,
            p.payment_method AS method,
            r.status,
            COALESCE(
              r.reservation_expires_at > clock_timestamp(),
              FALSE
            ) AS reservation_valid,
            r.verified_subtotal_chf::text AS subtotal,
            r.quoted_delivery_fee_chf::text AS delivery_fee,
            r.verified_at
     FROM alo_now_order_requests r
     JOIN alo_now_payment_states p
       ON p.request_id = r.id
     WHERE r.id = $1`,
    [requestId]
  );

  const record = result.rows[0];

  if (!record)
    return { ok: false, reason: "REQUEST_OR_PAYMENT_NOT_FOUND" };

  if (
    record.phase !== "AWAITING_PAYMENT" ||
    record.method !== "ONLINE"
  )
    return { ok: false, reason: "ONLINE_PAYMENT_NOT_AWAITED" };

  if (!record.order_id || !ORDER.test(record.order_id))
    return { ok: false, reason: "SHOPIFY_ORDER_NOT_BOUND" };

  if (
    !record.verified_at ||
    record.subtotal === null ||
    record.delivery_fee === null
  )
    return { ok: false, reason: "VERIFIED_QUOTE_MISSING" };

  const expectedTotal = calculateAloNowExpectedTotal(
    record.subtotal,
    record.delivery_fee
  );

  if (!expectedTotal)
    return { ok: false, reason: "VERIFIED_TOTAL_INVALID" };

  let shopify: ShopifyPaymentSnapshot | null;

  try {
    shopify = await readShopifyOrder(record.order_id);
  } catch {
    return { ok: false, reason: "SHOPIFY_LOOKUP_FAILED" };
  }

  if (!shopify)
    return { ok: false, reason: "SHOPIFY_ORDER_NOT_FOUND" };

  if (shopify.cancelledAt)
    return { ok: false, reason: "SHOPIFY_ORDER_CANCELLED" };

  if (
    !shopify.totalPriceSet ||
    !shopify.totalPriceSet.shopMoney
  )
    return { ok: false, reason: "SHOPIFY_TOTAL_MISSING" };

  const evaluated = evaluateAloNowShopifyPayment({
    requestId,
    linkedRequestId: record.request_id,
    expectedOrderId: record.order_id,
    actualOrderId: shopify.id,
    financialStatus: shopify.displayFinancialStatus,
    currencyCode: shopify.totalPriceSet.shopMoney.currencyCode,
    expectedTotalChf: expectedTotal,
    actualTotalChf: shopify.totalPriceSet.shopMoney.amount,
    reservationValid:
      record.status === "DRIVER_ACCEPTED" &&
      record.reservation_valid
  });

  if (!evaluated.ok)
    return { ok: false, reason: evaluated.reason };

  return {
    ok: true,
    action: evaluated.action,
    orderId: record.order_id
  };
}

import { db } from "../../database/db.js";
import {
  readAloNowLiveShopifyProvenance
} from "./aloNowLiveShopifyProvenanceReader.js";
import type {
  AloNowOrderProvenance
} from "./aloNowOrderProvenance.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORDER =
  /^gid:\/\/shopify\/Order\/[1-9][0-9]*$/;

export type AloNowPreflightRecord = {
  request_id: string;
  checkout_reference: string;
  intent_order_id: string | null;
  payment_order_id: string | null;
  phase: string;
  payment_method: string | null;
  used_elsewhere: boolean;
};

export type AloNowBindingPreflightResult =
  | { ok: true; requestId: string; shopifyOrderId: string }
  | { ok: false; reason: string };

export type AloNowPreflightLoader = (
  requestId: string,
  orderId: string
) => Promise<AloNowPreflightRecord | null>;

export type AloNowPreflightReader = (
  orderId: string
) => Promise<AloNowOrderProvenance | null>;

/**
 * Read-only preflight.
 * Matching Shopify customAttributes alone is NOT proof
 * of an authenticated server-created checkout.
 * Final binding must repeat checks under DB locks.
 */
export function createAloNowBindingPreflight(
  load: AloNowPreflightLoader,
  read: AloNowPreflightReader
) {
  return async (
    requestId: string,
    orderId: string
  ): Promise<AloNowBindingPreflightResult> => {
    if (!UUID.test(requestId))
      return { ok: false, reason: "INVALID_REQUEST_ID" };

    if (!ORDER.test(orderId))
      return { ok: false, reason: "INVALID_ORDER_ID" };

    let record: AloNowPreflightRecord | null;
    try {
      record = await load(requestId, orderId);
    } catch {
      return { ok: false, reason: "DATABASE_LOOKUP_FAILED" };
    }

    if (!record)
      return { ok: false, reason: "CHECKOUT_INTENT_NOT_FOUND" };

    if (
      record.request_id !== requestId ||
      !UUID.test(record.checkout_reference)
    )
      return { ok: false, reason: "INTENT_INVALID" };

    // V2504: A confirmed payment may be resumed only when
    // BOTH persisted checkout identities already point to
    // this exact Shopify order. Never create a new binding
    // through the confirmed-payment recovery path.
    const firstPayment = record.phase === "AWAITING_PAYMENT";

    const confirmedResume =
      record.phase === "PAYMENT_CONFIRMED" &&
      record.intent_order_id === orderId &&
      record.payment_order_id === orderId;

    if (
      record.payment_method !== "ONLINE" ||
      (!firstPayment && !confirmedResume)
    )
      return { ok: false, reason: "PAYMENT_STATE_INVALID" };

    if (record.used_elsewhere)
      return { ok: false, reason: "ORDER_USED_ELSEWHERE" };

    if (
      (record.intent_order_id !== null &&
       record.intent_order_id !== orderId) ||
      (record.payment_order_id !== null &&
       record.payment_order_id !== orderId)
    )
      return { ok: false, reason: "EXISTING_BINDING_CONFLICT" };

    let shopify: AloNowOrderProvenance | null;
    try {
      shopify = await read(orderId);
    } catch {
      return { ok: false, reason: "SHOPIFY_LOOKUP_FAILED" };
    }

    if (!shopify)
      return { ok: false, reason: "SHOPIFY_ORDER_NOT_FOUND" };

    if (shopify.id !== orderId)
      return { ok: false, reason: "SHOPIFY_ORDER_MISMATCH" };

    if (
      shopify.aloNowRequestId !== requestId ||
      shopify.aloNowCheckoutReference !== record.checkout_reference
    )
      return { ok: false, reason: "PROVENANCE_MISMATCH" };

    return { ok: true, requestId, shopifyOrderId: orderId };
  };
}

export const preflightAloNowOrderBinding =
  createAloNowBindingPreflight(
    async (requestId, orderId) => {
      const result = await db.query<AloNowPreflightRecord>(
        `SELECT i.request_id::text,
                i.checkout_reference::text,
                i.shopify_order_id AS intent_order_id,
                p.shopify_order_id AS payment_order_id,
                p.phase,
                p.payment_method,
                (
                  EXISTS (
                    SELECT 1 FROM alo_now_checkout_intents other
                    WHERE other.shopify_order_id = $2
                      AND other.request_id <> $1::uuid
                  )
                  OR EXISTS (
                    SELECT 1 FROM alo_now_payment_states other
                    WHERE other.shopify_order_id = $2
                      AND other.request_id <> $1::uuid
                  )
                ) AS used_elsewhere
         FROM alo_now_checkout_intents i
         JOIN alo_now_payment_states p
           ON p.request_id = i.request_id
         WHERE i.request_id = $1::uuid`,
        [requestId, orderId]
      );
      return result.rows[0] ?? null;
    },
    readAloNowLiveShopifyProvenance
  );

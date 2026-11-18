import { authorizeAloNowDeliveryV332 } from "./aloNowDeliveryAuthorization.v332.js";
import { randomUUID } from "node:crypto";
import { db } from "../../database/db.js";
import type {
  VerifiedAloCart
} from "./aloNowShopifyCartGuard.service.js";
import {
  buildAloNowDraftOrderPayload
} from "./aloNowDraftOrderPayload.js";
import {
  buildAloNowDraftGraphqlRequest
} from "./aloNowDraftOrderAdapter.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type StoredItem = {
  variantId: string;
  quantity: number;
  unitPriceCHF: number;
  title: string;
};

type RequestRow = {
  workspace: string;
  status: string;
  driver_user_id: string | null;
  reservation_valid: boolean;
  quote_status: string;
  verified_at: Date | null;
  verified_subtotal_chf: string | null;
  quoted_delivery_fee_chf: string | null;
  items: unknown;
};

type PaymentRow = {
  phase: string;
  payment_method: string | null;
  shopify_order_id: string | null;
};

type IntentRow = {
  checkout_reference: string;
  shopify_order_id: string | null;
};

type OperationRow = {
  status: string;
  expected_total_chf: string;
};

export type AloNowDraftClaimResult =
  | {
      ok: true;
      attemptId: string;
      requestId: string;
      checkoutReference: string;
      expectedTotalCHF: string;
      graphql: ReturnType<typeof buildAloNowDraftGraphqlRequest>;
    }
  | { ok: false; reason: string };

type CartReader = (
  items: Array<{ variantId: string; quantity: number }>
) => Promise<VerifiedAloCart>;

/**
 * Internal service only. NO Shopify mutations.
 *
 * Returns a one-time claimed operation, but never sends it.
 * The caller must persist the outcome with the same attemptId.
 * A missing or uncertain outcome must not be retried blindly.
 */
export function createAloNowDraftClaimService(readCart: CartReader) {
  return async function claim(
    requestId: string
  ): Promise<AloNowDraftClaimResult> {
    if (!UUID.test(requestId))
      return { ok: false, reason: "INVALID_REQUEST_ID" };

    // First read: obtain variant IDs only. This data is untrusted
    // until all relevant fields are rechecked under row locks.
    const snapshot = await db.query<{ items: unknown }>(
      `SELECT items FROM alo_now_order_requests WHERE id=$1`,
      [requestId]
    );

    if (!snapshot.rows[0])
      return { ok: false, reason: "REQUEST_NOT_FOUND" };

    const raw = snapshot.rows[0].items;
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > 15)
      return { ok: false, reason: "INVALID_STORED_ITEMS" };

    const lines: Array<{variantId:string;quantity:number}> = [];
    const seen = new Set<string>();

    for (const value of raw) {
      if (!value || typeof value !== "object" ||
          Array.isArray(value))
        return { ok: false, reason: "INVALID_STORED_ITEMS" };

      const item = value as StoredItem;

      if (typeof item.variantId !== "string" ||
          !/^gid:\/\/shopify\/ProductVariant\/[1-9][0-9]*$/.test(
            item.variantId
          ) ||
          !Number.isInteger(item.quantity) ||
          item.quantity < 1 || item.quantity > 30 ||
          seen.has(item.variantId))
        return { ok: false, reason: "INVALID_STORED_ITEMS" };

      seen.add(item.variantId);
      lines.push({
        variantId: item.variantId,
        quantity: item.quantity
      });
    }

    // Read-only Shopify validation. Reject stale or unavailable stock,
    // age-restricted products, and price discrepancies.
    let freshCart: VerifiedAloCart;

    try {
      freshCart = await readCart(lines);
    } catch {
      return { ok: false, reason: "FRESH_CART_VALIDATION_FAILED" };
    }

    const client = await db.connect();
    let active = false;
    let destroy = false;

    try {
      await client.query("BEGIN");
      active = true;

      await client.query("SET LOCAL lock_timeout = '3s'");
      await client.query("SET LOCAL statement_timeout = '12s'");

      // Lock parent, payment, intent, operation in a fixed order.
      const request = await client.query<RequestRow>(
        `SELECT workspace,status,driver_user_id,quote_status,verified_at,
                verified_subtotal_chf::text,
                quoted_delivery_fee_chf::text,
                items,
                COALESCE(
                  reservation_expires_at > clock_timestamp(),
                  FALSE
                ) AS reservation_valid
         FROM alo_now_order_requests
         WHERE id=$1 FOR UPDATE`,
        [requestId]
      );

      const r = request.rows[0];
      if (!r)
        return { ok: false, reason: "REQUEST_NOT_FOUND" };
        // V2443: ALO NOW pilot is exclusively Aarau.
        // Checked inside the locked checkout transaction.
        if (r.workspace !== "AARAU") {
          return {
            ok: false,
            reason: "ALO_NOW_AARAU_ONLY_CHECKOUT"
          };
        }


      // ALO_NOW_V333C_DELIVERY_GUARD
      // Parent request locked before checking delivery.
      const delivery = await authorizeAloNowDeliveryV332(
        client, requestId, r
      );
      if (!delivery.ok) {
        const reason =
          delivery.reason === "DELIVERY_CONFIRMATION_REQUIRED"
            ? "DRIVER_RESERVATION_REQUIRED"
            : delivery.reason;
        return { ok:false, reason };
      }

      if (r.quote_status !== "STANDARD" ||
          !r.verified_at ||
          r.verified_subtotal_chf === null ||
          r.quoted_delivery_fee_chf === null)
        return { ok: false, reason: "VERIFIED_QUOTE_REQUIRED" };

      const payment = await client.query<PaymentRow>(
        `SELECT phase,payment_method,shopify_order_id
         FROM alo_now_payment_states
         WHERE request_id=$1 FOR UPDATE`,
        [requestId]
      );

      const p = payment.rows[0];
      if (!p || p.phase !== "AWAITING_PAYMENT" ||
          p.payment_method !== "ONLINE" ||
          p.shopify_order_id !== null)
        return { ok: false, reason: "ONLINE_PAYMENT_NOT_READY" };

      const intent = await client.query<IntentRow>(
        `SELECT checkout_reference::text,shopify_order_id
         FROM alo_now_checkout_intents
         WHERE request_id=$1 FOR UPDATE`,
        [requestId]
      );

      const i = intent.rows[0];
      if (!i || !UUID.test(i.checkout_reference) ||
          i.shopify_order_id !== null)
        return { ok: false, reason: "CHECKOUT_INTENT_NOT_READY" };

      // The immutable stored cart is checked against the fresh read.
      // This also catches a change between the initial query and
      // transaction acquisition.
      let built: ReturnType<typeof buildAloNowDraftOrderPayload>;
      let graphql: ReturnType<typeof buildAloNowDraftGraphqlRequest>;

      try {
        built = buildAloNowDraftOrderPayload({
          requestId,
          checkoutReference: i.checkout_reference,
          storedItems: r.items,
          freshCart,
          verifiedSubtotalCHF: r.verified_subtotal_chf,
          deliveryFeeCHF: r.quoted_delivery_fee_chf
        });
        graphql = buildAloNowDraftGraphqlRequest(built.draftInput);
      } catch {
        return { ok: false, reason: "CART_OR_TOTAL_CHANGED" };
      }

      await client.query(
        `INSERT INTO alo_now_draft_operations (
           request_id,checkout_reference,expected_total_chf
         )
         VALUES ($1,$2,$3)
         ON CONFLICT (request_id) DO NOTHING`,
        [requestId,i.checkout_reference,built.expectedTotalCHF]
      );

      const state = await client.query<OperationRow>(
        `SELECT status,expected_total_chf::text
         FROM alo_now_draft_operations
         WHERE request_id=$1 FOR UPDATE`,
        [requestId]
      );

      const s = state.rows[0];
      if (!s || s.status !== "PREPARED")
        return { ok: false, reason: "DRAFT_ALREADY_CLAIMED" };

      if (s.expected_total_chf !== built.expectedTotalCHF)
        return { ok: false, reason: "DRAFT_TOTAL_CONFLICT" };

      // ALO_NOW_V333C_FINAL_CAPACITY_CHECK
      // Verify chosen delivery method immediately before claim.
      // V2699: Avoid referencing optional merchant table in the SQL parser
      // when a driver's own active reservation is sufficient.
      let valid: { rows: Array<{valid:boolean}> };
      if (delivery.method === 'ASSIGNED_DRIVER') {
        valid = await client.query<{valid:boolean}>(`
          SELECT EXISTS (
            SELECT 1 FROM alo_now_order_requests r
            WHERE r.id=$1
              AND r.status='DRIVER_ACCEPTED'
              AND r.driver_user_id IS NOT NULL
              AND r.reservation_expires_at>clock_timestamp()
          ) AS valid
        `,[requestId]);
      } else {
        const merchantTable = await client.query<{present:boolean}>(
          `SELECT to_regclass('public.alo_now_merchant_acceptances') IS NOT NULL AS present`
        );
        if (!merchantTable.rows[0]?.present) {
          return { ok:false, reason:'MERCHANT_ACCEPTANCE_UNAVAILABLE' };
        }
        valid = await client.query<{valid:boolean}>(`
          SELECT EXISTS (
            SELECT 1
            FROM alo_now_merchant_acceptances m
            JOIN alo_now_order_requests r ON r.id=m.request_id
            WHERE m.request_id=$1
              AND r.status IN ('PENDING_REVIEW','CONTACTED')
              AND m.fulfillment_method='INTERNAL_DELIVERY'
              AND btrim(m.accepted_by)<>''
              AND m.assigned_driver_id IS NULL
              AND m.capacity_confirmed_at<=clock_timestamp()
              AND m.capacity_confirmed_until>clock_timestamp()
          ) AS valid
        `,[requestId]);
      }

      if (!valid.rows[0]?.valid)
        return { ok: false, reason: "RESERVATION_EXPIRED" };

      const attemptId = randomUUID();

      const claimed = await client.query(
        `UPDATE alo_now_draft_operations
         SET status='CREATING',attempt_id=$2
         WHERE request_id=$1 AND status='PREPARED'
         RETURNING request_id`,
        [requestId,attemptId]
      );

      if (claimed.rowCount !== 1)
        return { ok: false, reason: "DRAFT_CLAIM_CONFLICT" };

      await client.query("COMMIT");
      active = false;

      return {
        ok: true,
        attemptId,
        requestId,
        checkoutReference: i.checkout_reference,
        expectedTotalCHF: built.expectedTotalCHF,
        graphql
      };
    } catch {
      destroy = true;
      return { ok: false, reason: "DRAFT_CLAIM_UNAVAILABLE" };
    } finally {
      if (active) {
        try {
          await client.query("ROLLBACK");
        } catch {
          destroy = true;
        }
      }
      client.release(destroy);
    }
  };
}

export async function claimAloNowDraftOperation(
  requestId: string
): Promise<AloNowDraftClaimResult> {
  const { verifyAloNowShopifyCart } =
    await import("./aloNowShopifyCartGuard.service.js");

  return createAloNowDraftClaimService(
    verifyAloNowShopifyCart
  )(requestId);
}


import { randomUUID } from "node:crypto";
import {
  authorizeAloNowDeliveryV332
} from "./aloNowDeliveryAuthorization.v332.js";
import { db } from "../../database/db.js";
import {
  inspectShopifyWalletPaymentV1692
} from "./aloNowWalletShopifyGuard.v1692.js";
import type {
  ShopifyWalletSnapshotV1692
} from "./aloNowWalletShopifyGuard.v1692.js";

import {
  evaluateAloNowShopifyPayment
} from "./aloNowShopifyPaymentEvidence.js";
import {
  calculateAloNowExpectedTotal
} from "./aloNowShopifyOrderBinding.js";
import {
  transitionAloNowPayment
} from "./aloNowPaymentLifecycle.js";
import type {
  ShopifyPaymentReader,
  ShopifyPaymentSnapshot
} from "./aloNowTrustedPaymentVerification.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Result =
  | {
      ok: true;
      action: "CONFIRMED" | "ALREADY_CONFIRMED" | "RECONCILE";
      version?: number;
    }
  | { ok: false; reason: string };

type LockedRow = {
  request_id: string;
  status: string;
  reservation_valid: boolean;
  driver_user_id: string | null;
  quote_status: string;
  verified_at: Date | null;
  subtotal: string | null;
  fee: string | null;
  payment_id: string;
  phase: string;
  method: string | null;
  order_id: string | null;
  version: number;
};

function decide(
  requestId: string,
  row: LockedRow,
  order: ShopifyPaymentSnapshot,
  deliveryAuthorized: boolean
) {
  if (order.cancelledAt) {
    return { ok: false as const, reason: "SHOPIFY_ORDER_CANCELLED" };
  }

  // ALO_NOW_V362_DELIVERY_AUTHORIZATION
  // Delivery is checked under the request lock before decide().
  // Shopify payment identity, CHF and totals remain mandatory.

  const expected =
    row.subtotal !== null && row.fee !== null && row.verified_at
      ? calculateAloNowExpectedTotal(row.subtotal, row.fee)
      : null;

  if (!expected || !row.order_id || !order.totalPriceSet?.shopMoney) {
    return { ok: false as const, reason: "PAYMENT_EVIDENCE_INCOMPLETE" };
  }

  // ALO_V1702_PAYMENT_REFUND_GATE
  // Verify payment completeness before confirming or reconciling.
  // No missing fields are interpreted as zero.
  const refundCheck = inspectShopifyWalletPaymentV1692(
    row.order_id,
    order as unknown as ShopifyWalletSnapshotV1692
  );

  if (refundCheck.status !== "PAYMENT_PRECHECK_PASSED") {
    return {
      ok: false as const,
      reason: refundCheck.reason ??
        "SHOPIFY_REFUND_PRECHECK_FAILED"
    };
  }

  return evaluateAloNowShopifyPayment({
    requestId,
    linkedRequestId: row.request_id,
    expectedOrderId: row.order_id,
    actualOrderId: order.id,
    financialStatus: order.displayFinancialStatus,
    currencyCode: order.totalPriceSet.shopMoney.currencyCode,
    expectedTotalChf: expected,
    actualTotalChf: order.totalPriceSet.shopMoney.amount,
    reservationValid:
      deliveryAuthorized &&
      row.quote_status === "STANDARD"
  });
}

/**
 * Internal only. Must be invoked with a trusted Shopify
 * Admin API reader, never a browser-supplied snapshot.
 *
 * No Shopify write, no checkout and no delivery dispatch.
 */
export async function commitVerifiedAloNowOnlinePayment(
  requestId: string,
  readShopifyOrder: ShopifyPaymentReader
): Promise<Result> {
  if (!UUID.test(requestId))
    return { ok: false, reason: "INVALID_REQUEST_ID" };

  // Prefetch outside the database transaction.
  const preliminary = await db.query<{
    order_id: string | null;
  }>(
    `SELECT p.shopify_order_id AS order_id
     FROM alo_now_payment_states p
     WHERE p.request_id = $1`,
    [requestId]
  );

  const orderId = preliminary.rows[0]?.order_id;
  if (!orderId || !/^gid:\/\/shopify\/Order\/[1-9]\d*$/.test(orderId)) {
    return { ok: false, reason: "SHOPIFY_ORDER_NOT_BOUND" };
  }

  let shopify: ShopifyPaymentSnapshot | null;
  try {
    shopify = await readShopifyOrder(orderId);
  } catch {
    return { ok: false, reason: "SHOPIFY_LOOKUP_FAILED" };
  }

  if (!shopify)
    return { ok: false, reason: "SHOPIFY_ORDER_NOT_FOUND" };

  const client = await db.connect();
  let active = false;
  let destroy = false;

  try {
    await client.query("BEGIN");
    active = true;

    // Same parent-first lock order as the existing lifecycle.
    const request = await client.query<{
      id: string;
      status: string;
      reservation_valid: boolean;
      driver_user_id: string | null;
      quote_status: string;
      verified_at: Date | null;
      subtotal: string | null;
      fee: string | null;
    }>(
      `SELECT id,status,verified_at,
               driver_user_id,quote_status,
              verified_subtotal_chf::text AS subtotal,
              quoted_delivery_fee_chf::text AS fee,
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

    // ALO_NOW_V362_DELIVERY_AUTHORIZATION
    // Request is already FOR UPDATE. Merchant capacity is checked
    // inside the same transaction, before locking payment state.
    const delivery = await authorizeAloNowDeliveryV332(
      client,
      requestId,
      r
    );
    const deliveryAuthorized = delivery.ok;

    const payment = await client.query<{
      id: string;
      phase: string;
      payment_method: string | null;
      shopify_order_id: string | null;
      version: number;
    }>(
      `SELECT id,phase,payment_method,shopify_order_id,version
       FROM alo_now_payment_states
       WHERE request_id=$1 FOR UPDATE`,
      [requestId]
    );

    const p = payment.rows[0];
    if (!p)
      return { ok: false, reason: "PAYMENT_STATE_MISSING" };

    if (p.shopify_order_id !== orderId)
      return { ok: false, reason: "ORDER_BINDING_CHANGED" };

    const row: LockedRow = {
      request_id: r.id,
      status: r.status,
        reservation_valid: r.reservation_valid,
        driver_user_id: r.driver_user_id,
        quote_status: r.quote_status,
      verified_at: r.verified_at,
      subtotal: r.subtotal,
      fee: r.fee,
      payment_id: p.id,
      phase: p.phase,
      method: p.payment_method,
      order_id: p.shopify_order_id,
      version: p.version
    };

    const evidence = decide(
      requestId,
      row,
      shopify,
      deliveryAuthorized
    );

    if (!evidence.ok)
      return { ok: false, reason: evidence.reason };

    if (
      p.phase === "PAYMENT_CONFIRMED" &&
      p.payment_method === "ONLINE"
    ) {
      await client.query("COMMIT");
      active = false;
      return {
        ok: true,
        action: "ALREADY_CONFIRMED",
        version: p.version
      };
    }

    if (
      p.phase !== "AWAITING_PAYMENT" ||
      p.payment_method !== "ONLINE"
    ) {
      return { ok: false, reason: "PAYMENT_STATE_NOT_READY" };
    }

    // ALO_V277_PERSIST_RECONCILIATION
    // Paid Shopify order, but the driver reservation is no
    // longer valid. Persist the case before acknowledging it.
    if (evidence.action === "RECONCILE") {
      if (
        !row.order_id ||
        row.subtotal === null ||
        row.fee === null ||
        !row.verified_at
      ) {
        return {
          ok: false,
          reason: "RECONCILIATION_EVIDENCE_MISSING"
        };
      }

      const expectedTotalChf = calculateAloNowExpectedTotal(
        row.subtotal,
        row.fee
      );

      if (!expectedTotalChf) {
        return {
          ok: false,
          reason: "RECONCILIATION_TOTAL_INVALID"
        };
      }

      const recorded = await client.query(
        `INSERT INTO alo_now_payment_reconciliations (
           id,
           request_id,
           shopify_order_id,
           expected_total_chf,
           reason,
           status
         ) VALUES (
           $1,$2,$3,$4,'RESERVATION_EXPIRED','OPEN'
         )
         ON CONFLICT (request_id, shopify_order_id)
         DO UPDATE SET
           last_detected_at = NOW()
         WHERE alo_now_payment_reconciliations.status
           IN ('OPEN','IN_REVIEW')
         RETURNING id`,
        [
          randomUUID(),
          requestId,
          row.order_id,
          expectedTotalChf
        ]
      );

      // A previously resolved case must not silently reopen.
      if (recorded.rowCount !== 1) {
        return {
          ok: false,
          reason: "RECONCILIATION_ALREADY_RESOLVED"
        };
      }

      await client.query("COMMIT");
      active = false;

      // No payment phase change and no driver dispatch.
      return { ok: true, action: "RECONCILE" };
    }

    const next = transitionAloNowPayment(
      { phase: "AWAITING_PAYMENT", method: "ONLINE" },
      { type: "ONLINE_PAYMENT_VERIFIED" }
    );

    if (!next.ok)
      return { ok: false, reason: next.reason };

    const version = p.version + 1;

    const updated = await client.query(
      `UPDATE alo_now_payment_states
       SET phase=$2,
           payment_method=$3,
           version=$4,
           updated_at=NOW()
       WHERE id=$1 AND version=$5
         AND phase='AWAITING_PAYMENT'
         AND payment_method='ONLINE'
         AND shopify_order_id=$6`,
      [
        p.id,
        next.state.phase,
        next.state.method,
        version,
        p.version,
        orderId
      ]
    );

    if (updated.rowCount !== 1)
      throw new Error("PAYMENT_VERSION_CONFLICT");

    await client.query(
      `INSERT INTO alo_now_payment_events
       (id,payment_state_id,event_type,
        previous_phase,next_phase,actor_type,
        actor_id,source_reference,resulting_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        randomUUID(),
        p.id,
        "ONLINE_PAYMENT_VERIFIED",
        "AWAITING_PAYMENT",
        "PAYMENT_CONFIRMED",
        "SHOPIFY",
        null,
        orderId,
        version
      ]
    );

    await client.query("COMMIT");
    active = false;

    return { ok: true, action: "CONFIRMED", version };
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
}

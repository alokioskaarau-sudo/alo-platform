// ALO_V1570_HANDOFF_RESERVATION
// Internal service, NOT connected to an HTTP endpoint.
// Requires V1566 database migration before runtime use.
// Does not execute Shopify mutations or refunds.

import { db } from "../../database/db.js";
import { createHash } from "node:crypto";
import { getShopifyOrderById } from "../../integrations/shopify/orders.js";
import { getFulfillmentOrdersForOrder } from "../../integrations/shopify/fulfillment.js";
import { getOrderFulfillmentType } from "../orders/orderFulfillmentType.js";

import {
  previewShopifyHandoffV1563,
} from "./aloNowShopifyHandoffAdapter.v1563.js";
import {
  preparePartialFulfillmentV1564,
} from "./aloNowPartialFulfillment.v1564.js";

export type UnverifiedRefusalReasonV1570 =
  | "NO_ID"
  | "IDENTITY_UNCLEAR"
  | "DOCUMENT_INVALID"
  | "TECHNICAL_FAILURE"
  | "UNDERAGE";

// ALO_V1571_SHARED_ORDER_LOCK
// Same advisory-lock namespace as legacy full delivery.
// Refresh authoritative Shopify data while holding the lock.
// Never trust client-supplied order or fulfillment snapshots.
export async function reserveUnverifiedPartialHandoffV1570(
  input: {
    shopifyOrderId: string;
    staffUserId: string;
    shopifyOrder: any;
    fulfillmentOrders: any;
    refusalReason: UnverifiedRefusalReasonV1570;
  }
) {
  const orderId = input.shopifyOrderId?.trim();

  if (!orderId) {
    throw new Error("SHOPIFY_ORDER_ID_REQUIRED");
  }

  const key = createHash("sha256")
    .update("ALO_NOW_DELIVERY_COMPLETION_V1:")
    .update(orderId)
    .digest()
    .readBigInt64BE(0)
    .toString();

  const lockClient = await db.connect();
  let locked = false;
  let unlocked = false;

  try {
    await lockClient.query(
      "SELECT pg_advisory_lock($1::bigint)",
      [key]
    );
    locked = true;

    const freshOrder = await getShopifyOrderById(orderId);

    if (!freshOrder || freshOrder.id !== orderId) {
      throw new Error("SHOPIFY_ORDER_NOT_FOUND_OR_MISMATCH");
    }

    if (getOrderFulfillmentType(freshOrder) !== "ALO_NOW") {
      throw new Error("ORDER_IS_NOT_ALO_NOW");
    }

    const freshFulfillmentData =
      await getFulfillmentOrdersForOrder(orderId);

    if (freshFulfillmentData?.id !== orderId) {
      throw new Error("FULFILLMENT_ORDER_ID_MISMATCH");
    }

    return await reserveUnverifiedPartialHandoffInternalV1571({
      ...input,
      shopifyOrderId: orderId,
      shopifyOrder: freshOrder,
      fulfillmentOrders: freshFulfillmentData.fulfillmentOrders,
    });
  } finally {
    if (locked) {
      try {
        const result = await lockClient.query<{
          released: boolean;
        }>(
          "SELECT pg_advisory_unlock($1::bigint) AS released",
          [key]
        );
        unlocked = result.rows[0]?.released === true;
      } catch {
        unlocked = false;
      }
    }

    // Destroy uncertain lock-owning connections.
    lockClient.release(!unlocked);
  }
}

async function reserveUnverifiedPartialHandoffInternalV1571(
  input: {
    shopifyOrderId: string;
    staffUserId: string;
    shopifyOrder: any;
    fulfillmentOrders: any;
    refusalReason: UnverifiedRefusalReasonV1570;
  }
) {
  const orderId = input.shopifyOrderId?.trim();
  const staffId = input.staffUserId?.trim();

  if (!orderId || !/^[1-9]\d*$/.test(staffId ?? "")) {
    throw new Error("INVALID_RESERVATION_IDENTITY");
  }

  if (input.shopifyOrder?.id !== orderId) {
    throw new Error("SHOPIFY_ORDER_ID_MISMATCH");
  }

  const allowedReasons = [
    "NO_ID",
    "IDENTITY_UNCLEAR",
    "DOCUMENT_INVALID",
    "TECHNICAL_FAILURE",
    "UNDERAGE",
  ];

  if (!allowedReasons.includes(input.refusalReason)) {
    throw new Error("INVALID_REFUSAL_REASON");
  }

  // Never accept a driver's proposed age level.
  // Recalculate from the Shopify order at level zero.
  const preview = previewShopifyHandoffV1563(
    input.shopifyOrder,
    0
  );

  if (
    !preview.plan.partial ||
    preview.plan.blocked ||
    preview.plan.withheld.length === 0
  ) {
    throw new Error("NOT_AN_UNVERIFIED_PARTIAL_HANDOFF");
  }

  // Validate Shopify quantities before recording anything.
  const fulfillmentPlan = preparePartialFulfillmentV1564(
    preview.plan,
    input.fulfillmentOrders
  );

  if (fulfillmentPlan.length === 0) {
    throw new Error("NO_DELIVERABLE_FULFILLMENT_LINES");
  }

  const client = await db.connect();
  let transactionStarted = false;

  try {
    await client.query("BEGIN");
    transactionStarted = true;

    // Lock the delivery row to serialize local reservations.
    const deliveryResult = await client.query<{
      assigned_driver_user_id: string | null;
      delivery_status: string;
      age_verification_status: string;
    }>(
      `
        SELECT assigned_driver_user_id,
               delivery_status,
               age_verification_status
        FROM alo_now_deliveries
        WHERE shopify_order_id = $1
        FOR UPDATE
      `,
      [orderId]
    );

    const delivery = deliveryResult.rows[0];

    if (!delivery) {
      throw new Error("ALO_NOW_DELIVERY_NOT_FOUND");
    }

    if (
      String(delivery.assigned_driver_user_id) !==
      staffId
    ) {
      throw new Error("NOT_ASSIGNED_TO_DRIVER");
    }

    if (delivery.delivery_status !== "ON_THE_WAY") {
      throw new Error("INVALID_DELIVERY_STATUS");
    }

    // An already verified handoff cannot be silently
    // replaced with an unverified refusal.
    if (
      delivery.age_verification_status ===
      "VERIFIED_AT_HANDOFF"
    ) {
      throw new Error("EXISTING_AGE_VERIFICATION");
    }

    const inserted = await client.query<{
      shopify_order_id: string;
      handoff_state: string;
    }>(
      `
        INSERT INTO alo_now_handoff_ledger (
          shopify_order_id,
          assigned_driver_user_id,
          verified_age_level,
          handoff_state,
          delivered_lines,
          withheld_lines,
          refusal_reason,
          settlement_state
        )
        VALUES (
          $1, $2::bigint, NULL, 'PREPARED',
          $3::jsonb, $4::jsonb,
          $5, 'NOT_STARTED'
        )
        ON CONFLICT (shopify_order_id) DO NOTHING
        RETURNING shopify_order_id, handoff_state
      `,
      [
        orderId,
        staffId,
        JSON.stringify(preview.plan.delivered),
        JSON.stringify(preview.plan.withheld),
        input.refusalReason,
      ]
    );

    if (inserted.rowCount !== 1) {
      throw new Error("HANDOFF_ALREADY_RESERVED");
    }

    await client.query("COMMIT");
    transactionStarted = false;

    return {
      ok: true as const,
      mode: "RESERVED_NOT_DELIVERED" as const,
      shopifyOrderId: orderId,
      verifiedAgeLevel: 0 as const,
      handoffState: "PREPARED" as const,
      delivered: preview.plan.delivered,
      withheld: preview.plan.withheld,
      fulfillmentPlan,
      shopifyExecuted: false as const,
      refundExecuted: false as const,
    };
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
        transactionStarted = false;
      } catch {
        client.release(true);
        throw error;
      }
    }
    throw error;
  } finally {
    if (!transactionStarted) {
      client.release();
    }
  }
}

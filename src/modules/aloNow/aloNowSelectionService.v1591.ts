// ALO_NOW_V1591_SHARED_LOCK_RESERVATION
// Separate integration service, NOT exposed via HTTP.
// Does not call Shopify mutations, refunds or delivery completion.
// Only explicit future confirmation may invoke this service.

import {createHash} from "node:crypto";
import {db} from "../../database/db.js";
import {
  getAloNowDelivery,
} from "../../database/aloNowDeliveries.js";
import {
  getOrderFulfillmentWorkflow,
} from "../../database/orderFulfillmentWorkflow.js";
import {
  getShopifyOrderById,
} from "../../integrations/shopify/orders.js";
import {
  getFulfillmentOrdersForOrder,
} from "../../integrations/shopify/fulfillment.js";
import {
  getOrderFulfillmentType,
} from "../orders/orderFulfillmentType.js";
import {
  previewShopifyHandoffV1563,
} from "./aloNowShopifyHandoffAdapter.v1563.js";
import {
  buildHandoffSelectionV1584,
  type RequestedWithheldV1584,
} from "./aloNowHandoffSelection.v1584.js";
import {
  prepareSplitFulfillmentV1585,
} from "./aloNowSplitFulfillment.v1585.js";
import {
  persistSelectionUnderLockV1589,
  type ReservationInputV1589,
} from "./aloNowSelectionReservation.v1589.js";

export type AgeFailureReasonV1591 =
  ReservationInputV1589["reason"];

export type SelectionRequestV1591 = {
  shopifyOrderId: string;
  staffUserId: string;
  reason: AgeFailureReasonV1591;
  requestedWithheld: RequestedWithheldV1584[];
};

// Pure validation. Never trusts client-supplied age classes.
export function validateSelectionRequestV1591(
  input: SelectionRequestV1591
): void {
  if (
    typeof input?.shopifyOrderId !== "string" ||
    !input.shopifyOrderId.trim() ||
    input.shopifyOrderId !== input.shopifyOrderId.trim() ||
    typeof input.staffUserId !== "string" ||
    !/^[1-9]\d*$/.test(input.staffUserId) ||
    ![
      "NO_ID",
      "UNDERAGE",
      "IDENTITY_UNCLEAR",
      "DOCUMENT_INVALID",
      "TECHNICAL_FAILURE",
    ].includes(input.reason) ||
    !Array.isArray(input.requestedWithheld) ||
    input.requestedWithheld.length > 250
  ) {
    throw new Error("INVALID_PARTIAL_SELECTION_REQUEST");
  }

  const seen = new Set<string>();

  for (const line of input.requestedWithheld) {
    if (
      !line ||
      typeof line.lineItemId !== "string" ||
      !line.lineItemId.trim() ||
      line.lineItemId !== line.lineItemId.trim() ||
      line.lineItemId.length > 250 ||
      seen.has(line.lineItemId) ||
      !Number.isSafeInteger(line.quantity) ||
      line.quantity < 1
    ) {
      throw new Error("INVALID_PARTIAL_SELECTION_LINE");
    }
    seen.add(line.lineItemId);
  }
}

// Same namespace and exact calculation as
// completeAloNowDeliveryForDriver (legacy full completion).
export function selectionOrderLockKeyV1591(
  shopifyOrderId: string
): string {
  if (
    typeof shopifyOrderId !== "string" ||
    !shopifyOrderId.trim() ||
    shopifyOrderId !== shopifyOrderId.trim()
  ) {
    throw new Error("INVALID_SHOPIFY_ORDER_ID");
  }

  return createHash("sha256")
    .update("ALO_NOW_DELIVERY_COMPLETION_V1:")
    .update(shopifyOrderId)
    .digest()
    .readBigInt64BE(0)
    .toString();
}

// Do not call this for preview, UI open, search or cancel.
// It is intentionally not registered in an HTTP router.
export async function reserveSelectionV1591(
  input: SelectionRequestV1591
): Promise<{
  ok: true;
  mode: "RESERVED_NOT_DELIVERED";
  selectionHash: string;
}> {
  validateSelectionRequestV1591(input);

  const key = selectionOrderLockKeyV1591(
    input.shopifyOrderId
  );

  const client = await db.connect();
  let locked = false;
  let unlocked = false;

  try {
    await client.query(
      "SELECT pg_advisory_lock($1::bigint)",
      [key]
    );
    locked = true;

    const delivery = await getAloNowDelivery(
      input.shopifyOrderId
    );

    if (!delivery) {
      throw new Error("DELIVERY_NOT_FOUND");
    }

    if (
      String(delivery.assigned_driver_user_id) !==
      input.staffUserId
    ) {
      throw new Error("NOT_ASSIGNED_TO_DRIVER");
    }

    if (delivery.delivery_status !== "ON_THE_WAY") {
      throw new Error("DELIVERY_NOT_ON_THE_WAY");
    }

    if (
      delivery.age_verification_status ===
      "VERIFIED_AT_HANDOFF"
    ) {
      throw new Error("AGE_ALREADY_VERIFIED");
    }

    const workflow = await getOrderFulfillmentWorkflow(
      input.shopifyOrderId
    );

    if (
      !workflow ||
      !["PACKED", "COMPLETED"].includes(
        workflow.pack_status
      )
    ) {
      throw new Error("ORDER_NOT_PACKED");
    }

    // Fresh authoritative Shopify data under the shared lock.
    const order = await getShopifyOrderById(
      input.shopifyOrderId
    );

    if (
      !order ||
      order.id !== input.shopifyOrderId ||
      getOrderFulfillmentType(order) !== "ALO_NOW"
    ) {
      throw new Error("INVALID_SHOPIFY_ORDER");
    }

    // Until durable verified-age evidence is integrated,
    // age level stays 0. Restricted items stay withheld.
    const baseline = previewShopifyHandoffV1563(
      order, 0
    );

    if (baseline.plan.withheld.length === 0) {
      throw new Error(
        "AGE_FAILURE_REQUIRES_RESTRICTED_ITEMS"
      );
    }

    const selected = buildHandoffSelectionV1584({
      baseline: baseline.plan,
      requestedWithheld: input.requestedWithheld,
    });

    if (
      selected.partial !== true ||
      selected.blocked !== false ||
      selected.delivered.length === 0 ||
      selected.withheld.length === 0
    ) {
      throw new Error("PARTIAL_HANDOFF_REQUIRED");
    }

    const freshFulfillment =
      await getFulfillmentOrdersForOrder(
        input.shopifyOrderId
      );

    if (
      !freshFulfillment ||
      freshFulfillment.id !== input.shopifyOrderId
    ) {
      throw new Error("FULFILLMENT_ORDER_ID_MISMATCH");
    }

    const fulfillmentPlan = prepareSplitFulfillmentV1585({
      baseline: baseline.plan,
      selected,
      fulfillmentOrders:
        freshFulfillment.fulfillmentOrders,
    });

    if (fulfillmentPlan.length === 0) {
      throw new Error("NO_DELIVERABLE_FULFILLMENT_LINES");
    }

    // ALO_NOW_V1601_PERSISTED_LINE_IDENTITIES
    // Resolve original Shopify LineItem identities NOW,
    // using the same Shopify snapshot as the split planner.
    const foConnection = freshFulfillment.fulfillmentOrders;

    if (
      foConnection?.pageInfo?.hasNextPage !== false ||
      !Array.isArray(foConnection.nodes)
    ) {
      throw new Error("INCOMPLETE_IDENTITY_SNAPSHOT");
    }

    const foMap = new Map(
      foConnection.nodes.map((fo: any) => [
        fo.id, fo,
      ])
    );

    if (foMap.size !== foConnection.nodes.length) {
      throw new Error("DUPLICATE_IDENTITY_FULFILLMENT_ORDER");
    }

    const lineIdentities = fulfillmentPlan.flatMap(
      entry => {
        const fo: any = foMap.get(entry.fulfillmentOrderId);

        if (
          !fo ||
          fo.lineItems?.pageInfo?.hasNextPage !== false ||
          !Array.isArray(fo.lineItems.nodes)
        ) {
          throw new Error("INCOMPLETE_ORIGINAL_LINE_MAPPING");
        }

        const lineMap = new Map(
          fo.lineItems.nodes.map((line: any) => [
            line.id, line.lineItem?.id,
          ])
        );

        if (lineMap.size !== fo.lineItems.nodes.length) {
          throw new Error("DUPLICATE_ORIGINAL_LINE_MAPPING");
        }

        return entry.fulfillmentOrderLineItems.map(line => {
          const originalLineId = lineMap.get(line.id);

          if (typeof originalLineId !== "string") {
            throw new Error("ORIGINAL_SHOPIFY_LINE_NOT_FOUND");
          }

          return {
            fulfillmentOrderId: entry.fulfillmentOrderId,
            fulfillmentOrderLineItemId: line.id,
            shopifyLineItemId: originalLineId,
          };
        });
      }
    );

    // The same connection owns the advisory lock and
    // performs the SQL transaction via V1589.
    // Do not create a second lock-owning connection.
    return await persistSelectionUnderLockV1589(
      client,
      {
        shopifyOrderId: input.shopifyOrderId,
        staffUserId: input.staffUserId,
        reason: input.reason,
        baseline: baseline.plan,
        selected,
        fulfillmentPlan,
        lineIdentities,
      }
    );
  } finally {
    if (locked) {
      try {
        const result = await client.query<{
          released: boolean;
        }>(
          "SELECT pg_advisory_unlock($1::bigint) AS released",
          [key]
        );

        unlocked = result.rows[0]?.released === true;
      } catch (error) {
        console.error(
          "ALO NOW V1591 ORDER LOCK RELEASE FAILED",
          error instanceof Error
            ? error.message : "UNKNOWN"
        );
      }
    }

    // Destroy uncertain lock-owning connections.
    client.release(!unlocked);
  }
}

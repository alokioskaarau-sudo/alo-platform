// ALO_V1563_SHOPIFY_HANDOFF_ADAPTER
// READ-ONLY domain adapter. Never submits fulfillment or refunds.

import {
  planAloNowHandoffV1561,
  type HandoffLine,
  type HandoffPlan,
} from "./aloNowPartialHandoff.v1560.js";

export type ShopifyHandoffPreviewV1563 = {
  plan: HandoffPlan;
  unclassifiedLineItemIds: string[];
  lineItemCount: number;
};

export function previewShopifyHandoffV1563(
  order: any,
  verifiedAgeLevel: 0 | 16 | 18
): ShopifyHandoffPreviewV1563 {
  if (![0, 16, 18].includes(verifiedAgeLevel)) {
    throw new Error("INVALID_AGE_LEVEL");
  }

  const connection = order?.lineItems;

  if (!connection) {
    throw new Error("SHOPIFY_LINE_ITEMS_MISSING");
  }

  // Never calculate a partial handoff from a truncated order.
  if (connection?.pageInfo?.hasNextPage === true) {
    throw new Error("SHOPIFY_LINE_ITEMS_PAGINATION_REQUIRED");
  }

  const hasEdges = Array.isArray(connection.edges);
  const hasNodes = Array.isArray(connection.nodes);

  if (!hasEdges && !hasNodes) {
    throw new Error("SHOPIFY_LINE_ITEMS_SHAPE_UNKNOWN");
  }

  const rawItems: any[] = hasEdges
    ? connection.edges.map((edge: any) => edge?.node)
    : connection.nodes;

  if (!rawItems.length || rawItems.some(item => !item)) {
    throw new Error("SHOPIFY_LINE_ITEMS_INCOMPLETE");
  }

  const lines: HandoffLine[] = rawItems.map((item: any) => {
    const id = typeof item.id === "string"
      ? item.id.trim()
      : "";

    if (!id) {
      throw new Error("SHOPIFY_LINE_ITEM_ID_MISSING");
    }

    const quantity = item.quantity;

    if (!Number.isSafeInteger(quantity) || quantity < 1) {
      throw new Error("SHOPIFY_LINE_ITEM_QUANTITY_INVALID");
    }

    const rawAge =
      item.variant?.product?.ageRequirement?.value;

    const ageClass: HandoffLine["ageClass"] =
      rawAge === "NONE" ||
      rawAge === "AGE_16" ||
      rawAge === "AGE_18"
        ? rawAge
        : "UNKNOWN";

    return {
      lineItemId: id,
      quantity,
      ageClass,
    };
  });

  const plan = planAloNowHandoffV1561(
    lines,
    verifiedAgeLevel
  );

  return {
    plan,
    unclassifiedLineItemIds: lines
      .filter(line => line.ageClass === "UNKNOWN")
      .map(line => line.lineItemId),
    lineItemCount: lines.length,
  };
}

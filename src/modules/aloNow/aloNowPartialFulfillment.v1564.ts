// ALO_V1564_PARTIAL_FULFILLMENT_PLAN
// Pure planner. No Shopify, database or payment writes.

import type {
  HandoffPlan,
} from "./aloNowPartialHandoff.v1560.js";

type FulfillmentLine = {
  id: string;
  remainingQuantity: number;
  lineItem: {
    id: string;
  };
};

type FulfillmentOrder = {
  id: string;
  status: string;
  lineItems: {
    nodes: FulfillmentLine[];
    pageInfo: {
      hasNextPage: boolean;
    };
  };
};

export type PartialFulfillmentEntryV1564 = {
  fulfillmentOrderId: string;
  fulfillmentOrderLineItems: Array<{
    id: string;
    quantity: number;
  }>;
};

export function preparePartialFulfillmentV1564(
  plan: HandoffPlan,
  fulfillmentOrders: {
    nodes: FulfillmentOrder[];
    pageInfo: {
      hasNextPage: boolean;
    };
  }
): PartialFulfillmentEntryV1564[] {
  if (!plan ||
      !Array.isArray(plan.delivered) ||
      !Array.isArray(plan.withheld)) {
    throw new Error("INVALID_HANDOFF_PLAN");
  }

  if (!Array.isArray(fulfillmentOrders?.nodes) ||
      fulfillmentOrders.pageInfo?.hasNextPage !== false) {
    throw new Error("FULFILLMENT_ORDERS_INCOMPLETE");
  }

  const desired = new Map<string, number>();
  const all = new Map<string, number>();

  for (const [kind, lines] of [
    ["delivered", plan.delivered],
    ["withheld", plan.withheld],
  ] as const) {
    for (const line of lines) {
      const id = line.lineItemId?.trim();

      if (!id || all.has(id) ||
          !Number.isSafeInteger(line.quantity) ||
          line.quantity < 1) {
        throw new Error("INVALID_HANDOFF_LINE");
      }

      all.set(id, line.quantity);
      if (kind === "delivered") {
        desired.set(id, line.quantity);
      }
    }
  }

  if (!all.size) {
    throw new Error("EMPTY_HANDOFF_PLAN");
  }

  const seenOrders = new Set<string>();
  const seenFulfillmentLines = new Set<string>();
  const available = new Map<string, number>();
  const entries: PartialFulfillmentEntryV1564[] = [];

  for (const order of fulfillmentOrders.nodes) {
    if (!order.id || seenOrders.has(order.id)) {
      throw new Error("DUPLICATE_FULFILLMENT_ORDER");
    }

    seenOrders.add(order.id);

    if (!["OPEN", "IN_PROGRESS"].includes(order.status)) {
      throw new Error("UNSUPPORTED_FULFILLMENT_STATUS");
    }

    if (!Array.isArray(order.lineItems?.nodes) ||
        order.lineItems.pageInfo?.hasNextPage !== false) {
      throw new Error("FULFILLMENT_LINE_ITEMS_INCOMPLETE");
    }

    const selected: PartialFulfillmentEntryV1564 = {
      fulfillmentOrderId: order.id,
      fulfillmentOrderLineItems: [],
    };

    for (const line of order.lineItems.nodes) {
      const id = line.lineItem?.id;
      const fulfillmentLineId = line.id;
      const quantity = line.remainingQuantity;

      if (!id || !all.has(id) ||
          !fulfillmentLineId ||
          seenFulfillmentLines.has(fulfillmentLineId) ||
          !Number.isSafeInteger(quantity) ||
          quantity < 0) {
        throw new Error("INVALID_FULFILLMENT_LINE");
      }

      seenFulfillmentLines.add(fulfillmentLineId);

      const total = (available.get(id) ?? 0) + quantity;
      if (!Number.isSafeInteger(total)) {
        throw new Error("FULFILLMENT_QUANTITY_OVERFLOW");
      }
      available.set(id, total);

      const outstanding = desired.get(id) ?? 0;
      const allocation = Math.min(outstanding, quantity);

      if (allocation > 0) {
        selected.fulfillmentOrderLineItems.push({
          id: fulfillmentLineId,
          quantity: allocation,
        });
        desired.set(id, outstanding - allocation);
      }
    }

    if (selected.fulfillmentOrderLineItems.length) {
      entries.push(selected);
    }
  }

  // Only a completely unfulfilled, fully mapped order
  // can be planned. No partial retries or stale quantities.
  for (const [id, quantity] of all) {
    if ((available.get(id) ?? 0) !== quantity) {
      throw new Error("FULFILLMENT_QUANTITY_MISMATCH");
    }
  }

  for (const quantity of desired.values()) {
    if (quantity !== 0) {
      throw new Error("FULFILLMENT_ALLOCATION_INCOMPLETE");
    }
  }

  // No fulfillment is created if all items are withheld.
  return entries;
}

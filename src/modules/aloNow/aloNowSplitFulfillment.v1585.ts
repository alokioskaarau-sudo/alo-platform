// ALO_NOW_V1585_SPLIT_FULFILLMENT
// Pure planning, no external writes.
// Baseline must come from fresh server-side Shopify age analysis.

import type {
  HandoffPlan,
} from "./aloNowPartialHandoff.v1560.js";

type Line = {lineItemId: string; quantity: number};

type FulfillmentOrder = {
  id: string;
  status: string;
  lineItems: {
    pageInfo: {hasNextPage: boolean};
    nodes: Array<{
      id: string;
      remainingQuantity: number;
      lineItem: {id: string};
    }>;
  };
};

type FulfillmentConnection = {
  pageInfo: {hasNextPage: boolean};
  nodes: FulfillmentOrder[];
};

export type SplitFulfillmentEntryV1585 = {
  fulfillmentOrderId: string;
  fulfillmentOrderLineItems: Array<{
    id: string;
    quantity: number;
  }>;
};

function quantities(
  lines: Line[],
  name: string
): Map<string, number> {
  if (!Array.isArray(lines)) {
    throw new Error("INVALID_" + name);
  }

  const result = new Map<string, number>();

  for (const line of lines) {
    const id = line?.lineItemId;
    const quantity = line?.quantity;

    if (
      typeof id !== "string" ||
      !id.trim() ||
      id !== id.trim() ||
      result.has(id) ||
      !Number.isSafeInteger(quantity) ||
      quantity < 1
    ) {
      throw new Error("INVALID_" + name + "_LINE");
    }
    result.set(id, quantity);
  }
  return result;
}

function validatePlan(plan: HandoffPlan, label: string) {
  if (
    !plan ||
    ![0, 16, 18].includes(plan.verifiedAgeLevel) ||
    typeof plan.partial !== "boolean" ||
    typeof plan.blocked !== "boolean"
  ) {
    throw new Error("INVALID_" + label);
  }

  const delivered = quantities(plan.delivered, label + "_DELIVERED");
  const withheld = quantities(plan.withheld, label + "_WITHHELD");

  if (
    plan.partial !== (delivered.size > 0 && withheld.size > 0) ||
    plan.blocked !== (delivered.size === 0)
  ) {
    throw new Error(label + "_FLAGS_MISMATCH");
  }

  const total = new Map<string, number>();

  for (const group of [delivered, withheld]) {
    for (const [id, amount] of group) {
      const value = (total.get(id) ?? 0) + amount;
      if (!Number.isSafeInteger(value)) {
        throw new Error("QUANTITY_OVERFLOW");
      }
      total.set(id, value);
    }
  }

  if (!total.size) throw new Error("EMPTY_" + label);

  return {delivered, withheld, total};
}

export function prepareSplitFulfillmentV1585(input: {
  baseline: HandoffPlan;
  selected: HandoffPlan;
  fulfillmentOrders: FulfillmentConnection;
}): SplitFulfillmentEntryV1585[] {
  const baseline = validatePlan(input?.baseline, "BASELINE");
  const selected = validatePlan(input?.selected, "SELECTED");

  if (
    input.baseline.verifiedAgeLevel !==
      input.selected.verifiedAgeLevel ||
    baseline.total.size !== selected.total.size
  ) {
    throw new Error("BASELINE_MISMATCH");
  }

  for (const [id, quantity] of baseline.total) {
    if (selected.total.get(id) !== quantity) {
      throw new Error("SELECTED_QUANTITY_MISMATCH");
    }

    const mandatoryWithheld =
      baseline.withheld.get(id) ?? 0;

    if (
      (selected.withheld.get(id) ?? 0) <
      mandatoryWithheld
    ) {
      throw new Error("AGE_RESTRICTION_BYPASS");
    }
  }

  const connection = input.fulfillmentOrders;

  if (
    !Array.isArray(connection?.nodes) ||
    connection.pageInfo?.hasNextPage !== false ||
    connection.nodes.length === 0
  ) {
    throw new Error("FULFILLMENT_ORDERS_INCOMPLETE");
  }

  const available = new Map<string, number>();
  const outstanding = new Map(selected.delivered);
  const seenOrders = new Set<string>();
  const seenFulfillmentLines = new Set<string>();
  const entries: SplitFulfillmentEntryV1585[] = [];

  for (const order of connection.nodes) {
    if (
      typeof order?.id !== "string" ||
      !order.id ||
      seenOrders.has(order.id) ||
      !["OPEN", "IN_PROGRESS"].includes(order.status)
    ) {
      throw new Error("INVALID_FULFILLMENT_ORDER");
    }
    seenOrders.add(order.id);

    if (
      !Array.isArray(order.lineItems?.nodes) ||
      order.lineItems.pageInfo?.hasNextPage !== false
    ) {
      throw new Error("FULFILLMENT_LINES_INCOMPLETE");
    }

    const entry: SplitFulfillmentEntryV1585 = {
      fulfillmentOrderId: order.id,
      fulfillmentOrderLineItems: [],
    };

    for (const line of order.lineItems.nodes) {
      const id = line?.lineItem?.id;
      const fulfillmentId = line?.id;
      const quantity = line?.remainingQuantity;

      if (
        typeof id !== "string" ||
        !baseline.total.has(id) ||
        typeof fulfillmentId !== "string" ||
        !fulfillmentId ||
        seenFulfillmentLines.has(fulfillmentId) ||
        !Number.isSafeInteger(quantity) ||
        quantity < 0
      ) {
        throw new Error("INVALID_FULFILLMENT_LINE");
      }

      seenFulfillmentLines.add(fulfillmentId);

      const total = (available.get(id) ?? 0) + quantity;

      if (!Number.isSafeInteger(total)) {
        throw new Error("FULFILLMENT_QUANTITY_OVERFLOW");
      }
      available.set(id, total);

      const needed = outstanding.get(id) ?? 0;
      const allocated = Math.min(needed, quantity);

      if (allocated > 0) {
        entry.fulfillmentOrderLineItems.push({
          id: fulfillmentId,
          quantity: allocated,
        });
        outstanding.set(id, needed - allocated);
      }
    }

    if (entry.fulfillmentOrderLineItems.length) {
      entries.push(entry);
    }
  }

  for (const [id, total] of baseline.total) {
    if (available.get(id) !== total) {
      throw new Error("SHOPIFY_QUANTITY_MISMATCH");
    }
  }

  for (const amount of outstanding.values()) {
    if (amount !== 0) {
      throw new Error("FULFILLMENT_ALLOCATION_INCOMPLETE");
    }
  }

  // Multiple fulfillment orders are valid for planning, but
  // execution will require a separate durable journal per order.
  // No Shopify mutation is performed here.
  return entries;
}

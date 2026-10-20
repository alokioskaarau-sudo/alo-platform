// ALO_PICKUP_CORE_V2
// Reine Validierung ohne externe API-Aufrufe.

export function validatePickupFulfillmentOrders(
  items: any[]
): void {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("PICKUP_NO_FULFILLMENT_ORDERS");
  }

  // ALO_PICKUP_EMPTY_LINES_GUARD_V1
  for (const item of items) {
    if (!Array.isArray(item.lineItems?.nodes) ||
        item.lineItems.nodes.length === 0) {
      throw new Error("PICKUP_LINEITEMS_MISSING");
    }
  }

  // ALO_PICKUP_LINEITEM_PAGINATION_GUARD_V1
  for (const item of items) {
    if (item.lineItems?.pageInfo?.hasNextPage !== false) {
      throw new Error("PICKUP_LINEITEM_LIST_INCOMPLETE");
    }
  }

  for (const item of items) {
    const method = String(
      item?.deliveryMethod?.methodType ?? ""
    ).toUpperCase();

    if (method !== "PICK_UP" && method !== "PICKUP") {
      throw new Error("PICKUP_MIXED_FULFILLMENT_CHANNEL");
    }
  }

  // ALO_PICKUP_QUANTITY_VALIDATION_V1
  for (const item of items) {
    for (const line of item.lineItems.nodes) {
      const quantity = line.remainingQuantity;
      if (
        typeof quantity !== "number" ||
        !Number.isSafeInteger(quantity) ||
        quantity < 0
      ) {
        throw new Error("PICKUP_INVALID_REMAINING_QUANTITY");
      }
    }
  }

  // ALO_PICKUP_STATUS_PREFLIGHT_V1
  for (const item of items) {
    const remaining = (item.lineItems?.nodes ?? [])
      .reduce(
        (sum: number, line: any) =>
          sum + Number(line.remainingQuantity ?? 0),
        0
      );

    if (
      remaining > 0 &&
      item.status !== "OPEN" &&
      item.status !== "IN_PROGRESS"
    ) {
      throw new Error("PICKUP_FULFILLMENT_NOT_OPEN");
    }
  }

}

// ALO_PICKUP_COMPLETION_VERIFICATION_V1
export function verifyPickupFullyFulfilled(
  data: any
): void {
  if (data?.fulfillmentOrders?.pageInfo?.hasNextPage !== false) {
    throw new Error("PICKUP_VERIFICATION_INCOMPLETE");
  }

  const items = data?.fulfillmentOrders?.nodes;

  validatePickupFulfillmentOrders(items);

  for (const item of items) {
    for (const line of item.lineItems.nodes) {
      if (line.remainingQuantity !== 0) {
        throw new Error("PICKUP_STILL_UNFULFILLED");
      }
    }
  }
}

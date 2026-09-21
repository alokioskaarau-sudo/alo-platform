export type AloOrderFulfillmentType =
  | "SHIPPING"
  | "PICKUP"
  | "ALO_NOW";

function getFulfillmentOrders(
  order: any
): any[] {
  return (
    order
      ?.fulfillmentOrders
      ?.edges
      ?.map(
        (edge: any) =>
          edge?.node
      )
      ?.filter(Boolean) ??
    []
  );
}

export function isAloNowOrder(
  order: any
): boolean {
  const fulfillmentOrders =
    getFulfillmentOrders(order);

  return fulfillmentOrders.some(
    (fulfillmentOrder: any) => {
      const presentedName =
        String(
          fulfillmentOrder
            ?.deliveryMethod
            ?.presentedName ??
          ""
        )
          .trim()
          .toUpperCase();

      return (
        presentedName === "ALO NOW" ||
        presentedName.startsWith(
          "ALO NOW "
        ) ||
        presentedName.startsWith(
          "ALO NOW -"
        )
      );
    }
  );
}

export function isPickupOrder(
  order: any
): boolean {
  const fulfillmentOrders =
    getFulfillmentOrders(order);

  if (
    fulfillmentOrders.length === 0
  ) {
    return false;
  }

  return fulfillmentOrders.some(
    (fulfillmentOrder: any) => {
      const methodType =
        String(
          fulfillmentOrder
            ?.deliveryMethod
            ?.methodType ??
          ""
        )
          .trim()
          .toUpperCase();

      const presentedName =
        String(
          fulfillmentOrder
            ?.deliveryMethod
            ?.presentedName ??
          ""
        )
          .trim()
          .toLowerCase();

      return (
        methodType === "PICK_UP" ||
        methodType === "PICKUP" ||
        presentedName.includes(
          "abholung"
        ) ||
        presentedName.includes(
          "pickup"
        )
      );
    }
  );
}

export function getOrderFulfillmentType(
  order: any
): AloOrderFulfillmentType {
  if (isAloNowOrder(order)) {
    return "ALO_NOW";
  }

  if (isPickupOrder(order)) {
    return "PICKUP";
  }

  return "SHIPPING";
}

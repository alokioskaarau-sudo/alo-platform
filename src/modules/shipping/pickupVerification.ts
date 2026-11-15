import { verifyPickupFullyFulfilled } from "./pickupCore.js";

// ALO_PICKUP_VERIFICATION_RETRY_V1
export async function verifyPickupCompletionWithRetry(
  orderId: string,
  dependencies: {
    getOrder: (id: string) => Promise<any>;
    getFulfillmentOrders: (id: string) => Promise<any>;
    sleep?: (ms: number) => Promise<void>;
  }
): Promise<void> {
  const sleep = dependencies.sleep ??
    ((ms: number) => new Promise<void>(
      resolve => setTimeout(resolve, ms)
    ));

  for (let attempt = 1; attempt <= 3; attempt++) {
    const order = await dependencies.getOrder(orderId);

    if (order?.displayFulfillmentStatus === "FULFILLED") {
      const fulfillmentOrders =
        await dependencies.getFulfillmentOrders(order.id);

      try {
        verifyPickupFullyFulfilled(fulfillmentOrders);
        return;
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "PICKUP_STILL_UNFULFILLED") {
          throw error;
        }
      }
    }

    if (attempt < 3) {
      await sleep(1000);
    }
  }

  throw new Error("PICKUP_SHOPIFY_NOT_CONFIRMED");
}

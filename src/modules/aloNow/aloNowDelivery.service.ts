import {
  claimAloNowDelivery,
  markAloNowReadyForPickup,
} from "../../database/aloNowDeliveries.js";

import {
  getOrderFulfillmentWorkflow,
} from "../../database/orderFulfillmentWorkflow.js";

export async function claimAloNowDeliveryForDriver(
  shopifyOrderId: string,
  staffUserId: string
) {
  const claimResult =
    await claimAloNowDelivery(
      shopifyOrderId,
      staffUserId
    );

  if (!claimResult.ok) {
    return claimResult;
  }

  const workflow =
    await getOrderFulfillmentWorkflow(
      shopifyOrderId
    );

  if (
    workflow?.pack_status !== "PACKED"
  ) {
    return claimResult;
  }

  const readyResult =
    await markAloNowReadyForPickup(
      shopifyOrderId
    );

  if (!readyResult.ok) {
    throw new Error(
      `ALO_NOW_READY_AFTER_CLAIM_FAILED:${readyResult.reason}`
    );
  }

  return {
    ok: true as const,
    delivery:
      readyResult.delivery,
    alreadyAssignedToMe:
      claimResult.alreadyAssignedToMe,
    automaticallyReadyForPickup:
      true,
  };
}

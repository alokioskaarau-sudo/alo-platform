import {
  completeAloNowDelivery,
  getAloNowDelivery,
} from "../../database/aloNowDeliveries.js";

import {
  completeAloNowOrderWorkflow,
  getOrderFulfillmentWorkflow,
} from "../../database/orderFulfillmentWorkflow.js";

import {
  getShopifyOrderById,
} from "../../integrations/shopify/orders.js";

import {
  fulfillShopifyAloNowOrder,
} from "../shipping/fulfillment.service.js";

import {
  getOrderFulfillmentType,
} from "../orders/orderFulfillmentType.js";

export async function completeAloNowDeliveryForDriver(
  shopifyOrderId: string,
  staffUserId: string
) {
  const delivery =
    await getAloNowDelivery(
      shopifyOrderId
    );

  if (!delivery) {
    throw new Error(
      "ALO_NOW_DELIVERY_NOT_FOUND"
    );
  }

  if (
    delivery.assigned_driver_user_id !==
    staffUserId
  ) {
    throw new Error(
      "ALO_NOW_NOT_ASSIGNED_TO_DRIVER"
    );
  }

  if (
    delivery.delivery_status !==
      "ON_THE_WAY" &&
    delivery.delivery_status !==
      "DELIVERED"
  ) {
    throw new Error(
      "ALO_NOW_INVALID_DELIVERY_STATUS"
    );
  }

  const workflow =
    await getOrderFulfillmentWorkflow(
      shopifyOrderId
    );

  if (!workflow) {
    throw new Error(
      "ALO_NOW_PACK_WORKFLOW_NOT_FOUND"
    );
  }

  if (
    workflow.pack_status !== "PACKED" &&
    workflow.pack_status !== "COMPLETED"
  ) {
    throw new Error(
      "ALO_NOW_ORDER_NOT_PACKED"
    );
  }

  let shopifyOrder =
    await getShopifyOrderById(
      shopifyOrderId
    );

  if (!shopifyOrder) {
    throw new Error(
      "ALO_NOW_SHOPIFY_ORDER_NOT_FOUND"
    );
  }

  const fulfillmentType =
    getOrderFulfillmentType(
      shopifyOrder
    );

  if (fulfillmentType !== "ALO_NOW") {
    throw new Error(
      "ORDER_IS_NOT_ALO_NOW"
    );
  }

  const beforeStatus =
    String(
      shopifyOrder
        .displayFulfillmentStatus || ""
    ).toUpperCase();

  if (beforeStatus !== "FULFILLED") {
    await fulfillShopifyAloNowOrder(
      shopifyOrder
    );

    shopifyOrder =
      await getShopifyOrderById(
        shopifyOrderId
      );

    if (!shopifyOrder) {
      throw new Error(
        "ALO_NOW_SHOPIFY_ORDER_NOT_FOUND_AFTER_FULFILLMENT"
      );
    }
  }

  const finalShopifyStatus =
    String(
      shopifyOrder
        .displayFulfillmentStatus || ""
    ).toUpperCase();

  if (
    finalShopifyStatus !== "FULFILLED"
  ) {
    throw new Error(
      "ALO_NOW_SHOPIFY_NOT_FULFILLED"
    );
  }

  const deliveryResult =
    await completeAloNowDelivery(
      shopifyOrderId,
      staffUserId
    );

  if (!deliveryResult.ok) {
    throw new Error(
      `ALO_NOW_COMPLETE_${deliveryResult.reason}`
    );
  }

  const completedWorkflow =
    await completeAloNowOrderWorkflow(
      shopifyOrderId
    );

  if (!completedWorkflow) {
    throw new Error(
      "ALO_NOW_PACK_WORKFLOW_COMPLETE_FAILED"
    );
  }

  return {
    ok: true as const,
    shopifyOrderId,
    shopifyOrderName:
      shopifyOrder.name,
    shopifyFulfillmentStatus:
      finalShopifyStatus,
    delivery:
      deliveryResult.delivery,
    alreadyDelivered:
      deliveryResult.alreadyDelivered,
    workflow:
      completedWorkflow,
  };
}

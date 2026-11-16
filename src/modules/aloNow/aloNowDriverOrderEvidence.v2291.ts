// V2291: READ ONLY. Do not leak Shopify payment details before driver-ownership verification.
import type { TrustedOrderV2290 } from '../../integrations/shopify/aloNowTrustedOrderReader.v2290.js';
export type DriverEvidenceDepsV2291 = {
  getDelivery: (shopifyOrderId: string) => Promise<{assigned_driver_user_id: string | null; delivery_status: string} | null>;
  readOrder: (shopifyOrderId: string) => Promise<TrustedOrderV2290 | null>;
};
const ORDER_NUMBER = /^[1-9][0-9]{0,18}$/;
const STAFF_ID = /^[1-9][0-9]{0,18}$/;
export async function readDriverShopifyEvidenceV2291(
  orderNumber: string, staffUserId: string, deps: DriverEvidenceDepsV2291,
) {
  if (!ORDER_NUMBER.test(orderNumber) || !STAFF_ID.test(staffUserId))
    throw new Error('V2291_INVALID_CONTEXT');
  const orderId = `gid://shopify/Order/${orderNumber}`;
  const delivery = await deps.getDelivery(orderId);
  if (!delivery || delivery.assigned_driver_user_id !== staffUserId ||
    !['DRIVER_ASSIGNED', 'READY_FOR_PICKUP', 'PICKED_UP', 'ON_THE_WAY'].includes(delivery.delivery_status))
    return null;
  const order = await deps.readOrder(orderId);
  if (!order) return null;
  return {
    shopifyOrderId: orderId,
    deliveryStatus: delivery.delivery_status,
    financialStatus: order.displayFinancialStatus,
    cancelled: order.cancelledAt !== null,
    outstanding: order.totalOutstandingSet.shopMoney,
    total: order.totalPriceSet.shopMoney,
  };
}

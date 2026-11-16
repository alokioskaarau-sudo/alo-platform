import {
  getOrderFulfillmentType,
  getStaffOrderChannel,
  type AloOrderFulfillmentType,
} from './orderFulfillmentType.js';

/** Fail closed before any ALO NOW paid-order side effects or printing. */
export function requireVerifiedAloNowChannelV2298(
  order: unknown,
): AloOrderFulfillmentType {
  const type = getOrderFulfillmentType(order);
  if (type === 'ALO_NOW' && getStaffOrderChannel(order) !== 'ALO_NOW') {
    throw new Error('ALO_NOW_FULFILLMENT_CHANNEL_UNVERIFIED');
  }
  return type;
}

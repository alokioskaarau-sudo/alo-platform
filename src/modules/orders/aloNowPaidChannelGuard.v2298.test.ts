import assert from 'node:assert/strict';
import test from 'node:test';
import { requireVerifiedAloNowChannelV2298 } from './aloNowPaidChannelGuard.v2298.js';

const method = (name: string, type = 'SHIPPING') => ({
  node: { deliveryMethod: { presentedName: name, methodType: type } },
});
const order = (edges: unknown[], hasNextPage: boolean) => ({
  fulfillmentOrders: { edges, pageInfo: { hasNextPage } },
});

test('V2298 verified complete ALO NOW order is accepted', () => {
  assert.equal(requireVerifiedAloNowChannelV2298(order([method('ALO NOW')], false)), 'ALO_NOW');
  assert.equal(requireVerifiedAloNowChannelV2298(order([method('ALO NOW - Aarau')], false)), 'ALO_NOW');
});

test('V2298 incomplete ALO NOW fulfillment pagination stops before side effects', () => {
  assert.throws(
    () => requireVerifiedAloNowChannelV2298(order([method('ALO NOW')], true)),
    /ALO_NOW_FULFILLMENT_CHANNEL_UNVERIFIED/,
  );
});

test('V2298 mixed ALO NOW and shipping fulfillment methods fail closed', () => {
  assert.throws(
    () => requireVerifiedAloNowChannelV2298(order([method('ALO NOW'), method('Standardversand')], false)),
    /ALO_NOW_FULFILLMENT_CHANNEL_UNVERIFIED/,
  );
  assert.throws(
    () => requireVerifiedAloNowChannelV2298(order([method('Standardversand'), method('ALO NOW')], false)),
    /ALO_NOW_FULFILLMENT_CHANNEL_UNVERIFIED/,
  );
});

test('V2298 existing unrelated shipping and pickup classification stays unchanged', () => {
  assert.equal(requireVerifiedAloNowChannelV2298(order([method('Standardversand')], false)), 'SHIPPING');
  assert.equal(requireVerifiedAloNowChannelV2298(order([method('Abholung', 'PICK_UP')], false)), 'PICKUP');
});

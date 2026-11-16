import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getStaffOrderChannel } from '../../modules/orders/orderFulfillmentType.js';
import { requireVerifiedAloNowChannelV2298 } from '../../modules/orders/aloNowPaidChannelGuard.v2298.js';

test('V2306 Shopify details query requests the exact field required by strict channel guard', () => {
  const src = readFileSync(new URL('./orders.ts', import.meta.url), 'utf8');
  const match = src.match(/fulfillmentOrders\(first:\s*20\)\s*\{([\s\S]*?)\n\s*edges\s*\{/);
  assert.ok(match, 'Shopify order details query missing');
  assert.match(match[1], /pageInfo\s*\{\s*hasNextPage\s*\}/);
});

test('V2306 real Shopify-shaped order is accepted only when complete', () => {
  const base = (pageInfo: unknown) => ({
    fulfillmentOrders: {
      pageInfo,
      edges: [{ node: { deliveryMethod: { presentedName: 'ALO NOW - Aarau', methodType: 'SHIPPING' } } }],
    },
  });
  assert.equal(getStaffOrderChannel(base({ hasNextPage: false })), 'ALO_NOW');
  assert.equal(requireVerifiedAloNowChannelV2298(base({ hasNextPage: false })), 'ALO_NOW');
  assert.throws(() => requireVerifiedAloNowChannelV2298(base(undefined)), /UNVERIFIED/);
  assert.throws(() => requireVerifiedAloNowChannelV2298(base({ hasNextPage: true })), /UNVERIFIED/);
});

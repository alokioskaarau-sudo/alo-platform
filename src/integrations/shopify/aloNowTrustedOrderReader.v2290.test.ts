import assert from 'node:assert/strict';
import test from 'node:test';
import { makeTrustedOrderReaderV2290 } from './aloNowTrustedOrderReader.v2290.js';
const ID = 'gid://shopify/Order/123';
const valid = () => ({
  data: { order: {
    id: ID,
    cancelledAt: null,
    displayFinancialStatus: 'PAID',
    totalPriceSet: { shopMoney: { amount: '32.90', currencyCode: 'CHF' } },
    totalOutstandingSet: { shopMoney: { amount: '0.00', currencyCode: 'CHF' } },
  } },
});
test('V2290 validates trusted Shopify payment fields', async () => {
  let reads = 0;
  const reader = makeTrustedOrderReaderV2290(async (query, vars) => {
    reads++;
    assert.match(query, /displayFinancialStatus/);
    assert.equal(vars.id, ID);
    return valid();
  });
  const order = await reader(ID);
  assert.equal(order?.totalOutstandingSet.shopMoney.amount, '0.00');
  assert.equal(order?.displayFinancialStatus, 'PAID');
  assert.equal(reads, 1);
});
test('V2290 refuses invalid order identifiers without Shopify transport', async () => {
  let reads = 0;
  const reader = makeTrustedOrderReaderV2290(async () => { reads++; return valid(); });
  await assert.rejects(reader('123'), /INVALID_SHOPIFY_ORDER_ID/);
  await assert.rejects(reader('gid://shopify/Order/0'), /INVALID_SHOPIFY_ORDER_ID/);
  assert.equal(reads, 0);
});
test('V2290 missing order resolves null but malformed evidence fails closed', async () => {
  assert.equal(await makeTrustedOrderReaderV2290(async () => ({ data: { order: null } }))(ID), null);
  const changed = valid();
  changed.data.order.id = 'gid://shopify/Order/456';
  await assert.rejects(makeTrustedOrderReaderV2290(async () => changed)(ID), /SHOPIFY_ORDER_EVIDENCE_INVALID/);
});
test('V2290 GraphQL errors and inconsistent money reject without retry', async () => {
  let reads = 0;
  const reader = makeTrustedOrderReaderV2290(async () => { reads++; return { errors: [{ message: 'access denied' }] }; });
  await assert.rejects(reader(ID), /SHOPIFY_ORDER_GRAPHQL_FAILURE/);
  assert.equal(reads, 1);
  const invalid = valid();
  invalid.data.order.totalOutstandingSet.shopMoney.currencyCode = 'USD';
  await assert.rejects(makeTrustedOrderReaderV2290(async () => invalid)(ID), /SHOPIFY_ORDER_EVIDENCE_INVALID/);
});

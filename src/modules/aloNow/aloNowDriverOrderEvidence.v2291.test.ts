import assert from 'node:assert/strict';
import test from 'node:test';
import { readDriverShopifyEvidenceV2291 } from './aloNowDriverOrderEvidence.v2291.js';
const ID='gid://shopify/Order/123';
const ORDER={id:ID, cancelledAt:null, displayFinancialStatus:'PAID', totalPriceSet:{shopMoney:{amount:'22.90',currencyCode:'CHF'}}, totalOutstandingSet:{shopMoney:{amount:'0.00',currencyCode:'CHF'}}};
test('V2291 assigned driver may read payment fields only', async()=>{
 let reads=0;
 const result=await readDriverShopifyEvidenceV2291('123','7',{getDelivery:async()=>({assigned_driver_user_id:'7',delivery_status:'ON_THE_WAY'}),readOrder:async()=>{reads++;return ORDER;}});
 assert.equal(reads,1);assert.equal(result?.financialStatus,'PAID');assert.deepEqual(result?.outstanding,{amount:'0.00',currencyCode:'CHF'});
 assert.deepEqual(Object.keys(result??{}).sort(),['shopifyOrderId','deliveryStatus','financialStatus','cancelled','outstanding','total'].sort());
});
test('V2291 other staff cannot trigger Shopify read', async()=>{
 let reads=0;
 const result=await readDriverShopifyEvidenceV2291('123','8',{getDelivery:async()=>({assigned_driver_user_id:'7',delivery_status:'ON_THE_WAY'}),readOrder:async()=>{reads++;return ORDER;}});
 assert.equal(result,null);assert.equal(reads,0);
});
test('V2291 invalid id is rejected without lookup', async()=>{
 let lookups=0;
 await assert.rejects(readDriverShopifyEvidenceV2291('gid://shopify/Order/123','7',{getDelivery:async()=>{lookups++;return null;},readOrder:async()=>ORDER}),/V2291_INVALID_CONTEXT/);
 assert.equal(lookups,0);
});
test('V2291 unassigned or completed delivery never triggers Shopify',async()=>{
 let reads=0;
 for(const delivery of [null,{assigned_driver_user_id:'7',delivery_status:'DELIVERED'}]){
  const result=await readDriverShopifyEvidenceV2291('123','7',{getDelivery:async()=>delivery,readOrder:async()=>{reads++;return ORDER;}});
  assert.equal(result,null);
 }
 assert.equal(reads,0);
});

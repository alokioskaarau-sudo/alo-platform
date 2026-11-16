import assert from 'node:assert/strict';
import test from 'node:test';
import { makeDriverOrderDetailsReaderV2292 } from '../../integrations/shopify/aloNowDriverOrderDetails.v2292.js';
import { getAssignedDriverOrderDetailV2292 } from './aloNowDriverOrderDetails.v2292.js';
const ID='gid://shopify/Order/123';
const valid=()=>({data:{order:{id:ID,name:'#123',shippingAddress:{name:'Testkunde',address1:'Teststrasse 1',address2:null,city:'Aarau',zip:'5000',countryCodeV2:'CH',phone:null},lineItems:{pageInfo:{hasNextPage:false},edges:[{node:{id:'gid://shopify/LineItem/987',title:'Testdrink',quantity:2,variant:null}}]}}}});
test('V2292 trusted order details include address and quantities without writes', async()=>{
 let calls=0;
 const read=makeDriverOrderDetailsReaderV2292(async(q,v)=>{calls++;assert.match(q,/lineItems/);assert.equal(v.id,ID);return valid();});
 const order=await read(ID);
 assert.equal(calls,1);assert.equal(order?.lines[0]?.quantity,2);assert.equal(order?.shippingAddress?.city,'Aarau');
});
test('V2292 wrong driver and inactive delivery never request Shopify',async()=>{
 let reads=0;
 const d={getDelivery:async()=>({assigned_driver_user_id:'7',delivery_status:'ON_THE_WAY'}),readOrder:async()=>{reads++;return null;}};
 assert.equal(await getAssignedDriverOrderDetailV2292('123','8',d),null);
 assert.equal(await getAssignedDriverOrderDetailV2292('123','7',{...d,getDelivery:async()=>({assigned_driver_user_id:'7',delivery_status:'DELIVERED'})}),null);
 assert.equal(reads,0);
});
test('V2292 authorized driver gets correct order, wrong Shopify id fails closed',async()=>{
 const d={getDelivery:async()=>({assigned_driver_user_id:'7',delivery_status:'ON_THE_WAY'}),readOrder:async()=>({id:ID,name:'#123',shippingAddress:null,lines:[]})};
 assert.equal((await getAssignedDriverOrderDetailV2292('123','7',d))?.order.id,ID);
 await assert.rejects(getAssignedDriverOrderDetailV2292('123','7',{...d,readOrder:async()=>({id:'gid://shopify/Order/456',name:'#456',shippingAddress:null,lines:[]})}),/V2292_ORDER_ID_MISMATCH/);
});
test('V2292 refuses partial pagination or invalid quantities',async()=>{
 const incomplete=valid();incomplete.data.order.lineItems.pageInfo.hasNextPage=true;
 await assert.rejects(makeDriverOrderDetailsReaderV2292(async()=>incomplete)(ID),/V2292_INCOMPLETE_ORDER_DETAILS/);
 const invalid=valid();invalid.data.order.lineItems.edges[0].node.quantity=0;
 await assert.rejects(makeDriverOrderDetailsReaderV2292(async()=>invalid)(ID),/V2292_INVALID_LINE_ITEM/);
});
test('V2292 invalid id and GraphQL errors never silently succeed',async()=>{
 let calls=0;const read=makeDriverOrderDetailsReaderV2292(async()=>{calls++;return valid();});
 await assert.rejects(read('123'),/V2292_INVALID_ORDER_ID/);assert.equal(calls,0);
 await assert.rejects(makeDriverOrderDetailsReaderV2292(async()=>({errors:[{message:'access denied'}]}))(ID),/V2292_GRAPHQL_FAILURE/);
});

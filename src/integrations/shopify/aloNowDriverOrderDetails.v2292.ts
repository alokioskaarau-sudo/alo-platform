// V2292: Shopify read-only order details. Reuses existing trusted Shopify transport.
import { shopifyOrderReadTransportV2290 } from './aloNowTrustedOrderReader.v2290.js';
export type DriverOrderDetailV2292 = {
  id: string;
  name: string;
  shippingAddress: { name: string; address1: string; address2: string | null; city: string; zip: string; countryCodeV2: string; phone: string | null } | null;
  lines: Array<{ id: string; title: string; quantity: number; variantTitle: string | null }>;
};
type Transport = (query: string, variables: {id: string}) => Promise<unknown>;
const GID = /^gid:\/\/shopify\/Order\/[1-9][0-9]*$/;
const Q = `query AloDriverOrderDetailsV2292($id: ID!) {
 order(id: $id) {
  id name
  shippingAddress { name address1 address2 city zip countryCodeV2 phone }
  lineItems(first: 100) {
   pageInfo { hasNextPage }
   edges { node { id title quantity variant { title } } }
  }
 }
}`;
function obj(v: unknown): Record<string,unknown> | null {
 return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string,unknown> : null;
}
function field(v: unknown, max=300): v is string {return typeof v === 'string' && v.length<=max;}
export function makeDriverOrderDetailsReaderV2292(transport: Transport) {
 return async (id: string): Promise<DriverOrderDetailV2292 | null> => {
  if (!GID.test(id)) throw Error('V2292_INVALID_ORDER_ID');
  const envelope=obj(await transport(Q,{id}));
  if (!envelope || (Array.isArray(envelope.errors) && envelope.errors.length>0)) throw Error('V2292_GRAPHQL_FAILURE');
  const data=obj(envelope.data);
  if (!data) throw Error('V2292_INVALID_RESPONSE');
  if (data.order===null) return null;
  const order=obj(data.order), items=obj(order?.lineItems), page=obj(items?.pageInfo);
  if (!order || order.id!==id || !field(order.name,80) || !items || !page || page.hasNextPage!==false || !Array.isArray(items.edges) || items.edges.length>100)
   throw Error('V2292_INCOMPLETE_ORDER_DETAILS');
  const lines: DriverOrderDetailV2292['lines']=[];
  for (const edge of items.edges) {
   const node=obj(obj(edge)?.node);
   const variant=node?.variant===null ? null : obj(node?.variant);
   if (!node || !field(node.id,120) || !/^gid:\/\/shopify\/LineItem\/[1-9][0-9]*$/.test(node.id) ||
       !field(node.title) || typeof node.quantity!=='number' || !Number.isSafeInteger(node.quantity) || node.quantity<1 ||
       (node.variant!==null && (!variant || !field(variant.title,300))))
    throw Error('V2292_INVALID_LINE_ITEM');
   lines.push({id:node.id,title:node.title,quantity:node.quantity,variantTitle:variant===null?null:variant.title as string});
  }
  let shippingAddress: DriverOrderDetailV2292['shippingAddress']=null;
  if (order.shippingAddress!==null) {
   const a=obj(order.shippingAddress);
   if (!a || !field(a.name) || !field(a.address1) || !field(a.city) || !field(a.zip,40) ||
       !field(a.countryCodeV2,2) || !/^[A-Z]{2}$/.test(a.countryCodeV2) ||
       !(a.address2===null || field(a.address2)) || !(a.phone===null || field(a.phone,80)))
    throw Error('V2292_INVALID_SHIPPING_ADDRESS');
   shippingAddress={name:a.name,address1:a.address1,address2:a.address2 as string|null,city:a.city,zip:a.zip,countryCodeV2:a.countryCodeV2,phone:a.phone as string|null};
  }
  return {id,name:order.name,shippingAddress,lines};
 };
}
export const readDriverOrderDetailsV2292=makeDriverOrderDetailsReaderV2292(shopifyOrderReadTransportV2290);

import type { DriverOrderDetailV2292 } from '../../integrations/shopify/aloNowDriverOrderDetails.v2292.js';
export type DriverDetailDepsV2292={
 getDelivery:(id:string)=>Promise<{assigned_driver_user_id:string|null;delivery_status:string}|null>;
 readOrder:(id:string)=>Promise<DriverOrderDetailV2292|null>;
};
export async function getAssignedDriverOrderDetailV2292(orderNumber:string,staffId:string,deps:DriverDetailDepsV2292) {
 if (!/^[1-9][0-9]{0,18}$/.test(orderNumber) || !/^[1-9][0-9]{0,18}$/.test(staffId))
  throw Error('V2292_INVALID_CONTEXT');
 const id=`gid://shopify/Order/${orderNumber}`;
 const delivery=await deps.getDelivery(id);
 if (!delivery || String(delivery.assigned_driver_user_id??'')!==staffId ||
   !['DRIVER_ASSIGNED','READY_FOR_PICKUP','PICKED_UP','ON_THE_WAY'].includes(delivery.delivery_status)) return null;
 const detail=await deps.readOrder(id);
 if (!detail) return null;
 if (detail.id!==id) throw Error('V2292_ORDER_ID_MISMATCH');
 return {deliveryStatus:delivery.delivery_status,order:detail};
}

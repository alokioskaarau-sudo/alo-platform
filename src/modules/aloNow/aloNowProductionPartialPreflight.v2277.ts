// V2277: Read-only preflight. This function NEVER authorizes or dispatches a fulfillment.
// It does not register an HTTP route or perform a Shopify mutation.
import {orderLockKeyV1643, type OrderLockPoolV1643} from "./aloNowOrderLock.v1643.js";
import {readReservedSnapshotV1645} from "./aloNowReservedSnapshot.v1645.js";
import {buildPartialDispatchPlanV1641} from "./aloNowPartialDispatchPlan.v1641.js";
import {inspectPartialPaymentV1649} from "./aloNowPartialPaymentEvidence.v1649.js";

type ShopOrder = NonNullable<Awaited<ReturnType<NonNullable<Parameters<typeof inspectPartialPaymentV1649>[1]["readShopifyOrder"]>>>>;
export type PartialPreflightDependenciesV2277 = {
  pool: OrderLockPoolV1643;
  readShopifyOrder: (shopifyOrderId: string) => Promise<ShopOrder | null>;
  readWorkflow: (shopifyOrderId: string) => Promise<{pack_status:string} | null>;
  classifyFulfillment: (order: ShopOrder) => string;
};

export async function inspectProductionPartialPreflightV2277(
  input: {shopifyOrderId:string; staffUserId:string},
  deps: PartialPreflightDependenciesV2277
): Promise<{ok:true; status:"PREFLIGHT_ONLY_NOT_AUTHORIZED"; pendingFulfillmentOrders:number}> {
  const orderId=input?.shopifyOrderId;
  const staffId=input?.staffUserId;
  if (!/^gid:\/\/shopify\/Order\/[1-9]\d*$/.test(orderId??"") ||
      !/^[1-9]\d*$/.test(staffId??"") ||
      typeof deps?.pool?.connect!=="function" ||
      typeof deps.readShopifyOrder!=="function" ||
      typeof deps.readWorkflow!=="function" ||
      typeof deps.classifyFulfillment!=="function") {
    throw new Error("INVALID_V2277_PREFLIGHT_CONTEXT");
  }
  const client=await deps.pool.connect();
  let attempted=false,locked=false,unlocked=false;
  try {
    attempted=true;
    await client.query("SELECT pg_advisory_lock($1::bigint)",[orderLockKeyV1643(orderId)]);
    locked=true;
    // Uses THIS lock-owning session for its own read-only transaction.
    const snapshot=await readReservedSnapshotV1645(client,orderId,staffId);
    // Trusted readers must be supplied by server code, never by the request body.
    const payment=await inspectPartialPaymentV1649(orderId,{
      db:client,
      readShopifyOrder:deps.readShopifyOrder,
      readWorkflow:deps.readWorkflow,
      classifyFulfillment:deps.classifyFulfillment,
    });
    if (payment.status!=="ONLINE_PAYMENT_PRECHECK_PASSED") throw new Error("PAYMENT_NOT_VERIFIED");
    const plan=buildPartialDispatchPlanV1641(snapshot);
    return {ok:true,status:"PREFLIGHT_ONLY_NOT_AUTHORIZED",pendingFulfillmentOrders:plan.payloads.length};
  } finally {
    if (locked) {
      try {
        const result=await client.query("SELECT pg_advisory_unlock($1::bigint) AS released",[orderLockKeyV1643(orderId)]);
        unlocked=result.rows[0]?.released===true;
      } catch {unlocked=false;}
    }
    // Do not reuse a session whose lock state is uncertain.
    client.release(attempted&&!unlocked);
    if (locked&&!unlocked) throw new Error("V2277_LOCK_RELEASE_UNCERTAIN");
  }
}

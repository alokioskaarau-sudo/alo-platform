// V2281: Local-only proof of same-session order lock, payment verification and journal dispatch.
// NOT an HTTP route and NOT authorized for production. Real Shopify calls are NEVER wired here.
import {orderLockKeyV1643, type OrderLockPoolV1643} from "./aloNowOrderLock.v1643.js";
import {readReservedSnapshotV1645} from "./aloNowReservedSnapshot.v1645.js";
import {inspectPartialPaymentV1649} from "./aloNowPartialPaymentEvidence.v1649.js";
import {buildPartialDispatchPlanV1641} from "./aloNowPartialDispatchPlan.v1641.js";
import {dispatchJournalEntryV1592, type FulfillmentTransportV1592} from "./aloNowJournalDispatch.v1592.js";

type ShopifyOrder = NonNullable<Awaited<ReturnType<NonNullable<Parameters<typeof inspectPartialPaymentV1649>[1]["readShopifyOrder"]>>>>;
export type LocalSessionDepsV2281 = {
  pool: OrderLockPoolV1643;
  readShopifyOrder: (orderId:string) => Promise<ShopifyOrder | null>;
  readWorkflow: (orderId:string) => Promise<{pack_status:string}|null>;
  classifyFulfillment: (order:ShopifyOrder)=>string;
  // IN TESTS ONLY: injected fake transport, never real Shopify transport.
  testOnlyCreateFulfillment: FulfillmentTransportV1592;
};

export async function executeLocalSessionDispatchV2281(
  input:{shopifyOrderId:string;staffUserId:string},
  deps:LocalSessionDepsV2281
):Promise<{ok:true;mode:"ALREADY_CONFIRMED"|"LOCAL_TEST_DISPATCHED";dispatchedCount:number}> {
  // Hard gate before acquiring DB session. Never enable this on Railway.
  if (process.env.NODE_ENV !== "test" ||
      process.env.ALO_NOW_V2281_LOCAL_DISPATCH_TEST !== "true") {
    throw new Error("V2281_PRODUCTION_DISPATCH_FORBIDDEN");
  }
  const order=input?.shopifyOrderId;
  const staff=input?.staffUserId;
  if (!/^gid:\/\/shopify\/Order\/[1-9]\d*$/.test(order??"") ||
      !/^[1-9]\d*$/.test(staff??"") ||
      typeof deps?.pool?.connect!=="function" ||
      typeof deps.readShopifyOrder!=="function" ||
      typeof deps.readWorkflow!=="function" ||
      typeof deps.classifyFulfillment!=="function" ||
      typeof deps.testOnlyCreateFulfillment!=="function") {
    throw new Error("V2281_INVALID_TRUSTED_DEPENDENCIES");
  }
  const client=await deps.pool.connect();
  const key=orderLockKeyV1643(order);
  let attempted=false, locked=false, unlocked=false, destroy=false;
  try {
    attempted=true;
    await client.query("SELECT pg_advisory_lock($1::bigint)",[key]);
    locked=true;
    // Read snapshot and payment using the lock-owning session.
    const snapshot=await readReservedSnapshotV1645(client,order,staff);
    const verified=await inspectPartialPaymentV1649(order,{
      db:client,
      readShopifyOrder:deps.readShopifyOrder,
      readWorkflow:deps.readWorkflow,
      classifyFulfillment:deps.classifyFulfillment,
    });
    if (verified.status!=="ONLINE_PAYMENT_PRECHECK_PASSED") {
      throw new Error("V2281_PAYMENT_NOT_CONFIRMED");
    }
    const plan=buildPartialDispatchPlanV1641(snapshot);
    if (plan.action==="ALREADY_CONFIRMED") {
      return {ok:true,mode:"ALREADY_CONFIRMED",dispatchedCount:0};
    }
    let count=0;
    for (const payload of plan.payloads) {
      // Same client owns advisory lock AND records durable journal transitions.
      await dispatchJournalEntryV1592({
        db:client,payload,createFulfillment:deps.testOnlyCreateFulfillment
      });
      count++;
    }
    return {ok:true,mode:"LOCAL_TEST_DISPATCHED",dispatchedCount:count};
  } catch(error) {
    const message=error instanceof Error?error.message:"";
    if (message==="SNAPSHOT_ROLLBACK_UNCERTAIN_DESTROY_CLIENT" ||
        message==="JOURNAL_CLAIM_ROLLBACK_UNCERTAIN" ||
        message==="SHOPIFY_RESULT_UNCERTAIN_AND_JOURNAL_UNCERTAIN") {
      destroy=true;
    }
    throw error;
  } finally {
    if (locked) {
      try {
        const result=await client.query("SELECT pg_advisory_unlock($1::bigint) AS released",[key]);
        unlocked=result.rows[0]?.released===true;
      } catch {unlocked=false;}
    }
    if (attempted && !unlocked) destroy=true;
    client.release(destroy);
    if (locked && !unlocked) throw new Error("V2281_UNLOCK_UNCERTAIN");
  }
}

// ALO_NOW_V1642_ISOLATED_ORCHESTRATOR
// NOT registered in an API route.
// Database, lock and Shopify transport are injected.
// The production lock adapter is NOT implemented here.

import {
  buildPartialDispatchPlanV1641,
} from "./aloNowPartialDispatchPlan.v1641.js";

import {
  dispatchJournalEntryV1592,
  type JournalDbV1592,
  type FulfillmentTransportV1592,
} from "./aloNowJournalDispatch.v1592.js";

type Snapshot = Parameters<
  typeof buildPartialDispatchPlanV1641
>[0];

type Dependencies = {
  withOrderLock: <T>(
    shopifyOrderId: string,
    operation: () => Promise<T>
  ) => Promise<T>;

  loadReservedSnapshot: (
    shopifyOrderId: string,
    staffUserId: string
  ) => Promise<Snapshot>;

  db: JournalDbV1592;
  createFulfillment: FulfillmentTransportV1592;
};

export async function executePartialDispatchV1642(
  request: {
    shopifyOrderId: string;
    staffUserId: string;
  },
  dependencies: Dependencies
): Promise<{
  ok: true;
  mode: "ALREADY_CONFIRMED" | "DISPATCHED";
  dispatchedCount: number;
}> {
  if (
    !/^gid:\/\/shopify\/Order\/[1-9]\d*$/.test(
      request?.shopifyOrderId ?? ""
    ) ||
    !/^[1-9]\d*$/.test(
      request?.staffUserId ?? ""
    ) ||
    !dependencies ||
    typeof dependencies.withOrderLock !== "function" ||
    typeof dependencies.loadReservedSnapshot !== "function" ||
    !dependencies.db ||
    typeof dependencies.createFulfillment !== "function"
  ) {
    throw new Error("INVALID_PARTIAL_DISPATCH_REQUEST");
  }

  return dependencies.withOrderLock(
    request.shopifyOrderId,
    async () => {
      // Must be loaded freshly while the order lock is held.
      // The future production adapter MUST check driver ownership,
      // payment/workflow status and the reserved selection.
      const snapshot =
        await dependencies.loadReservedSnapshot(
          request.shopifyOrderId,
          request.staffUserId
        );

      if (
        !snapshot ||
        snapshot.shopifyOrderId !== request.shopifyOrderId
      ) {
        throw new Error("DISPATCH_ORDER_MISMATCH");
      }

      const plan = buildPartialDispatchPlanV1641(
        snapshot
      );

      if (plan.action === "ALREADY_CONFIRMED") {
        return {
          ok: true as const,
          mode: "ALREADY_CONFIRMED" as const,
          dispatchedCount: 0,
        };
      }

      let dispatchedCount = 0;

      // Sequential execution: stop on first uncertain result.
      for (const payload of plan.payloads) {
        await dispatchJournalEntryV1592({
          payload,
          db: dependencies.db,
          createFulfillment:
            dependencies.createFulfillment,
        });
        dispatchedCount++;
      }

      return {
        ok: true as const,
        mode: "DISPATCHED" as const,
        dispatchedCount,
      };
    }
  );
}

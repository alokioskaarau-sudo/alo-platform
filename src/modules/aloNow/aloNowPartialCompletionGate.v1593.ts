// ALO_NOW_V1593_PARTIAL_COMPLETION_GATE
// Pure aggregate journal verification.
// No database, Shopify, payment, refund or delivery writes.
// This does NOT authorize normal full-delivery completion.

import {
  fingerprintJournalPayloadV1586,
} from "./aloNowFulfillmentJournal.v1586.js";
import type {
  SplitFulfillmentEntryV1585,
} from "./aloNowSplitFulfillment.v1585.js";

export type JournalRecordV1593 = {
  fulfillmentOrderId: string;
  selectionHash: string;
  payloadHash: string;
  state:
    | "PREPARED"
    | "DISPATCHING"
    | "CONFIRMED"
    | "RECONCILE_REQUIRED";
  shopifyFulfillmentId: string | null;
};

export type PartialCompletionDecisionV1593 =
  | "READY_FOR_SETTLEMENT_REVIEW"
  | "WAITING_FOR_DISPATCH"
  | "RECONCILE_REQUIRED";

export function inspectPartialCompletionV1593(input: {
  shopifyOrderId: string;
  selectionHash: string;
  expectedFulfillments: SplitFulfillmentEntryV1585[];
  journal: JournalRecordV1593[];
}): {
  decision: PartialCompletionDecisionV1593;
  confirmedCount: number;
  totalCount: number;
  unresolvedFulfillmentOrderIds: string[];
} {
  const orderId = input?.shopifyOrderId;
  const hash = input?.selectionHash;

  if (
    typeof orderId !== "string" ||
    !orderId.trim() ||
    orderId !== orderId.trim() ||
    typeof hash !== "string" ||
    !/^[a-f0-9]{64}$/.test(hash) ||
    !Array.isArray(input.expectedFulfillments) ||
    input.expectedFulfillments.length === 0 ||
    !Array.isArray(input.journal)
  ) {
    throw new Error("INVALID_COMPLETION_INPUT");
  }

  const expected = new Map<string, string>();

  for (const entry of input.expectedFulfillments) {
    const id = entry?.fulfillmentOrderId;

    if (
      typeof id !== "string" ||
      !id.trim() ||
      id !== id.trim() ||
      expected.has(id)
    ) {
      throw new Error("DUPLICATE_OR_INVALID_FULFILLMENT_ORDER");
    }

    const payloadHash = fingerprintJournalPayloadV1586({
      shopifyOrderId: orderId,
      fulfillmentOrderId: id,
      selectionHash: hash,
      lines: entry.fulfillmentOrderLineItems,
    });

    expected.set(id, payloadHash);
  }

  if (input.journal.length !== expected.size) {
    throw new Error("INCOMPLETE_OR_EXTRA_JOURNAL");
  }

  const seen = new Set<string>();
  const fulfillmentIds = new Set<string>();
  const unresolved: string[] = [];

  let confirmedCount = 0;
  let needsReconciliation = false;
  let waiting = false;

  for (const row of input.journal) {
    const id = row?.fulfillmentOrderId;

    if (
      typeof id !== "string" ||
      !expected.has(id) ||
      seen.has(id) ||
      row.selectionHash !== hash ||
      row.payloadHash !== expected.get(id)
    ) {
      throw new Error("JOURNAL_IDENTITY_OR_PAYLOAD_MISMATCH");
    }

    seen.add(id);

    switch (row.state) {
      case "CONFIRMED":
        if (
          typeof row.shopifyFulfillmentId !== "string" ||
          !row.shopifyFulfillmentId.startsWith(
            "gid://shopify/Fulfillment/"
          ) ||
          fulfillmentIds.has(row.shopifyFulfillmentId)
        ) {
          throw new Error("INVALID_CONFIRMED_FULFILLMENT");
        }
        fulfillmentIds.add(row.shopifyFulfillmentId);
        confirmedCount++;
        break;

      case "PREPARED":
        if (row.shopifyFulfillmentId !== null) {
          throw new Error("UNEXPECTED_FULFILLMENT_ID");
        }
        waiting = true;
        unresolved.push(id);
        break;

      case "DISPATCHING":
      case "RECONCILE_REQUIRED":
        needsReconciliation = true;
        unresolved.push(id);
        break;

      default:
        throw new Error("UNKNOWN_JOURNAL_STATE");
    }
  }

  for (const id of expected.keys()) {
    if (!seen.has(id)) {
      throw new Error("MISSING_FULFILLMENT_JOURNAL");
    }
  }

  return {
    decision: needsReconciliation
      ? "RECONCILE_REQUIRED"
      : waiting
        ? "WAITING_FOR_DISPATCH"
        : "READY_FOR_SETTLEMENT_REVIEW",
    confirmedCount,
    totalCount: expected.size,
    unresolvedFulfillmentOrderIds: unresolved,
  };
}

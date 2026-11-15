// ALO_NOW_V1598_EVIDENCE_COORDINATOR
// Pure, fail-closed reconciliation. No DB/HTTP/Shopify calls.
// This DOES NOT authorize delivery completion or refunds.

import {
  inspectPartialCompletionV1593,
  type JournalRecordV1593,
} from "./aloNowPartialCompletionGate.v1593.js";
import {
  verifyShopifyEvidenceV1596,
} from "./aloNowShopifyEvidence.v1596.js";

type PlanEntry = {
  fulfillmentOrderId: string;
  fulfillmentOrderLineItems: Array<{
    id: string;
    quantity: number;
    shopifyLineItemId: string;
  }>;
};

type FulfillmentOrderSnapshot = {
  nodes: Array<{
    id: string;
    lineItems: {
      nodes: Array<{
        id: string;
        lineItem: {id: string} | null;
      }>;
      pageInfo: {hasNextPage: boolean};
    };
  }>;
  pageInfo: {hasNextPage: boolean};
};

type Evidence = {
  shopifyOrderId: string;
  fulfillmentsHasNextPage: boolean;
  fulfillments: Array<{
    id: string;
    status: string;
    hasNextPage: boolean;
    lines: Array<{
      shopifyLineItemId: string;
      quantity: number;
    }>;
  }>;
  fulfillmentCount: number;
};

export function reconcilePartialHandoffV1598(input: {
  shopifyOrderId: string;
  selectionHash: string;
  expectedFulfillments: PlanEntry[];
  journal: JournalRecordV1593[];
  // Optional diagnostic data. Not authoritative for line
  // identity after Shopify fulfillment.
  fulfillmentOrders?: FulfillmentOrderSnapshot;
  shopifyEvidence: Evidence;
}) {
  if (
    !input ||
    !/^gid:\/\/shopify\/Order\/[1-9]\d*$/.test(
      input.shopifyOrderId ?? ""
    ) ||
    input.shopifyEvidence?.shopifyOrderId !==
      input.shopifyOrderId ||
    input.shopifyEvidence?.fulfillmentCount !==
      input.shopifyEvidence?.fulfillments?.length ||
    input.shopifyEvidence?.fulfillmentsHasNextPage !== false
  ) {
    throw new Error("INCOMPLETE_OR_MISMATCHED_EVIDENCE");
  }

  // Validate the immutable manifest against all journal entries.
  const gate = inspectPartialCompletionV1593({
    shopifyOrderId: input.shopifyOrderId,
    selectionHash: input.selectionHash,
    expectedFulfillments: input.expectedFulfillments,
    journal: input.journal,
  });

  if (gate.decision !== "READY_FOR_SETTLEMENT_REVIEW") {
    return {
      ok: false as const,
      decision: gate.decision,
      confirmedCount: gate.confirmedCount,
      totalCount: gate.totalCount,
      settlementAuthorized: false as const,
    };
  }

  // ALO_NOW_V1601_PERSISTED_LINE_IDENTITIES
  // Shopify may change fulfillment-order snapshots after
  // fulfillment. Only the saved original manifest is used.
  const journalByOrder = new Map(
    input.journal.map(row => [
      row.fulfillmentOrderId, row,
    ])
  );

  const identities: Array<{
    fulfillmentOrderId: string;
    fulfillmentOrderLineItemId: string;
    shopifyLineItemId: string;
  }> = [];

  const expected = input.expectedFulfillments.map(entry => {
    const record = journalByOrder.get(
      entry.fulfillmentOrderId
    );

    if (!record?.shopifyFulfillmentId) {
      throw new Error("MISSING_EXPECTED_SHOPIFY_REFERENCE");
    }

    const mappedLines = entry.fulfillmentOrderLineItems.map(
      line => {
        const shopifyLineItemId = line.shopifyLineItemId;

        if (
          typeof shopifyLineItemId !== "string" ||
          !/^gid:\/\/shopify\/LineItem\/[1-9]\d*$/.test(
            shopifyLineItemId
          )
        ) {
          throw new Error("MISSING_EXPECTED_LINE_MAPPING");
        }

        identities.push({
          fulfillmentOrderId: entry.fulfillmentOrderId,
          fulfillmentOrderLineItemId: line.id,
          shopifyLineItemId,
        });

        return {
          fulfillmentOrderLineItemId: line.id,
          quantity: line.quantity,
        };
      }
    );

    return {
      fulfillmentOrderId: entry.fulfillmentOrderId,
      shopifyFulfillmentId: record.shopifyFulfillmentId,
      lines: mappedLines,
    };
  });

  const verified = verifyShopifyEvidenceV1596({
    expected,
    identities,
    fulfillments: input.shopifyEvidence.fulfillments,
    fulfillmentsHasNextPage:
      input.shopifyEvidence.fulfillmentsHasNextPage,
  });

  return {
    ok: true as const,
    decision: "SHOPIFY_EVIDENCE_MATCHED" as const,
    confirmedCount: gate.confirmedCount,
    totalCount: gate.totalCount,
    verifiedUnits: verified.verifiedUnits,
    // A match authorizes review only, never an automatic refund.
    settlementAuthorized: false as const,
  };
}

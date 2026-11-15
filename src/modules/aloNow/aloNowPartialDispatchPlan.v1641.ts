// ALO_NOW_V1641_SAFE_DISPATCH_PLAN
// Pure validation. No DB, HTTP or Shopify calls.
// This does NOT authorize a handoff or acquire an order lock.

import {
  fingerprintJournalPayloadV1586,
  type JournalPayloadV1586,
  type JournalStateV1586,
} from "./aloNowFulfillmentJournal.v1586.js";

type ManifestEntry = {
  fulfillmentOrderId: string;
  fulfillmentOrderLineItems: Array<{
    id: string;
    quantity: number;
    shopifyLineItemId?: string;
  }>;
};

type JournalEntry = {
  fulfillmentOrderId: string;
  selectionHash: string;
  payloadHash: string;
  fulfillmentLines: unknown;
  state: JournalStateV1586;
  shopifyFulfillmentId: string | null;
};

export function buildPartialDispatchPlanV1641(input: {
  shopifyOrderId: string;
  selectionHash: string;
  selectionState: string;
  manifest: ManifestEntry[];
  journal: JournalEntry[];
}): {
  action: "DISPATCH_READY" | "ALREADY_CONFIRMED";
  payloads: JournalPayloadV1586[];
} {
  if (
    !input ||
    !/^gid:\/\/shopify\/Order\/[1-9]\d*$/.test(
      input.shopifyOrderId
    ) ||
    !/^[a-f0-9]{64}$/.test(input.selectionHash) ||
    !["PREPARED", "IN_PROGRESS"].includes(
      input.selectionState
    ) ||
    !Array.isArray(input.manifest) ||
    !Array.isArray(input.journal) ||
    input.manifest.length === 0 ||
    input.manifest.length !== input.journal.length
  ) {
    throw new Error("INVALID_DISPATCH_SNAPSHOT");
  }

  const expected = new Map<string, JournalPayloadV1586>();

  for (const entry of input.manifest) {
    if (
      !entry ||
      typeof entry.fulfillmentOrderId !== "string" ||
      !/^gid:\/\/shopify\/FulfillmentOrder\/[1-9]\d*$/.test(
        entry.fulfillmentOrderId
      ) ||
      expected.has(entry.fulfillmentOrderId)
    ) {
      throw new Error("INVALID_OR_DUPLICATE_MANIFEST");
    }

    const payload: JournalPayloadV1586 = {
      shopifyOrderId: input.shopifyOrderId,
      fulfillmentOrderId: entry.fulfillmentOrderId,
      selectionHash: input.selectionHash,
      lines: entry.fulfillmentOrderLineItems.map(line => ({
        id: line.id,
        quantity: line.quantity,
      })),
    };

    fingerprintJournalPayloadV1586(payload);
    expected.set(entry.fulfillmentOrderId, payload);
  }

  const seen = new Set<string>();
  const payloads: JournalPayloadV1586[] = [];
  let confirmed = 0;

  for (const row of input.journal) {
    const payload = expected.get(row.fulfillmentOrderId);

    if (!payload || seen.has(row.fulfillmentOrderId)) {
      throw new Error("EXTRA_OR_DUPLICATE_JOURNAL");
    }

    seen.add(row.fulfillmentOrderId);

    if (
      row.selectionHash !== input.selectionHash ||
      row.payloadHash !==
        fingerprintJournalPayloadV1586(payload) ||
      !Array.isArray(row.fulfillmentLines)
    ) {
      throw new Error("JOURNAL_PAYLOAD_MISMATCH");
    }

    const saved: JournalPayloadV1586 = {
      ...payload,
      lines: row.fulfillmentLines.map((line: any) => ({
        id: line?.id,
        quantity: line?.quantity,
      })),
    };

    if (
      fingerprintJournalPayloadV1586(saved) !== row.payloadHash
    ) {
      throw new Error("JOURNAL_LINES_CHANGED");
    }

    if (
      row.state === "DISPATCHING" ||
      row.state === "RECONCILE_REQUIRED"
    ) {
      throw new Error("JOURNAL_RECONCILIATION_REQUIRED");
    }

    if (row.state === "CONFIRMED") {
      if (
        typeof row.shopifyFulfillmentId !== "string" ||
        !/^gid:\/\/shopify\/Fulfillment\/[1-9]\d*$/.test(
          row.shopifyFulfillmentId
        )
      ) {
        throw new Error("INVALID_CONFIRMED_JOURNAL");
      }
      confirmed++;
      continue;
    }

    if (
      row.state !== "PREPARED" ||
      row.shopifyFulfillmentId !== null
    ) {
      throw new Error("INVALID_DISPATCH_STATE");
    }

    payloads.push(payload);
  }

  if (seen.size !== expected.size) {
    throw new Error("INCOMPLETE_JOURNAL");
  }

  if (confirmed > 0 && payloads.length > 0) {
    throw new Error("PARTIAL_DISPATCH_NEEDS_REVIEW");
  }

  payloads.sort((a, b) =>
    a.fulfillmentOrderId.localeCompare(b.fulfillmentOrderId)
  );

  return {
    action: payloads.length
      ? "DISPATCH_READY"
      : "ALREADY_CONFIRMED",
    payloads,
  };
}

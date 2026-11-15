// ALO_NOW_V1586_FULFILLMENT_JOURNAL
// Pure journal guard. No database, Shopify or payment calls.

import {createHash} from "node:crypto";

export type JournalStateV1586 =
  | "PREPARED"
  | "DISPATCHING"
  | "CONFIRMED"
  | "RECONCILE_REQUIRED";

export type JournalEntryV1586 = {
  shopifyOrderId: string;
  fulfillmentOrderId: string;
  selectionHash: string;
  payloadHash: string;
  state: JournalStateV1586;
};

export type JournalPayloadV1586 = {
  shopifyOrderId: string;
  fulfillmentOrderId: string;
  selectionHash: string;
  lines: Array<{id: string; quantity: number}>;
};

function id(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value !== value.trim()
  ) throw new Error("INVALID_JOURNAL_IDENTITY");
  return value;
}

export function fingerprintJournalPayloadV1586(
  input: JournalPayloadV1586
): string {
  const orderId = id(input?.shopifyOrderId);
  const fulfillmentId = id(input?.fulfillmentOrderId);
  const selectionHash = id(input?.selectionHash);

  if (
    !/^[a-f0-9]{64}$/.test(selectionHash) ||
    !Array.isArray(input.lines) ||
    input.lines.length === 0
  ) throw new Error("INVALID_JOURNAL_PAYLOAD");

  const seen = new Set<string>();

  const lines = input.lines.map(line => {
    const lineId = id(line?.id);
    const quantity = line?.quantity;

    if (
      seen.has(lineId) ||
      !Number.isSafeInteger(quantity) ||
      quantity < 1
    ) throw new Error("INVALID_JOURNAL_LINE");

    seen.add(lineId);
    return {id: lineId, quantity};
  }).sort((a,b) => a.id.localeCompare(b.id));

  const canonical = JSON.stringify({
    shopifyOrderId: orderId,
    fulfillmentOrderId: fulfillmentId,
    selectionHash,
    lines,
  });

  return createHash("sha256")
    .update(canonical)
    .digest("hex");
}

export function decideJournalActionV1586(input: {
  existing: JournalEntryV1586 | null;
  payload: JournalPayloadV1586;
}): "PREPARE_NEW" | "SAFE_TO_DISPATCH" |
    "ALREADY_CONFIRMED" | "MANUAL_RECONCILIATION" {
  const hash = fingerprintJournalPayloadV1586(input.payload);
  const existing = input.existing;

  if (!existing) return "PREPARE_NEW";

  if (
    existing.shopifyOrderId !== input.payload.shopifyOrderId ||
    existing.fulfillmentOrderId !== input.payload.fulfillmentOrderId ||
    existing.selectionHash !== input.payload.selectionHash ||
    existing.payloadHash !== hash
  ) throw new Error("JOURNAL_IDEMPOTENCY_CONFLICT");

  switch (existing.state) {
    case "PREPARED":
      return "SAFE_TO_DISPATCH";
    case "CONFIRMED":
      return "ALREADY_CONFIRMED";
    case "DISPATCHING":
    case "RECONCILE_REQUIRED":
      return "MANUAL_RECONCILIATION";
    default:
      throw new Error("UNKNOWN_JOURNAL_STATE");
  }
}

export function assertJournalTransitionV1586(
  from: JournalStateV1586,
  to: JournalStateV1586
): void {
  const allowed: Record<JournalStateV1586, JournalStateV1586[]> = {
    PREPARED: ["DISPATCHING"],
    DISPATCHING: ["CONFIRMED", "RECONCILE_REQUIRED"],
    CONFIRMED: [],
    RECONCILE_REQUIRED: [],
  };

  if (!allowed[from]?.includes(to)) {
    throw new Error("INVALID_JOURNAL_TRANSITION");
  }
}

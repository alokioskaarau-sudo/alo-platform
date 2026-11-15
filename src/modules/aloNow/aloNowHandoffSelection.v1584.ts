// ALO_NOW_V1584_HANDOFF_SELECTION
// Pure server-side handoff planning.
// Never trusts client age classification.
// No Shopify, DB, payment or delivery writes.

import type {
  HandoffPlan,
} from "./aloNowPartialHandoff.v1560.js";

export type RequestedWithheldV1584 = {
  lineItemId: string;
  quantity: number;
};

export function buildHandoffSelectionV1584(input: {
  // Must be computed by the server from fresh Shopify data.
  baseline: HandoffPlan;
  // Driver-selected additional non-handoff quantities.
  requestedWithheld: RequestedWithheldV1584[];
}): HandoffPlan {
  const {baseline, requestedWithheld} = input;

  if (
    !baseline ||
    !Array.isArray(baseline.delivered) ||
    !Array.isArray(baseline.withheld) ||
    ![0, 16, 18].includes(baseline.verifiedAgeLevel) ||
    !Array.isArray(requestedWithheld)
  ) {
    throw new Error("INVALID_SELECTION_INPUT");
  }

  const ordered: string[] = [];
  const allowed = new Map<string, number>();
  const forced = new Set<string>();

  for (const [kind, lines] of [
    ["delivered", baseline.delivered],
    ["withheld", baseline.withheld],
  ] as const) {
    for (const line of lines) {
      const id = line?.lineItemId;
      const quantity = line?.quantity;

      if (
        typeof id !== "string" ||
        !id.trim() ||
        id !== id.trim() ||
        allowed.has(id) ||
        !Number.isSafeInteger(quantity) ||
        quantity < 1
      ) {
        throw new Error("INVALID_BASELINE_LINE");
      }

      allowed.set(id, quantity);
      ordered.push(id);

      if (kind === "withheld") {
        forced.add(id);
      }
    }
  }

  if (ordered.length === 0) {
    throw new Error("EMPTY_HANDOFF_ORDER");
  }

  const desired = new Map<string, number>();

  for (const selected of requestedWithheld) {
    const id = selected?.lineItemId;
    const quantity = selected?.quantity;

    if (
      typeof id !== "string" ||
      !allowed.has(id) ||
      desired.has(id) ||
      !Number.isSafeInteger(quantity) ||
      quantity < 1 ||
      quantity > allowed.get(id)!
    ) {
      throw new Error("INVALID_REQUESTED_WITHHELD_LINE");
    }

    desired.set(id, quantity);
  }

  const delivered: HandoffPlan["delivered"] = [];
  const withheld: HandoffPlan["withheld"] = [];

  for (const id of ordered) {
    const quantity = allowed.get(id)!;
    const nonHandoff = forced.has(id)
      ? quantity
      : desired.get(id) ?? 0;

    const deliver = quantity - nonHandoff;

    if (deliver > 0) {
      delivered.push({lineItemId: id, quantity: deliver});
    }

    if (nonHandoff > 0) {
      withheld.push({lineItemId: id, quantity: nonHandoff});
    }
  }

  return {
    delivered,
    withheld,
    partial: delivered.length > 0 && withheld.length > 0,
    blocked: delivered.length === 0,
    verifiedAgeLevel: baseline.verifiedAgeLevel,
  };
}

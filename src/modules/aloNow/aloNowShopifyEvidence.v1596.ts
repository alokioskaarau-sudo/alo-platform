// ALO_NOW_V1596_SHOPIFY_EVIDENCE
// Pure Shopify fulfillment evidence verifier.
// No API calls and NO database or Shopify mutations.
// Future caller MUST fetch authoritative Shopify data.
// This result alone does not authorize settlement or refund.

export type ExpectedFulfillmentV1596 = {
  fulfillmentOrderId: string;
  shopifyFulfillmentId: string;
  lines: Array<{
    fulfillmentOrderLineItemId: string;
    quantity: number;
  }>;
};

export type LineIdentityV1596 = {
  fulfillmentOrderId: string;
  fulfillmentOrderLineItemId: string;
  shopifyLineItemId: string;
};

export type ShopifyFulfillmentEvidenceV1596 = {
  id: string;
  status: string;
  hasNextPage: boolean;
  lines: Array<{
    shopifyLineItemId: string;
    quantity: number;
  }>;
};

export type ShopifyEvidenceInputV1596 = {
  expected: ExpectedFulfillmentV1596[];
  identities: LineIdentityV1596[];
  fulfillments: ShopifyFulfillmentEvidenceV1596[];
  fulfillmentsHasNextPage: boolean;
};

function identity(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value !== value.trim()
  ) {
    throw new Error("INVALID_" + label);
  }
  return value;
}

function quantity(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1
  ) {
    throw new Error("INVALID_FULFILLMENT_QUANTITY");
  }
  return value as number;
}

function add(
  map: Map<string, number>,
  id: string,
  amount: number
) {
  const next = (map.get(id) ?? 0) + amount;
  if (!Number.isSafeInteger(next)) {
    throw new Error("QUANTITY_OVERFLOW");
  }
  map.set(id, next);
}

function sortedSignature(map: Map<string, number>) {
  return JSON.stringify(
    [...map.entries()].sort((a, b) =>
      a[0].localeCompare(b[0])
    )
  );
}

export function verifyShopifyEvidenceV1596(
  input: ShopifyEvidenceInputV1596
): {
  ok: true;
  status: "SHOPIFY_EVIDENCE_MATCHED";
  verifiedFulfillments: number;
  verifiedUnits: number;
} {
  if (
    !input ||
    !Array.isArray(input.expected) ||
    input.expected.length === 0 ||
    !Array.isArray(input.identities) ||
    !Array.isArray(input.fulfillments) ||
    input.fulfillmentsHasNextPage !== false
  ) {
    throw new Error("INCOMPLETE_SHOPIFY_EVIDENCE");
  }

  const mapping = new Map<string, string>();
  for (const line of input.identities) {
    const fo = identity(
      line?.fulfillmentOrderId, "FO_ID"
    );
    const fol = identity(
      line?.fulfillmentOrderLineItemId, "FOL_ID"
    );
    const shopifyLine = identity(
      line?.shopifyLineItemId, "SHOPIFY_LINE_ID"
    );
    const key = JSON.stringify([fo, fol]);

    if (mapping.has(key)) {
      throw new Error("DUPLICATE_LINE_MAPPING");
    }
    mapping.set(key, shopifyLine);
  }

  const actual = new Map<
    string, ShopifyFulfillmentEvidenceV1596
  >();

  for (const fulfillment of input.fulfillments) {
    const id = identity(
      fulfillment?.id, "SHOPIFY_FULFILLMENT_ID"
    );

    if (
      !id.startsWith("gid://shopify/Fulfillment/") ||
      actual.has(id) ||
      fulfillment.hasNextPage !== false ||
      !Array.isArray(fulfillment.lines)
    ) {
      throw new Error("INVALID_SHOPIFY_FULFILLMENT");
    }
    actual.set(id, fulfillment);
  }

  if (actual.size !== input.expected.length) {
    throw new Error("MISSING_OR_EXTRA_SHOPIFY_FULFILLMENT");
  }

  const seenOrders = new Set<string>();
  const seenFulfillments = new Set<string>();
  const usedMappings = new Set<string>();
  let units = 0;

  for (const entry of input.expected) {
    const fo = identity(
      entry?.fulfillmentOrderId, "EXPECTED_FO_ID"
    );
    const fulfillmentId = identity(
      entry?.shopifyFulfillmentId,
      "EXPECTED_SHOPIFY_FULFILLMENT_ID"
    );

    if (
      seenOrders.has(fo) ||
      seenFulfillments.has(fulfillmentId) ||
      !Array.isArray(entry.lines) ||
      entry.lines.length === 0
    ) {
      throw new Error("DUPLICATE_OR_EMPTY_EXPECTED_ENTRY");
    }

    seenOrders.add(fo);
    seenFulfillments.add(fulfillmentId);

    const evidence = actual.get(fulfillmentId);

    if (!evidence) {
      throw new Error("SHOPIFY_FULFILLMENT_NOT_FOUND");
    }

    if (evidence.status !== "SUCCESS") {
      throw new Error("SHOPIFY_FULFILLMENT_NOT_SUCCESSFUL");
    }

    const expectedAmounts = new Map<string, number>();
    const seenFols = new Set<string>();

    for (const line of entry.lines) {
      const fol = identity(
        line?.fulfillmentOrderLineItemId,
        "EXPECTED_FOL_ID"
      );
      const amount = quantity(line?.quantity);
      const key = JSON.stringify([fo, fol]);

      if (seenFols.has(fol)) {
        throw new Error("DUPLICATE_EXPECTED_FOL");
      }
      seenFols.add(fol);

      const shopifyLineId = mapping.get(key);
      if (!shopifyLineId) {
        throw new Error("MISSING_SHOPIFY_LINE_MAPPING");
      }

      usedMappings.add(key);
      add(expectedAmounts, shopifyLineId, amount);
      units += amount;

      if (!Number.isSafeInteger(units)) {
        throw new Error("TOTAL_QUANTITY_OVERFLOW");
      }
    }

    const actualAmounts = new Map<string, number>();
    const seenActualLines = new Set<string>();

    for (const line of evidence.lines) {
      const id = identity(
        line?.shopifyLineItemId, "ACTUAL_LINE_ID"
      );
      if (seenActualLines.has(id)) {
        throw new Error("DUPLICATE_ACTUAL_LINE");
      }
      seenActualLines.add(id);
      add(actualAmounts, id, quantity(line?.quantity));
    }

    if (
      sortedSignature(actualAmounts) !==
      sortedSignature(expectedAmounts)
    ) {
      throw new Error("SHOPIFY_FULFILLMENT_QUANTITY_MISMATCH");
    }
  }

  if (usedMappings.size !== mapping.size) {
    throw new Error("EXTRA_OR_UNUSED_LINE_MAPPING");
  }

  return {
    ok: true,
    status: "SHOPIFY_EVIDENCE_MATCHED",
    verifiedFulfillments: actual.size,
    verifiedUnits: units,
  };
}

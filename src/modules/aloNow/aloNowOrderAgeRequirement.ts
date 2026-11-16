import type {
  AloNowAgeRequirement,
} from "../../database/aloNowDeliveries.js";

export type AloNowOrderAgeRequirementResult = {
  ageRequirement: AloNowAgeRequirement;
  requiresAgeCheck: boolean;
  classified: boolean;
  unclassifiedLineItems: Array<{
    lineItemId: string | null;
    name: string | null;
    productId: string | null;
  }>;
};

function readProductAgeRequirement(
  lineItem: any
): AloNowAgeRequirement | null {
  const rawValue =
    lineItem
      ?.variant
      ?.product
      ?.ageRequirement
      ?.value;

  // V2308: no explicit age selection means unrestricted.
  // Preserve fail-closed handling when Shopify does not supply a product,
  // or an explicitly stored age value is invalid.
  if (!lineItem?.variant?.product) {
    return null;
  }

  if (rawValue == null || rawValue === "") {
    return "NONE";
  }

  if (
    rawValue === "NONE" ||
    rawValue === "AGE_16" ||
    rawValue === "AGE_18"
  ) {
    return rawValue;
  }

  return null;
}

export function getAloNowOrderAgeRequirement(
  order: any
): AloNowOrderAgeRequirementResult {
  const lineItems =
    order
      ?.lineItems
      ?.edges
      ?.map(
        (edge: any) =>
          edge?.node
      )
      ?.filter(Boolean) ??
    [];

  let ageRequirement:
    AloNowAgeRequirement = "NONE";

  const unclassifiedLineItems:
    AloNowOrderAgeRequirementResult[
      "unclassifiedLineItems"
    ] = [];

  for (const lineItem of lineItems) {
    const product =
      lineItem
        ?.variant
        ?.product;

    const requirement =
      readProductAgeRequirement(
        lineItem
      );

    if (!requirement) {
      unclassifiedLineItems.push({
        lineItemId:
          lineItem?.id ?? null,
        name:
          lineItem?.name ?? null,
        productId:
          product?.id ?? null,
      });

      continue;
    }

    if (requirement === "AGE_18") {
      ageRequirement = "AGE_18";
      continue;
    }

    if (
      requirement === "AGE_16" &&
      ageRequirement === "NONE"
    ) {
      ageRequirement = "AGE_16";
    }
  }

  return {
    ageRequirement,
    requiresAgeCheck:
      ageRequirement !== "NONE",
    classified:
      lineItems.length > 0 &&
      unclassifiedLineItems.length === 0,
    unclassifiedLineItems,
  };
}

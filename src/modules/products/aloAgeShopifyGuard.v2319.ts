// V2319: verify explicit age metadata against Shopify before catalog mutation / activation.
// A missing staff review is NOT evidence of explicit 16+/18+ classification.
export type AloAgeRequirementV2319 = "NONE" | "AGE_16" | "AGE_18";
type ShopifyRead = (query: string, variables: Record<string, any>) => Promise<any>;
export function requireReviewedAgeV2319(row: {
  age_requirement?: unknown;
  age_requirement_reviewed_at?: unknown;
}): AloAgeRequirementV2319 | null {
  const age = row.age_requirement;
  const reviewed = Boolean(row.age_requirement_reviewed_at);
  if (!reviewed) {
    // Inconsistent legacy DB record: never treat explicit restricted value as unrestricted.
    if (age === "AGE_16" || age === "AGE_18") {
      throw new Error("ALO_AGE_REVIEW_REQUIRED");
    }
    if (age !== null && age !== undefined && age !== "" && age !== "NONE") {
      throw new Error("ALO_AGE_VALUE_INVALID");
    }
    return null;
  }
  if (age !== "NONE" && age !== "AGE_16" && age !== "AGE_18") {
    throw new Error("ALO_AGE_VALUE_INVALID");
  }
  return age;
}
export async function verifyShopifyAgeV2319(
  shopifyGraphql: ShopifyRead,
  shopifyProductId: string,
  expected: AloAgeRequirementV2319
): Promise<void> {
  const data = await shopifyGraphql(`
    query AloV2319ReadVerifiedAge($id: ID!) {
      product(id: $id) {
        id
        ageRequirement: metafield(namespace: "alo", key: "age_requirement") { value }
      }
    }
  `, { id: shopifyProductId });
  if (data?.product?.id !== shopifyProductId ||
      data?.product?.ageRequirement?.value !== expected) {
    throw new Error("ALO_AGE_SHOPIFY_NOT_VERIFIED");
  }
}
export async function syncAndVerifyShopifyAgeV2319(
  shopifyGraphql: ShopifyRead,
  shopifyProductId: string,
  expected: AloAgeRequirementV2319
): Promise<void> {
  const data = await shopifyGraphql(`
    mutation AloV2319SetVerifiedAge($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { namespace key value }
        userErrors { field message }
      }
    }
  `, { metafields: [{ ownerId: shopifyProductId, namespace: "alo",
    key: "age_requirement", type: "single_line_text_field", value: expected }] });
  const payload = data?.metafieldsSet;
  if (!payload || !Array.isArray(payload.userErrors) || payload.userErrors.length ||
      !Array.isArray(payload.metafields) ||
      !payload.metafields.some((field: any) =>
        field?.namespace === "alo" && field?.key === "age_requirement" &&
        field?.value === expected)) {
    throw new Error("ALO_AGE_SHOPIFY_WRITE_NOT_CONFIRMED");
  }
  await verifyShopifyAgeV2319(shopifyGraphql, shopifyProductId, expected);
}

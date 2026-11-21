/** ALO_NOW_SHOPIFY_CART_GUARD_V1
 * Read-only Shopify Admin validation for an UNPAID, NONBINDING request.
 * Pilot: only ACTIVE products with explicitly reviewed alo.age_requirement=NONE.
 * This does NOT reserve stock, create a checkout, or authorize payments.
 */
import { getShopifyAccessToken } from "../../integrations/shopify/auth.js";
import { env } from "../../config/env.js";

type CartLine = { variantId: string; quantity: number };
type VariantNode = {
  __typename?: string; id?: string; price?: string;
  availableForSale?: boolean; inventoryQuantity?: number | null;
  product?: { status?: string; title?: string;
    metafield?: { value?: string } | null } | null;
};

export type VerifiedAloCart = {
  items: Array<{ variantId: string; quantity: number; unitPriceCHF: number; title: string }>;
  subtotalCHF: number;
  currency: "CHF";
};

export class AloNowCartError extends Error {
  constructor(public readonly code: string) { super(code); }
}

function chfCents(value: unknown): number {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,6})(?:\.\d{1,2})?$/.test(value))
    throw new AloNowCartError("INVALID_SHOPIFY_PRICE");
  const [whole, fraction = ""] = value.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents < 1) throw new AloNowCartError("INVALID_SHOPIFY_PRICE");
  return cents;
}

export async function verifyAloNowShopifyCart(lines: CartLine[]): Promise<VerifiedAloCart> {
  if (!Array.isArray(lines) || lines.length < 1 || lines.length > 15)
    throw new AloNowCartError("INVALID_ITEMS");
  const unique = new Set<string>();
  for (const line of lines) {
    if (!/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(line.variantId) ||
      !Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 30 ||
      unique.has(line.variantId)) throw new AloNowCartError("INVALID_OR_DUPLICATE_VARIANT");
    unique.add(line.variantId);
  }
  const token = await getShopifyAccessToken();
  const shop = env.shopify.shop.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const shopDomain = shop.endsWith(".myshopify.com") ? shop : `${shop}.myshopify.com`;
  const response = await fetch(`https://${shopDomain}/admin/api/${env.shopify.apiVersion}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    signal: AbortSignal.timeout(12000),
    body: JSON.stringify({
      query: `query AloNowValidateVariants($ids: [ID!]!) {
        shop { currencyCode }
        nodes(ids: $ids) {
          __typename
          ... on ProductVariant {
            id price availableForSale inventoryQuantity
            product { status title metafield(namespace: "alo", key: "age_requirement") { value } }
          }
        }
      }`,
      variables: { ids: lines.map(x => x.variantId) }
    }),
  });
  if (!response.ok) throw new AloNowCartError("SHOPIFY_VALIDATION_UNAVAILABLE");
  const payload = await response.json() as {
    errors?: unknown[];
    data?: { shop?: { currencyCode?: string }; nodes?: Array<VariantNode | null> };
  };
  if (payload.errors?.length || payload.data?.shop?.currencyCode !== "CHF" ||
      !Array.isArray(payload.data.nodes) || payload.data.nodes.length !== lines.length)
    throw new AloNowCartError("SHOPIFY_VALIDATION_UNAVAILABLE");
  const byId = new Map<string, VariantNode>();
  for (const node of payload.data.nodes) {
    if (!node || node.__typename !== "ProductVariant" || !node.id || byId.has(node.id))
      throw new AloNowCartError("SHOPIFY_VARIANT_NOT_FOUND");
    byId.set(node.id, node);
  }
  let subtotalCents = 0;
  const verified = lines.map(line => {
    const node = byId.get(line.variantId);
    if (!node || node.product?.status !== "ACTIVE" || node.availableForSale !== true)
      throw new AloNowCartError("VARIANT_NOT_AVAILABLE");
    // The metafield is written only after explicit Product Master age review.
    // AGE_16 / AGE_18 are intentionally blocked until compliant checkout is built.
    if (node.product?.metafield?.value !== "NONE")
      throw new AloNowCartError("AGE_REVIEW_OR_RESTRICTED_PRODUCT");
    if (typeof node.inventoryQuantity === "number" && node.inventoryQuantity >= 0 &&
        node.inventoryQuantity < line.quantity)
      throw new AloNowCartError("INSUFFICIENT_STOCK");
    const unitCents = chfCents(node.price);
    subtotalCents += unitCents * line.quantity;
    if (!Number.isSafeInteger(subtotalCents) || subtotalCents > 100000000)
      throw new AloNowCartError("CART_TOTAL_LIMIT");
    return { variantId: line.variantId, quantity: line.quantity,
      unitPriceCHF: unitCents / 100, title: String(node.product?.title ?? "").slice(0, 180) };
  });
  return { items: verified, subtotalCHF: subtotalCents / 100, currency: "CHF" };
}

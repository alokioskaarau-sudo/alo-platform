import axios from "axios";

import { env } from "../config/env.js";
import {
  getShopifyAccessToken,
} from "../integrations/shopify/auth.js";

export type ShopifyProductMatch = {
  productId: string;
  productTitle: string;
  productStatus: string | null;
  variantId: string | null;
  inventoryItemId: string | null;
  barcode: string | null;
  size: string | null;
};

export type ProductIdentityResolution =
  | {
      status: "EXACT_BARCODE";
      barcode: string;
      match: ShopifyProductMatch;
    }
  | {
      status: "EXACT_TITLE_SIZE";
      barcode: string | null;
      sourceTitle: string;
      sourceSize: string;
      match: ShopifyProductMatch;
    }
  | {
      status: "MULTIPLE_BARCODE_MATCHES";
      barcode: string;
      matches: ShopifyProductMatch[];
    }
  | {
      status: "MULTIPLE_IDENTITY_MATCHES";
      barcode: string | null;
      sourceTitle: string;
      sourceSize: string | null;
      matches: ShopifyProductMatch[];
    }
  | {
      status: "NO_MATCH";
      barcode: string | null;
      sourceTitle: string;
      sourceSize: string | null;
    }
  | {
      status: "INSUFFICIENT_IDENTITY";
      barcode: string | null;
      sourceTitle: string;
      sourceSize: string | null;
    };

export type ResolveProductIdentityInput = {
  barcode?: unknown;
  title?: unknown;
  unitSize?: unknown;
  netWeight?: unknown;
};

export function normalizeProductBarcode(
  value: unknown
): string {
  return String(value ?? "")
    .replace(/\s+/g, "")
    .trim();
}

function normalizeShop(
  value: string
): string {
  return value
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "")
    .replace(/\.myshopify\.com$/, "");
}

export function normalizeProductIdentityText(
  value: unknown
): string {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(
      /(\d+(?:[.,]\d+)?)\s*(kg|g|mg|l|ml|cl)\b/g,
      "$1$2"
    )
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractProductSize(
  ...values: unknown[]
): string | null {
  for (const value of values) {
    const normalized =
      normalizeProductIdentityText(value);

    const matches = normalized.match(
      /\b\d+(?:[.,]\d+)?(?:kg|g|mg|l|ml|cl)\b/g
    );

    if (matches?.length) {
      return matches[
        matches.length - 1
      ].replace(",", ".");
    }
  }

  return null;
}

export function stripProductSize(
  value: unknown
): string {
  return normalizeProductIdentityText(value)
    .replace(
      /\b\d+(?:[.,]\d+)?(?:kg|g|mg|l|ml|cl)\b/g,
      " "
    )
    .replace(/\s+/g, " ")
    .trim();
}

async function shopifyGraphql(
  query: string,
  variables: Record<string, unknown>
) {
  const token =
    await getShopifyAccessToken();

  const shop = normalizeShop(
    env.shopify.shop
  );

  const response = await axios.post(
    `https://${shop}.myshopify.com/admin/api/2026-07/graphql.json`,
    {
      query,
      variables,
    },
    {
      headers: {
        "Content-Type":
          "application/json",
        "X-Shopify-Access-Token":
          token,
      },
      timeout: 30000,
    }
  );

  if (
    response.data?.errors?.length
  ) {
    throw new Error(
      response.data.errors
        .map(
          (error: any) =>
            error.message
        )
        .join(" · ")
    );
  }

  return response.data?.data;
}

async function findByBarcode(
  barcodeInput: unknown
): Promise<ShopifyProductMatch[]> {
  const barcode =
    normalizeProductBarcode(
      barcodeInput
    );

  if (!barcode) {
    return [];
  }

  const result =
    await shopifyGraphql(
      `
        query AloResolveBarcode(
          $query: String!
        ) {
          productVariants(
            first: 10
            query: $query
          ) {
            nodes {
              id
              barcode
              inventoryItem {
                id
              }
              product {
                id
                title
                status
              }
            }
          }
        }
      `,
      {
        query: `barcode:${barcode}`,
      }
    );

  const nodes =
    Array.isArray(
      result?.productVariants?.nodes
    )
      ? result.productVariants.nodes
      : [];

  return nodes
    .filter(
      (node: any) =>
        normalizeProductBarcode(
          node?.barcode
        ) === barcode
    )
    .map(
      (node: any) => ({
        productId:
          String(node.product.id),
        productTitle:
          String(
            node.product.title || ""
          ),
        productStatus:
          node.product.status
            ? String(
                node.product.status
              )
            : null,
        variantId:
          node.id
            ? String(node.id)
            : null,
        inventoryItemId:
          node.inventoryItem?.id
            ? String(
                node.inventoryItem.id
              )
            : null,
        barcode:
          normalizeProductBarcode(
            node.barcode
          ) || null,
        size:
          extractProductSize(
            node.product.title
          ),
      })
    );
}

async function findByTitleAndSize(
  titleInput: unknown,
  unitSize?: unknown,
  netWeight?: unknown
): Promise<ShopifyProductMatch[]> {
  const sourceTitle =
    String(titleInput ?? "").trim();

  if (!sourceTitle) {
    return [];
  }

  const sourceSize =
    extractProductSize(
      unitSize,
      netWeight,
      sourceTitle
    );

  const sourceBase =
    stripProductSize(
      sourceTitle
    );

  if (
    !sourceBase ||
    !sourceSize
  ) {
    return [];
  }

  const searchWords =
    sourceBase
      .split(" ")
      .filter(
        (word) =>
          word.length >= 2
      )
      .slice(0, 6);

  if (!searchWords.length) {
    return [];
  }

  const searchQuery =
    searchWords
      .map(
        (word) =>
          `title:${word}*`
      )
      .join(" AND ");

  const result =
    await shopifyGraphql(
      `
        query AloResolveIdentity(
          $query: String!
        ) {
          products(
            first: 20
            query: $query
          ) {
            nodes {
              id
              title
              status
              variants(first: 10) {
                nodes {
                  id
                  barcode
                  inventoryItem {
                    id
                  }
                }
              }
            }
          }
        }
      `,
      {
        query: searchQuery,
      }
    );

  const products =
    Array.isArray(
      result?.products?.nodes
    )
      ? result.products.nodes
      : [];

  const matches:
    ShopifyProductMatch[] = [];

  for (
    const product of products
  ) {
    const shopifyTitle =
      String(
        product?.title ?? ""
      );

    const shopifyBase =
      stripProductSize(
        shopifyTitle
      );

    const shopifySize =
      extractProductSize(
        shopifyTitle
      );

    if (
      !shopifyBase ||
      shopifyBase !== sourceBase
    ) {
      continue;
    }

    if (
      !shopifySize ||
      shopifySize !== sourceSize
    ) {
      continue;
    }

    const variants =
      Array.isArray(
        product?.variants?.nodes
      )
        ? product.variants.nodes
        : [];

    if (
      variants.length !== 1
    ) {
      continue;
    }

    const variant =
      variants[0];

    matches.push({
      productId:
        String(product.id),
      productTitle:
        shopifyTitle,
      productStatus:
        product.status
          ? String(
              product.status
            )
          : null,
      variantId:
        variant?.id
          ? String(
              variant.id
            )
          : null,
      inventoryItemId:
        variant?.inventoryItem?.id
          ? String(
              variant
                .inventoryItem.id
            )
          : null,
      barcode:
        normalizeProductBarcode(
          variant?.barcode
        ) || null,
      size:
        shopifySize,
    });
  }

  return matches;
}

export async function resolveProductIdentity(
  input: ResolveProductIdentityInput
): Promise<ProductIdentityResolution> {
  const barcode =
    normalizeProductBarcode(
      input.barcode
    );

  const sourceTitle =
    String(
      input.title ?? ""
    ).trim();

  const sourceSize =
    extractProductSize(
      input.unitSize,
      input.netWeight,
      sourceTitle
    );

  if (barcode) {
    const barcodeMatches =
      await findByBarcode(
        barcode
      );

    if (
      barcodeMatches.length > 1
    ) {
      return {
        status:
          "MULTIPLE_BARCODE_MATCHES",
        barcode,
        matches:
          barcodeMatches,
      };
    }

    if (
      barcodeMatches.length === 1
    ) {
      return {
        status:
          "EXACT_BARCODE",
        barcode,
        match:
          barcodeMatches[0],
      };
    }
  }

  if (
    !sourceTitle ||
    !sourceSize
  ) {
    return {
      status:
        "INSUFFICIENT_IDENTITY",
      barcode:
        barcode || null,
      sourceTitle,
      sourceSize,
    };
  }

  const identityMatches =
    await findByTitleAndSize(
      sourceTitle,
      input.unitSize,
      input.netWeight
    );

  if (
    identityMatches.length > 1
  ) {
    return {
      status:
        "MULTIPLE_IDENTITY_MATCHES",
      barcode:
        barcode || null,
      sourceTitle,
      sourceSize,
      matches:
        identityMatches,
    };
  }

  if (
    identityMatches.length === 1
  ) {
    return {
      status:
        "EXACT_TITLE_SIZE",
      barcode:
        barcode || null,
      sourceTitle,
      sourceSize,
      match:
        identityMatches[0],
    };
  }

  return {
    status: "NO_MATCH",
    barcode:
      barcode || null,
    sourceTitle,
    sourceSize,
  };
}

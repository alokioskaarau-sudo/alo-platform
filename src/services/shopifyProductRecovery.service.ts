
import axios from "axios";
import { env } from "../config/env.js";
import { getShopifyAccessToken } from "../integrations/shopify/auth.js";

export type ShopifyRecoveryProduct = {
  id: string;
  title: string;
  status: string;
  vendor: string | null;
  product_type: string | null;
  handle: string | null;
  body_html: string | null;
  tags: string[];
  image: { src: string } | null;
  variants: Array<{
    admin_graphql_api_id: string;
    barcode: string | null;
    price: string;
    inventory_item_id: string | null;
  }>;
};

function normalizeProductId(value: string): string {
  const id = String(value ?? "").trim();

  if (/^gid:\/\/shopify\/Product\/\d+$/.test(id)) {
    return id;
  }

  if (/^\d+$/.test(id)) {
    return "gid://shopify/Product/" + id;
  }

  throw new Error("ALO_PRODUCT_RECOVERY_INVALID_ID");
}

function normalizeShop(value: string): string {
  return value
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "")
    .replace(/\.myshopify\.com$/, "");
}

export async function fetchCurrentShopifyProduct(
  productId: string
): Promise<
  | { status: "FOUND"; product: ShopifyRecoveryProduct }
  | { status: "NOT_FOUND"; product: null }
> {
  const id = normalizeProductId(productId);
  const token = await getShopifyAccessToken();
  const shop = normalizeShop(env.shopify.shop);

  const query = `
    query AloProductRecoveryRead($id: ID!) {
      product(id: $id) {
        id
        title
        status
        vendor
        productType
        handle
        descriptionHtml
        tags
        featuredMedia {
          preview {
            image {
              url
            }
          }
        }
        variants(first: 100) {
          nodes {
            id
            barcode
            price
            inventoryItem {
              id
            }
          }
          pageInfo {
            hasNextPage
          }
        }
      }
    }
  `;

  const response = await axios.post(
    `https://${shop}.myshopify.com/admin/api/2026-07/graphql.json`,
    { query, variables: { id } },
    {
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      timeout: 30000,
    }
  );

  const body = response.data;

  if (
    !body ||
    !Array.isArray(body.errors) &&
      body.errors !== undefined &&
      body.errors !== null
  ) {
    throw new Error("ALO_PRODUCT_RECOVERY_INVALID_RESPONSE");
  }

  if (Array.isArray(body.errors) && body.errors.length > 0) {
    throw new Error("ALO_PRODUCT_RECOVERY_GRAPHQL_ERROR");
  }

  if (!body.data || !Object.prototype.hasOwnProperty.call(body.data, "product")) {
    throw new Error("ALO_PRODUCT_RECOVERY_MISSING_DATA");
  }

  const product = body.data.product;

  if (product === null) {
    return { status: "NOT_FOUND", product: null };
  }

  if (
    !product ||
    product.id !== id ||
    typeof product.title !== "string" ||
    !product.title.trim() ||
    typeof product.status !== "string" ||
    !Array.isArray(product.tags) ||
    !Array.isArray(product.variants?.nodes) ||
    product.variants?.pageInfo?.hasNextPage !== false
  ) {
    throw new Error("ALO_PRODUCT_RECOVERY_INCOMPLETE_PRODUCT");
  }

  const variants = product.variants.nodes.map((variant: any) => {
    if (
      !variant ||
      typeof variant.id !== "string" ||
      typeof variant.price !== "string" ||
      !Number.isFinite(Number(variant.price)) ||
      Number(variant.price) < 0
    ) {
      throw new Error("ALO_PRODUCT_RECOVERY_INVALID_VARIANT");
    }

    return {
      admin_graphql_api_id: variant.id,
      barcode: variant.barcode ?? null,
      price: variant.price,
      inventory_item_id: variant.inventoryItem?.id ?? null,
    };
  });

  const imageUrl =
    product.featuredMedia?.preview?.image?.url ?? null;

  return {
    status: "FOUND",
    product: {
      id: product.id,
      title: product.title,
      status: product.status,
      vendor: product.vendor ?? null,
      product_type: product.productType ?? null,
      handle: product.handle ?? null,
      body_html: product.descriptionHtml ?? null,
      tags: product.tags,
      image: imageUrl ? { src: imageUrl } : null,
      variants,
    },
  };
}

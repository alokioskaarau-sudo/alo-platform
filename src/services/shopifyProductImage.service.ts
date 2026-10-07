import axios from "axios";
import { env } from "../config/env.js";
import {
  getShopifyAccessToken,
} from "../integrations/shopify/auth.js";

const SHOPIFY_API_VERSION = "2026-07";

function normalizeShop(value: string): string {
  return value
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "")
    .replace(/\.myshopify\.com$/, "");
}

function normalizeShopifyProductId(
  value: string
) {
  const id = String(value ?? "").trim();

  if (!id) {
    throw new Error(
      "Shopify Product ID fehlt."
    );
  }

  if (
    id.startsWith(
      "gid://shopify/Product/"
    )
  ) {
    return id;
  }

  return `gid://shopify/Product/${id}`;
}

async function shopifyGraphql(
  query: string,
  variables: Record<string, unknown>
) {
  const token =
    await getShopifyAccessToken();

  const shop =
    normalizeShop(env.shopify.shop);

  const response = await axios.post(
    `https://${shop}.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      query,
      variables,
    },
    {
      headers: {
        "X-Shopify-Access-Token":
          token,
        "Content-Type":
          "application/json",
      },
      timeout: 30000,
    }
  );

  const errors =
    response.data?.errors;

  if (
    Array.isArray(errors) &&
    errors.length > 0
  ) {
    throw new Error(
      errors
        .map(
          (error: any) =>
            error?.message ??
            "Shopify GraphQL Fehler"
        )
        .join(" · ")
    );
  }

  return response.data?.data;
}

export async function getShopifyMainProductImage(
  input: {
    shopifyProductId: string;
  }
) {
  const productId =
    normalizeShopifyProductId(
      input.shopifyProductId
    );

  const data = await shopifyGraphql(
    `
      query AloGetMainProductImage(
        $id: ID!
      ) {
        product(id: $id) {
          id
          media(first: 20) {
            nodes {
              ... on MediaImage {
                id
                image {
                  url
                  altText
                }
              }
            }
          }
        }
      }
    `,
    {
      id: productId,
    }
  );

  if (!data?.product) {
    throw new Error(
      "Shopify Produkt wurde nicht gefunden."
    );
  }

  const nodes =
    Array.isArray(
      data.product?.media?.nodes
    )
      ? data.product.media.nodes
      : [];

  const media =
    nodes.find(
      (entry: any) =>
        typeof entry?.image?.url ===
          "string" &&
        entry.image.url.trim()
    ) ?? null;

  if (!media?.image?.url) {
    return {
      ok: true as const,
      productId,
      mediaId: null,
      imageUrl: null,
      altText: null,
    };
  }

  return {
    ok: true as const,
    productId,
    mediaId:
      typeof media.id === "string"
        ? media.id
        : null,
    imageUrl:
      media.image.url.trim(),
    altText:
      typeof media.image.altText ===
      "string"
        ? media.image.altText
        : null,
  };
}

export async function downloadShopifyProductImage(
  imageUrl: string
) {
  const url =
    String(imageUrl ?? "").trim();

  if (!url) {
    throw new Error(
      "Shopify Bild-URL fehlt."
    );
  }

  const response =
    await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 30000,
    });

  const imageBuffer =
    Buffer.from(response.data);

  if (imageBuffer.length === 0) {
    throw new Error(
      "Shopify Bild ist leer."
    );
  }

  const header =
    response.headers?.[
      "content-type"
    ];

  const mimeType =
    typeof header === "string" &&
    header
      .toLowerCase()
      .startsWith("image/")
      ? header.split(";")[0].trim()
      : "image/jpeg";

  return {
    buffer: imageBuffer,
    mimeType,
    bytes: imageBuffer.length,
  };
}

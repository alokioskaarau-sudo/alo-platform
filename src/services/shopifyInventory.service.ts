import axios from "axios";
import { createHash } from "node:crypto";
import { env } from "../config/env.js";
import {
  getShopifyAccessToken,
} from "../integrations/shopify/auth.js";

export const ALO_ONLINE_SHOP_LOCATION_ID =
  "gid://shopify/Location/80869130324";

function normalizeShop(value: string): string {
  return value
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "")
    .replace(/\.myshopify\.com$/, "");
}

function normalizeInventoryItemId(
  value: string
): string {
  const clean = String(value ?? "").trim();

  if (!clean) {
    throw new Error(
      "Shopify Inventory Item ID fehlt."
    );
  }

  if (
    clean.startsWith(
      "gid://shopify/InventoryItem/"
    )
  ) {
    return clean;
  }

  return `gid://shopify/InventoryItem/${clean}`;
}

function buildIdempotencyKey(
  inventoryItemId: string,
  quantity: number,
  reference: string
): string {
  return createHash("sha256")
    .update(
      [
        "ALO_RECEIVING",
        inventoryItemId,
        String(quantity),
        reference,
      ].join("|")
    )
    .digest("hex");
}

async function shopifyGraphql(
  query: string,
  variables: Record<string, unknown>
) {
  const token =
    await getShopifyAccessToken();

  const shop =
    normalizeShop(env.shopify.shop);

  const response =
    await axios.post(
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

export async function setShopifyOnlineInventory(
  input: {
    inventoryItemId: string;
    quantity: number;
    reference: string;
  }
) {
  const inventoryItemId =
    normalizeInventoryItemId(
      input.inventoryItemId
    );

  const quantity =
    Number(input.quantity);

  if (
    !Number.isInteger(quantity) ||
    quantity < 0
  ) {
    throw new Error(
      "Ungültiger Shopify-Bestand."
    );
  }

  const idempotencyKey =
    buildIdempotencyKey(
      inventoryItemId,
      quantity,
      input.reference
    );

  const data =
    await shopifyGraphql(
      `
        mutation AloSetOnlineInventory(
          $input: InventorySetQuantitiesInput!,
          $idempotencyKey: String!
        ) {
          inventorySetQuantities(
            input: $input
          )
          @idempotent(
            key: $idempotencyKey
          ) {
            inventoryAdjustmentGroup {
              createdAt
              reason
              referenceDocumentUri
              changes {
                name
                delta
                quantityAfterChange
              }
            }
            userErrors {
              code
              field
              message
            }
          }
        }
      `,
      {
        idempotencyKey,
        input: {
          name: "available",
          reason: "correction",
          referenceDocumentUri:
            `alo://receiving/${input.reference}`,
          ignoreCompareQuantity: true,
          quantities: [
            {
              inventoryItemId,
              locationId:
                ALO_ONLINE_SHOP_LOCATION_ID,
              quantity,
              compareQuantity: null,
            },
          ],
        },
      }
    );

  const payload =
    data?.inventorySetQuantities;

  const userErrors =
    payload?.userErrors ?? [];

  if (userErrors.length) {
    throw new Error(
      userErrors
        .map(
          (error: any) =>
            error.message
        )
        .join(" · ")
    );
  }

  return {
    ok: true as const,
    locationId:
      ALO_ONLINE_SHOP_LOCATION_ID,
    inventoryItemId,
    quantity,
    adjustment:
      payload?.inventoryAdjustmentGroup ??
      null,
  };
}

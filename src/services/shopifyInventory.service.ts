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



async function ensureInventoryTracked(
  inventoryItemId: string
): Promise<{
  changed: boolean;
}> {
  const data =
    await shopifyGraphql(
      `
        query AloInventoryTrackingState(
          $id: ID!
        ) {
          inventoryItem(
            id: $id
          ) {
            id
            tracked
          }
        }
      `,
      {
        id: inventoryItemId,
      }
    );

  const item =
    data?.inventoryItem;

  if (!item?.id) {
    throw new Error(
      "Shopify Inventory Item wurde nicht gefunden."
    );
  }

  if (item.tracked === true) {
    return {
      changed: false,
    };
  }

  const updated =
    await shopifyGraphql(
      `
        mutation AloEnableInventoryTracking(
          $id: ID!,
          $input: InventoryItemInput!
        ) {
          inventoryItemUpdate(
            id: $id,
            input: $input
          ) {
            inventoryItem {
              id
              tracked
            }

            userErrors {
              field
              message
            }
          }
        }
      `,
      {
        id: inventoryItemId,
        input: {
          tracked: true,
        },
      }
    );

  const payload =
    updated?.inventoryItemUpdate;

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

  if (
    !payload?.inventoryItem?.id ||
    payload.inventoryItem.tracked !== true
  ) {
    throw new Error(
      "Shopify Inventarverfolgung konnte nicht aktiviert werden."
    );
  }

  return {
    changed: true,
  };
}


async function deactivateOtherInventoryLocations(
  inventoryItemId: string
): Promise<Array<{
  inventoryLevelId: string;
  locationId: string;
  locationName: string;
}>> {
  const data =
    await shopifyGraphql(
      `
        query AloInventoryLocations(
          $id: ID!
        ) {
          inventoryItem(
            id: $id
          ) {
            id

            inventoryLevels(
              first: 50
            ) {
              nodes {
                id

                location {
                  id
                  name
                }
              }
            }
          }
        }
      `,
      {
        id: inventoryItemId,
      }
    );

  const item =
    data?.inventoryItem;

  if (!item?.id) {
    throw new Error(
      "Shopify Inventory Item wurde nicht gefunden."
    );
  }

  const levels =
    Array.isArray(
      item?.inventoryLevels?.nodes
    )
      ? item.inventoryLevels.nodes
      : [];

  const removed: Array<{
    inventoryLevelId: string;
    locationId: string;
    locationName: string;
  }> = [];

  for (const level of levels) {
    const levelId =
      String(
        level?.id ?? ""
      ).trim();

    const locationId =
      String(
        level?.location?.id ?? ""
      ).trim();

    if (
      !levelId ||
      !locationId ||
      locationId ===
        ALO_ONLINE_SHOP_LOCATION_ID
    ) {
      continue;
    }

    const result =
      await shopifyGraphql(
        `
          mutation AloDeactivateInventoryLevel(
            $inventoryLevelId: ID!
          ) {
            inventoryDeactivate(
              inventoryLevelId:
                $inventoryLevelId
            ) {
              userErrors {
                field
                message
              }
            }
          }
        `,
        {
          inventoryLevelId:
            levelId,
        }
      );

    const payload =
      result?.inventoryDeactivate;

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

    removed.push({
      inventoryLevelId:
        levelId,
      locationId,
      locationName:
        String(
          level?.location?.name ??
          ""
        ),
    });
  }

  return removed;
}


async function ensureOnlineInventoryActivated(
  inventoryItemId: string,
  reference: string
): Promise<{
  activated: boolean;
}> {
  const lookup =
    await shopifyGraphql(
      `
        query AloOnlineInventoryLevel(
          $inventoryItemId: ID!,
          $locationId: ID!
        ) {
          inventoryItem(
            id: $inventoryItemId
          ) {
            id
            inventoryLevel(
              locationId: $locationId
            ) {
              id
            }
          }
        }
      `,
      {
        inventoryItemId,
        locationId:
          ALO_ONLINE_SHOP_LOCATION_ID,
      }
    );

  if (!lookup?.inventoryItem) {
    throw new Error(
      "Shopify Inventory Item wurde nicht gefunden."
    );
  }

  if (
    lookup.inventoryItem.inventoryLevel
  ) {
    return {
      activated: false,
    };
  }

  const idempotencyKey =
    createHash("sha256")
      .update(
        [
          "ALO_INVENTORY_ACTIVATE",
          inventoryItemId,
          ALO_ONLINE_SHOP_LOCATION_ID,
          reference,
        ].join("|")
      )
      .digest("hex");

  const activation =
    await shopifyGraphql(
      `
        mutation AloActivateOnlineInventory(
          $inventoryItemId: ID!,
          $locationId: ID!,
          $available: Int!,
          $idempotencyKey: String!
        ) {
          inventoryActivate(
            inventoryItemId:
              $inventoryItemId
            locationId:
              $locationId
            available:
              $available
          )
          @idempotent(
            key: $idempotencyKey
          ) {
            inventoryLevel {
              id
              location {
                id
              }
              item {
                id
              }
              quantities(
                names: ["available"]
              ) {
                name
                quantity
              }
            }
            userErrors {
              field
              message
            }
          }
        }
      `,
      {
        inventoryItemId,
        locationId:
          ALO_ONLINE_SHOP_LOCATION_ID,
        available: 0,
        idempotencyKey,
      }
    );

  const payload =
    activation?.inventoryActivate;

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

  if (!payload?.inventoryLevel) {
    throw new Error(
      "Shopify Online-Bestand konnte nicht aktiviert werden."
    );
  }

  return {
    activated: true,
  };
}


export async function getShopifyOnlineInventory(
  input: {
    inventoryItemId: string;
  }
) {
  const inventoryItemId =
    normalizeInventoryItemId(
      input.inventoryItemId
    );

  const data =
    await shopifyGraphql(
      `
        query AloGetOnlineInventory(
          $inventoryItemId: ID!,
          $locationId: ID!
        ) {
          inventoryItem(
            id: $inventoryItemId
          ) {
            id
            tracked
            inventoryLevel(
              locationId: $locationId
            ) {
              id
              quantities(
                names: ["available"]
              ) {
                name
                quantity
              }
            }
          }

          location(
            id: $locationId
          ) {
            id
            name
          }
        }
      `,
      {
        inventoryItemId,
        locationId:
          ALO_ONLINE_SHOP_LOCATION_ID,
      }
    );

  const item =
    data?.inventoryItem;

  if (!item) {
    throw new Error(
      "Shopify Inventory Item wurde nicht gefunden."
    );
  }

  const level =
    item.inventoryLevel ?? null;

  const available =
    Array.isArray(
      level?.quantities
    )
      ? level.quantities.find(
          (entry: any) =>
            entry?.name ===
            "available"
        )?.quantity
      : null;

  return {
    ok: true as const,

    locationId:
      data?.location?.id ??
      ALO_ONLINE_SHOP_LOCATION_ID,

    locationName:
      data?.location?.name ??
      "ALO Kiosk Online Shop",

    inventoryItemId:
      item.id,

    tracked:
      Boolean(item.tracked),

    active:
      Boolean(level),

    quantity:
      typeof available === "number"
        ? available
        : null,
  };
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

  const tracking =
    await ensureInventoryTracked(
      inventoryItemId
    );

  const activation =
    await ensureOnlineInventoryActivated(
      inventoryItemId,
      input.reference
    );

  const deactivatedLocations =
    await deactivateOtherInventoryLocations(
      inventoryItemId
    );

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
          quantities: [
            {
              inventoryItemId,
              locationId:
                ALO_ONLINE_SHOP_LOCATION_ID,
              quantity,
              changeFromQuantity: null,
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
    activated:
      activation.activated,
    adjustment:
      payload?.inventoryAdjustmentGroup ??
      null,
  };
}

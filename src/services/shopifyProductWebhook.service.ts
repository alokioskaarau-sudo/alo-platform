import { db } from "../database/db.js";
import {
  normalizeProductBarcode,
} from "./productIdentity.service.js";

type ShopifyWebhookVariant = {
  admin_graphql_api_id?: string | null;
  id?: string | number | null;
  barcode?: string | null;
  price?: string | number | null;
  inventory_item_id?: string | number | null;
};

type ShopifyProductWebhookPayload = {
  admin_graphql_api_id?: string | null;
  id?: string | number | null;
  title?: string | null;
  status?: string | null;
  vendor?: string | null;
  product_type?: string | null;
  handle?: string | null;
  body_html?: string | null;
  tags?: string | string[] | null;
  image?: {
    src?: string | null;
  } | null;
  images?: Array<{
    src?: string | null;
  }>;
  variants?: ShopifyWebhookVariant[];
};

function productGid(
  payload: ShopifyProductWebhookPayload
): string | null {
  if (payload.admin_graphql_api_id) {
    return String(
      payload.admin_graphql_api_id
    );
  }

  if (payload.id !== undefined && payload.id !== null) {
    return `gid://shopify/Product/${String(payload.id)}`;
  }

  return null;
}

function variantGid(
  variant: ShopifyWebhookVariant
): string | null {
  if (variant.admin_graphql_api_id) {
    return String(
      variant.admin_graphql_api_id
    );
  }

  if (variant.id !== undefined && variant.id !== null) {
    return `gid://shopify/ProductVariant/${String(variant.id)}`;
  }

  return null;
}

function inventoryItemGid(
  variant: ShopifyWebhookVariant
): string | null {
  if (
    variant.inventory_item_id === undefined ||
    variant.inventory_item_id === null
  ) {
    return null;
  }

  return `gid://shopify/InventoryItem/${String(
    variant.inventory_item_id
  )}`;
}

function normalizeTags(
  value: ShopifyProductWebhookPayload["tags"]
): string[] {
  if (Array.isArray(value)) {
    return value
      .map((tag) => String(tag).trim())
      .filter(Boolean);
  }

  if (typeof value === "string") {
    return value
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);
  }

  return [];
}

function firstImageUrl(
  payload: ShopifyProductWebhookPayload
): string | null {
  if (payload.image?.src) {
    return String(payload.image.src);
  }

  const first = payload.images?.find(
    (image) => image?.src
  );

  return first?.src
    ? String(first.src)
    : null;
}

export async function processShopifyProductWebhook(
  payload: ShopifyProductWebhookPayload
) {
  const shopifyProductId =
    productGid(payload);

  if (!shopifyProductId) {
    throw new Error(
      "Shopify Product ID fehlt."
    );
  }

  const title =
    String(payload.title ?? "")
      .trim()
      .toUpperCase();

  if (!title) {
    throw new Error(
      "Shopify Produkttitel fehlt."
    );
  }

  const variants =
    Array.isArray(payload.variants)
      ? payload.variants
      : [];

  if (variants.length !== 1) {
    const existing =
      await db.query(
        `
          SELECT id
          FROM products
          WHERE shopify_product_id = $1
          LIMIT 1
        `,
        [shopifyProductId]
      );

    if (existing.rows[0]) {
      await db.query(
        `
          UPDATE products
          SET
            review_status = 'NEEDS_REVIEW',
            shopify_status = $2,
            product_data =
              COALESCE(
                product_data,
                '{}'::jsonb
              )
              || jsonb_build_object(
                'shopifySyncWarning',
                'MULTI_VARIANT_PRODUCT'
              ),
            updated_at = NOW()
          WHERE id = $1
        `,
        [
          existing.rows[0].id,
          payload.status
            ? String(payload.status).toUpperCase()
            : "REVIEW",
        ]
      );
    }

    return {
      ok: true,
      action: "REVIEW" as const,
      reason: "MULTI_VARIANT_PRODUCT",
      shopifyProductId,
    };
  }

  const variant = variants[0];

  const shopifyVariantId =
    variantGid(variant);

  const shopifyInventoryItemId =
    inventoryItemGid(variant);

  const barcode =
    normalizeProductBarcode(
      variant.barcode
    ) || null;

  const price =
    variant.price !== undefined &&
    variant.price !== null
      ? String(variant.price)
      : null;

  const status =
    payload.status
      ? String(payload.status).toUpperCase()
      : "LINKED";

  const vendor =
    payload.vendor
      ? String(payload.vendor)
      : null;

  const productType =
    payload.product_type
      ? String(payload.product_type)
      : null;

  const descriptionHtml =
    payload.body_html !== undefined &&
    payload.body_html !== null
      ? String(payload.body_html)
      : null;

  const tags =
    normalizeTags(payload.tags);

  const imageUrl =
    firstImageUrl(payload);

  const shopifyData = {
    productId: shopifyProductId,
    variantId: shopifyVariantId,
    inventoryItemId:
      shopifyInventoryItemId,
    handle: payload.handle
      ? String(payload.handle)
      : null,
    status,
    imageUrl,
    originalTitle:
      String(payload.title ?? title),
  };

  const publicPatch: Record<
    string,
    unknown
  > = {
    title,
    barcode,
    vendor,
    brand: vendor,
    productType,
    descriptionHtml,
    tags,
    sellingPrice: price,
    commerce: {
      sellingPrice: price,
    },
    shopify: shopifyData,
  };

  const byShopifyId =
    await db.query(
      `
        SELECT *
        FROM products
        WHERE shopify_product_id = $1
        LIMIT 2
      `,
      [shopifyProductId]
    );

  if (byShopifyId.rows.length > 1) {
    throw new Error(
      "Mehrere Product-Master-Produkte besitzen dieselbe Shopify Product ID."
    );
  }

  if (byShopifyId.rows.length === 1) {
    const existing =
      byShopifyId.rows[0];

    if (
      barcode &&
      existing.barcode &&
      String(existing.barcode) !== barcode
    ) {
      const barcodeOwner =
        await db.query(
          `
            SELECT id
            FROM products
            WHERE barcode = $1
              AND id <> $2
            LIMIT 1
          `,
          [
            barcode,
            existing.id,
          ]
        );

      if (barcodeOwner.rows[0]) {
        await db.query(
          `
            UPDATE products
            SET
              review_status =
                'NEEDS_REVIEW',
              updated_at = NOW()
            WHERE id = $1
          `,
          [existing.id]
        );

        return {
          ok: true,
          action: "REVIEW" as const,
          reason:
            "BARCODE_OWNED_BY_OTHER_PRODUCT",
          productMasterId:
            String(existing.id),
          shopifyProductId,
        };
      }
    }

    await db.query(
      `
        UPDATE products
        SET
          barcode = $2,
          title = $3,
          vendor = $4,
          product_type = $5,
          description_html = $6,
          tags = $7::jsonb,
          shopify_status = $8,
          shopify_variant_id = $9,
          shopify_inventory_item_id = $10,
          product_data =
            COALESCE(
              product_data,
              '{}'::jsonb
            )
            || $11::jsonb,
          updated_at = NOW()
        WHERE id = $1
      `,
      [
        existing.id,
        barcode,
        title,
        vendor,
        productType,
        descriptionHtml,
        JSON.stringify(tags),
        status,
        shopifyVariantId,
        shopifyInventoryItemId,
        JSON.stringify(publicPatch),
      ]
    );

    return {
      ok: true,
      action: "UPDATED" as const,
      productMasterId:
        String(existing.id),
      shopifyProductId,
    };
  }

  if (barcode) {
    const barcodeMatches =
      await db.query(
        `
          SELECT *
          FROM products
          WHERE barcode = $1
          LIMIT 2
        `,
        [barcode]
      );

    if (barcodeMatches.rows.length > 1) {
      return {
        ok: true,
        action: "REVIEW" as const,
        reason:
          "MULTIPLE_BARCODE_MATCHES",
        shopifyProductId,
      };
    }

    if (barcodeMatches.rows.length === 1) {
      const existing =
        barcodeMatches.rows[0];

      if (
        existing.shopify_product_id &&
        existing.shopify_product_id !==
          shopifyProductId
      ) {
        return {
          ok: true,
          action: "REVIEW" as const,
          reason:
            "PRODUCT_MASTER_ALREADY_LINKED",
          productMasterId:
            String(existing.id),
          shopifyProductId,
        };
      }

      await db.query(
        `
          UPDATE products
          SET
            title = $2,
            vendor = $3,
            product_type = $4,
            description_html = $5,
            tags = $6::jsonb,
            shopify_status = $7,
            shopify_product_id = $8,
            shopify_variant_id = $9,
            shopify_inventory_item_id = $10,
            product_data =
              COALESCE(
                product_data,
                '{}'::jsonb
              )
              || $11::jsonb,
            updated_at = NOW()
          WHERE id = $1
        `,
        [
          existing.id,
          title,
          vendor,
          productType,
          descriptionHtml,
          JSON.stringify(tags),
          status,
          shopifyProductId,
          shopifyVariantId,
          shopifyInventoryItemId,
          JSON.stringify(publicPatch),
        ]
      );

      return {
        ok: true,
        action: "LINKED" as const,
        matchedBy: "BARCODE" as const,
        productMasterId:
          String(existing.id),
        shopifyProductId,
      };
    }
  }

  const inserted =
    await db.query(
      `
        INSERT INTO products (
          barcode,
          title,
          vendor,
          product_type,
          description_html,
          tags,
          review_status,
          shopify_status,
          shopify_product_id,
          shopify_variant_id,
          shopify_inventory_item_id,
          source_type,
          source_data,
          product_data,
          updated_at
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6::jsonb,
          $7,
          $8,
          $9,
          $10,
          $11,
          'shopify_webhook',
          $12::jsonb,
          $13::jsonb,
          NOW()
        )
        RETURNING id
      `,
      [
        barcode,
        title,
        vendor,
        productType,
        descriptionHtml,
        JSON.stringify(tags),
        barcode
          ? "REVIEWED"
          : "NEEDS_REVIEW",
        status,
        shopifyProductId,
        shopifyVariantId,
        shopifyInventoryItemId,
        JSON.stringify({
          source:
            "shopify_product_webhook",
        }),
        JSON.stringify(publicPatch),
      ]
    );

  return {
    ok: true,
    action: "CREATED" as const,
    productMasterId:
      String(inserted.rows[0].id),
    shopifyProductId,
  };
}

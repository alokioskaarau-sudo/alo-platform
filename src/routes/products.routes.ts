import { Router } from "express";
import { db } from "../database/db.js";
import { getShopifyOnlineInventory } from "../services/shopifyInventory.service.js";
import {
  getShopifyMainProductImage,
  downloadShopifyProductImage,
} from "../services/shopifyProductImage.service.js";

import {
  requireStaffAuth,
} from "../middleware/staffAuth.js";

import {
  getProductByBarcode,
  getProductById,
  saveProduct,
} from "../database/products.js";

export const productsRouter = Router();

productsRouter.get(
  "/api/products/barcode/:barcode",
  async (req, res) => {
    try {
      const product =
        await getProductByBarcode(req.params.barcode);

      if (!product) {
        return res.json({
          ok: true,
          known: false,
          barcode: req.params.barcode,
          product: null,
        });
      }

      return res.json({
        ok: true,
        known: true,
        product,
      });
    } catch (error: any) {
      console.error("Product barcode lookup error:", error);

      return res.status(500).json({
        ok: false,
        error:
          error?.message ??
          "Produkt konnte nicht geladen werden.",
      });
    }
  }
);


/**
 * ALO Inventory Hub
 *
 * Paginated Product Master list with primary image availability and
 * aggregated ALO stock snapshots for Aarau, Olten and Online.
 *
 * The list deliberately reads the Online snapshot in bulk. The single
 * product workspace remains responsible for live Shopify verification.
 */

/**
 * SHOPIFY -> ALO CORE
 * Synchronisiert den aktuellen Online-Bestand eines begrenzten
 * Product-Master-Batches über die exakte Shopify Inventory Item ID.
 */
productsRouter.post(
  "/api/products/sync-shopify-online",
  requireStaffAuth,
  async (req, res) => {
    try {
      const rawLimit = Number(req.body?.limit ?? 40);

      const limit =
        Number.isSafeInteger(rawLimit) && rawLimit > 0
          ? Math.min(rawLimit, 100)
          : 40;

      const productIds = Array.isArray(req.body?.productIds)
        ? Array.from(
            new Set(
              req.body.productIds
                .map((value: unknown) => Number(value))
                .filter(
                  (value: number) =>
                    Number.isSafeInteger(value) &&
                    value > 0
                )
            )
          ).slice(0, limit)
        : [];

      const values: unknown[] = [];

      let where = `
        (
          (
            p.shopify_inventory_item_id IS NOT NULL
            AND BTRIM(p.shopify_inventory_item_id) <> ''
          )
          OR
          (
            p.shopify_product_id IS NOT NULL
            AND BTRIM(p.shopify_product_id) <> ''
          )
        )
      `;

      if (productIds.length > 0) {
        values.push(productIds);

        where += `
          AND p.id = ANY($1::bigint[])
        `;
      }

      values.push(limit);
      const limitIndex = values.length;

      const result = await db.query(
        `
          SELECT
            p.id,
            p.shopify_product_id,
            p.shopify_inventory_item_id
          FROM products p
          WHERE ${where}
          ORDER BY
            p.updated_at DESC NULLS LAST,
            p.id DESC
          LIMIT $${limitIndex}
        `,
        values
      );

      const rows = result.rows;

      const synced: Array<{
        productId: number;
        quantity: number | null;
        tracked: boolean;
        active: boolean;
      }> = [];

      const errors: Array<{
        productId: number;
        error: string;
      }> = [];

      /*
       * Begrenzte Parallelität:
       * schnell genug für eine Inventory-Seite,
       * ohne Shopify mit Requests zu fluten.
       */
      let cursor = 0;
      const concurrency = Math.min(4, rows.length);

      const worker = async () => {
        while (cursor < rows.length) {
          const index = cursor++;
          const row = rows[index];

          const productId = Number(row.id);

          try {
            let quantity: number | null = null;
            let tracked = false;
            let active = false;

            const inventoryItemId = String(
              row.shopify_inventory_item_id ?? ""
            ).trim();

            if (inventoryItemId) {
              const shopify =
                await getShopifyOnlineInventory({
                  inventoryItemId,
                });

              quantity = shopify.quantity;
              tracked = shopify.tracked;
              active = shopify.active;

              /*
               * Shopify quantity=null darf niemals als 0
               * interpretiert werden.
               */
              if (typeof quantity === "number") {
                await db.query(
                  `
                    INSERT INTO product_stock_snapshots (
                      product_id,
                      store_id,
                      exact_quantity,
                      updated_at
                    )
                    VALUES (
                      $1,
                      'online',
                      $2,
                      NOW()
                    )
                    ON CONFLICT (
                      product_id,
                      store_id
                    )
                    DO UPDATE SET
                      exact_quantity =
                        EXCLUDED.exact_quantity,
                      updated_at = NOW()
                  `,
                  [
                    productId,
                    quantity,
                  ]
                );
              }
            }

            const rawShopifyProductId = String(
              row.shopify_product_id ?? ""
            ).trim();

            if (rawShopifyProductId) {
              const shopifyImage =
                await getShopifyMainProductImage({
                  shopifyProductId: rawShopifyProductId,
                });

              if (shopifyImage?.imageUrl) {
                const imageFingerprint =
                  shopifyImage.mediaId
                    ? `shopify-media:${shopifyImage.mediaId}`
                    : `shopify-url:${shopifyImage.imageUrl}`;

                const existingImage =
                  await db.query(
                    `
                      SELECT id
                      FROM product_images
                      WHERE product_id = $1
                        AND is_primary = TRUE
                        AND original_name = $2
                      LIMIT 1
                    `,
                    [
                      productId,
                      imageFingerprint,
                    ]
                  );

                if (existingImage.rows.length === 0) {
                  const downloaded =
                    await downloadShopifyProductImage(
                      shopifyImage.imageUrl
                    );

                  if (downloaded.buffer.length > 0) {
                    const insertedImage =
                      await db.query(
                        `
                          INSERT INTO product_images (
                            product_id,
                            image_data,
                            mime_type,
                            original_name,
                            is_primary
                          )
                          VALUES (
                            $1,
                            $2,
                            $3,
                            $4,
                            TRUE
                          )
                          RETURNING id
                        `,
                        [
                          productId,
                          downloaded.buffer,
                          downloaded.mimeType,
                          imageFingerprint,
                        ]
                      );

                    const insertedImageId =
                      insertedImage.rows[0]?.id;

                    if (!insertedImageId) {
                      throw new Error(
                        "Shopify Produktbild konnte nicht gespeichert werden."
                      );
                    }

                    await db.query(
                      `
                        UPDATE product_images
                        SET is_primary = FALSE
                        WHERE product_id = $1
                          AND id <> $2
                          AND is_primary = TRUE
                      `,
                      [
                        productId,
                        insertedImageId,
                      ]
                    );
                  }
                }
              }
            }

            synced.push({
              productId,
              quantity,
              tracked,
              active,
            });
          } catch (error: any) {
            errors.push({
              productId,
              error:
                error?.message ??
                "Shopify Inventory-Sync fehlgeschlagen.",
            });
          }
        }
      };

      if (concurrency > 0) {
        await Promise.all(
          Array.from(
            { length: concurrency },
            () => worker()
          )
        );
      }

      return res.json({
        ok: errors.length === 0,
        found: rows.length,
        synced: synced.length,
        failed: errors.length,
        products: synced,
        errors,
      });
    } catch (error: any) {
      console.error(
        "Inventory Shopify online sync error:",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          error?.message ??
          "Shopify Online-Bestand konnte nicht synchronisiert werden.",
      });
    }
  }
);


productsRouter.get(
  "/api/products",
  requireStaffAuth,
  async (req, res) => {
    try {
      const rawPage = Number(req.query.page ?? 1);
      const rawLimit = Number(req.query.limit ?? 40);

      const page =
        Number.isSafeInteger(rawPage) && rawPage > 0
          ? rawPage
          : 1;

      const limit =
        Number.isSafeInteger(rawLimit) && rawLimit > 0
          ? Math.min(rawLimit, 100)
          : 40;

      const offset = (page - 1) * limit;

      const q =
        typeof req.query.q === "string"
          ? req.query.q.trim()
          : "";

      const location =
        typeof req.query.location === "string"
          ? req.query.location.trim().toLowerCase()
          : "all";

      const allowedLocations = new Set([
        "all",
        "aarau",
        "olten",
        "online",
      ]);

      if (!allowedLocations.has(location)) {
        return res.status(400).json({
          ok: false,
          error: "Ungültiger Standort.",
        });
      }

      const values: any[] = [];
      const where: string[] = [];

      if (q) {
        values.push(`%${q}%`);
        const i = values.length;

        where.push(`
          (
            p.title ILIKE $${i}
            OR p.barcode ILIKE $${i}
            OR COALESCE(p.brand, '') ILIKE $${i}
            OR COALESCE(p.product_name, '') ILIKE $${i}
            OR COALESCE(p.category, '') ILIKE $${i}
            OR COALESCE(p.subcategory, '') ILIKE $${i}
          )
        `);
      }

      if (location !== "all") {
        values.push(location);
        const i = values.length;

        where.push(`
          EXISTS (
            SELECT 1
            FROM product_stock_snapshots location_stock
            WHERE location_stock.product_id = p.id
              AND location_stock.store_id = $${i}
              AND COALESCE(location_stock.exact_quantity, 0) > 0
          )
        `);
      }

      const whereSql =
        where.length > 0
          ? `WHERE ${where.join(" AND ")}`
          : "";

      const countResult = await db.query(
        `
          SELECT COUNT(*)::int AS total
          FROM products p
          ${whereSql}
        `,
        values
      );

      const total =
        Number(countResult.rows[0]?.total ?? 0);

      const queryValues = [...values];
      queryValues.push(limit);
      const limitIndex = queryValues.length;

      queryValues.push(offset);
      const offsetIndex = queryValues.length;

      const result = await db.query(
        `
          SELECT
            p.id,
            p.barcode,
            p.title,
            p.brand,
            p.product_name,
            p.unit_size,
            p.category,
            p.subcategory,
            p.country,
            p.shopify_status,
            p.review_status,
            p.shopify_product_id,
            p.shopify_variant_id,
            p.shopify_inventory_item_id,
            p.updated_at,

            EXISTS (
              SELECT 1
              FROM product_images pi
              WHERE pi.product_id = p.id
            ) AS has_image,

            (
              SELECT
                EXTRACT(EPOCH FROM pi.created_at)::bigint
              FROM product_images pi
              WHERE pi.product_id = p.id
              ORDER BY
                pi.is_primary DESC,
                pi.created_at DESC,
                pi.id DESC
              LIMIT 1
            ) AS image_version,

            COALESCE(
              MAX(ps.exact_quantity)
                FILTER (WHERE ps.store_id = 'aarau'),
              0
            )::int AS aarau_quantity,

            COALESCE(
              MAX(ps.exact_quantity)
                FILTER (WHERE ps.store_id = 'olten'),
              0
            )::int AS olten_quantity,

            COALESCE(
              MAX(ps.exact_quantity)
                FILTER (WHERE ps.store_id = 'online'),
              0
            )::int AS online_quantity

          FROM products p

          LEFT JOIN product_stock_snapshots ps
            ON ps.product_id = p.id

          ${whereSql}

          GROUP BY p.id

          ORDER BY
            p.updated_at DESC NULLS LAST,
            p.id DESC

          LIMIT $${limitIndex}
          OFFSET $${offsetIndex}
        `,
        queryValues
      );

      const products = result.rows.map((row: any) => ({
        id: Number(row.id),
        barcode: row.barcode ?? null,
        title:
          row.title ??
          row.product_name ??
          "Unbenanntes Produkt",
        brand: row.brand ?? null,
        productName: row.product_name ?? null,
        unitSize: row.unit_size ?? null,
        category: row.category ?? null,
        subcategory: row.subcategory ?? null,
        country: row.country ?? null,
        shopifyStatus: row.shopify_status ?? null,
        reviewStatus: row.review_status ?? null,
        shopifyProductId: row.shopify_product_id ?? null,
        shopifyVariantId: row.shopify_variant_id ?? null,
        shopifyInventoryItemId:
          row.shopify_inventory_item_id ?? null,
        updatedAt: row.updated_at ?? null,

        hasImage: Boolean(row.has_image),
        imageVersion:
          row.image_version !== null &&
          row.image_version !== undefined
            ? String(row.image_version)
            : null,
        imageUrl: row.has_image
          ? `/api/products/${row.id}/image?v=${encodeURIComponent(
              String(row.image_version ?? "0")
            )}`
          : null,

        stock: {
          aarau: Number(row.aarau_quantity ?? 0),
          olten: Number(row.olten_quantity ?? 0),
          online: Number(row.online_quantity ?? 0),
        },

        totalQuantity:
          Number(row.aarau_quantity ?? 0) +
          Number(row.olten_quantity ?? 0) +
          Number(row.online_quantity ?? 0),
      }));

      return res.json({
        ok: true,
        products,
        pagination: {
          page,
          limit,
          total,
          pages:
            total === 0
              ? 0
              : Math.ceil(total / limit),
          hasMore:
            offset + products.length < total,
        },
      });
    } catch (error: any) {
      console.error(
        "Inventory product list error:",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          error?.message ??
          "Inventar konnte nicht geladen werden.",
      });
    }
  }
);

productsRouter.get(
  "/api/products/:id/image",
  requireStaffAuth,
  async (req, res) => {
    try {
      const id = Number(req.params.id);

      if (!Number.isSafeInteger(id) || id <= 0) {
        return res.status(400).json({
          ok: false,
          error: "Ungültige Product ID.",
        });
      }

      const result = await db.query(
        `
          SELECT
            image_data,
            mime_type
          FROM product_images
          WHERE product_id = $1
          ORDER BY
            is_primary DESC,
            created_at DESC
          LIMIT 1
        `,
        [id]
      );

      const image = result.rows[0];

      if (!image) {
        return res.status(404).json({
          ok: false,
          error: "Produktbild nicht gefunden.",
        });
      }

      res.setHeader(
        "Content-Type",
        String(image.mime_type || "image/jpeg")
      );

      res.setHeader(
        "Cache-Control",
        "private, max-age=300"
      );

      return res.send(image.image_data);
    } catch (error: any) {
      console.error(
        "Product image read error:",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          error?.message ??
          "Produktbild konnte nicht geladen werden.",
      });
    }
  }
);

productsRouter.get(
  "/api/products/:id",
  async (req, res) => {
    try {
      const id = Number(req.params.id);

      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({
          ok: false,
          error: "Ungültige Product ID.",
        });
      }

      const product = await getProductById(id);

      if (!product) {
        return res.status(404).json({
          ok: false,
          error: "Produkt nicht gefunden.",
        });
      }

      return res.json({
        ok: true,
        product,
      });
    } catch (error: any) {
      console.error("Product lookup error:", error);

      return res.status(500).json({
        ok: false,
        error:
          error?.message ??
          "Produkt konnte nicht geladen werden.",
      });
    }
  }
);


/**
 * Update an existing ALO Product Master record.
 *
 * Product identity is resolved by Product Master ID.
 * Barcode identity is protected during normal editing.
 *
 * saveProduct() remains the canonical persistence path so
 * existing product_versions behavior is preserved.
 */
productsRouter.patch(
  "/api/products/:id",
  requireStaffAuth,
  async (req, res) => {
    try {
      const id = Number(req.params.id);

      if (
        !Number.isSafeInteger(id) ||
        id <= 0
      ) {
        return res.status(400).json({
          ok: false,
          error: "Ungültige Product-Master-ID.",
        });
      }

      if (
        !req.body ||
        typeof req.body !== "object" ||
        Array.isArray(req.body)
      ) {
        return res.status(400).json({
          ok: false,
          error: "Produktdaten fehlen.",
        });
      }

      const existing =
        await getProductById(id);

      if (!existing) {
        return res.status(404).json({
          ok: false,
          error: "Produkt nicht gefunden.",
        });
      }

      const existingBarcode =
        String(
          existing.barcode ?? ""
        ).trim();

      if (!existingBarcode) {
        return res.status(409).json({
          ok: false,
          error:
            "Bestehendes Produkt besitzt keinen gültigen Barcode.",
        });
      }

      const requestedBarcode =
        req.body.barcode == null
          ? existingBarcode
          : String(req.body.barcode).trim();

      /*
       * Normal product editing may not silently change
       * the canonical barcode identity.
       */
      if (
        requestedBarcode !==
        existingBarcode
      ) {
        return res.status(409).json({
          ok: false,
          error:
            "Barcode kann über die normale Produktbearbeitung nicht geändert werden.",
        });
      }

      /*
       * PATCH semantics:
       * Missing fields inherit their current Product Master values.
       */
      const input = {
        barcode: existingBarcode,

        title:
          req.body.title ??
          existing.title,

        ageRequirement:
          req.body.ageRequirement ??
          existing.age_requirement,

        ageRequirementReviewed:
          req.body.ageRequirementReviewed ??
          false,

        brand:
          req.body.brand ??
          existing.brand,

        productName:
          req.body.productName ??
          existing.product_name,

        flavor:
          req.body.flavor ??
          existing.flavor,

        unitSize:
          req.body.unitSize ??
          existing.unit_size,

        category:
          req.body.category ??
          existing.category,

        subcategory:
          req.body.subcategory ??
          existing.subcategory,

        country:
          req.body.country ??
          existing.country,

        shortDescription:
          req.body.shortDescription ??
          existing.short_description,

        descriptionHtml:
          req.body.descriptionHtml ??
          existing.description_html,

        ingredients:
          req.body.ingredients ??
          existing.ingredients,

        allergens:
          req.body.allergens ??
          existing.allergens,

        nutrition:
          req.body.nutrition ??
          existing.nutrition,

        nutritionPer100:
          req.body.nutritionPer100 ??
          existing.nutrition_per_100 ??
          {},

        dietary:
          req.body.dietary ??
          existing.dietary ??
          {},

        tags:
          req.body.tags ??
          existing.tags ??
          [],

        searchKeywords:
          req.body.searchKeywords ??
          existing.search_keywords ??
          [],

        seoTitle:
          req.body.seoTitle ??
          existing.seo_title,

        seoDescription:
          req.body.seoDescription ??
          existing.seo_description,

        vendor:
          req.body.vendor ??
          existing.vendor,

        productType:
          req.body.productType ??
          existing.product_type,

        confidence:
          req.body.confidence ??
          existing.confidence,

        fieldConfidence:
          req.body.fieldConfidence ??
          existing.field_confidence ??
          {},

        warnings:
          req.body.warnings ??
          existing.warnings ??
          [],

        reviewedBy:
          req.body.reviewedBy ??
          "staff_app",

        sourceType:
          req.body.sourceType ??
          "staff_app_edit",

        sourceData:
          req.body.sourceData ??
          existing.source_data ??
          {},

        aiDraft:
          req.body.aiDraft ??
          existing.ai_draft ??
          {},
      };

      const product =
        await saveProduct(input);

      /*
       * Defense in depth:
       * editing ID X must return the same Product Master ID X.
       */
      if (
        String(product.id) !==
        String(existing.id)
      ) {
        throw new Error(
          "PRODUCT_IDENTITY_MISMATCH"
        );
      }

      return res.json({
        ok: true,
        product,
      });
    } catch (error: any) {
      console.error(
        "Product update error:",
        error
      );

      const message =
        error?.message ??
        "Produkt konnte nicht aktualisiert werden.";

      const status =
        message === "PRODUCT_IDENTITY_MISMATCH"
          ? 409
          : message === "Barcode fehlt." ||
            message === "Produkttitel fehlt."
          ? 400
          : 500;

      return res.status(status).json({
        ok: false,
        error: message,
      });
    }
  }
);

productsRouter.post(
  "/api/products",
  requireStaffAuth,
  async (req, res) => {
    try {
      if (!req.body || typeof req.body !== "object") {
        return res.status(400).json({
          ok: false,
          error: "Product Draft fehlt.",
        });
      }

      const product = await saveProduct(req.body);

      return res.status(201).json({
        ok: true,
        product,
      });
    } catch (error: any) {
      console.error("Product save error:", error);

      const message =
        error?.message ??
        "Produkt konnte nicht gespeichert werden.";

      const isValidation =
        message === "Barcode fehlt." ||
        message === "Produkttitel fehlt.";

      return res
        .status(isValidation ? 400 : 500)
        .json({
          ok: false,
          error: message,
        });
    }
  }
);

export default productsRouter;


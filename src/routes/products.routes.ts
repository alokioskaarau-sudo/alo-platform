import { Router } from "express";
import { db } from "../database/db.js";

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
            p.updated_at,

            EXISTS (
              SELECT 1
              FROM product_images pi
              WHERE pi.product_id = p.id
            ) AS has_image,

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
        updatedAt: row.updated_at ?? null,

        hasImage: Boolean(row.has_image),
        imageUrl: row.has_image
          ? `/api/products/${row.id}/image`
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


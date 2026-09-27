import { Router } from "express";

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


import { Router } from "express";

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

productsRouter.post(
  "/api/products",
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

import { db } from "../database/db.js";

import {
  resolveProductIdentity,
} from "./productIdentity.service.js";

import {
  automateReceivingProduct,
  ReceivingProductAutomationResult,
} from "./receivingProductAutomation.service.js";

import {
  rememberSupplierArticle,
  resolveReceivingProductMaster,
} from "./receivingProductMatcher.service.js";

function cleanText(
  value: unknown
): string {
  return String(value ?? "").trim();
}

function cleanBarcode(
  value: unknown
): string {
  return String(value ?? "")
    .replace(/\s+/g, "")
    .trim();
}

export type PrepareReceivingNewProductInput = {
  supplier: string;
  product: string;
  barcode?: string | null;
  articleNumber?: string | null;
  unitSize?: string | null;
  unitCost?: number | null;

  /**
   * Falls diese Draft-Position bereits
   * vorbereitet wurde, wird derselbe
   * Product Master wiederverwendet.
   */
  productMasterId?:
    | string
    | number
    | null;
};

export type PrepareReceivingNewProductResult = {
  productId: string;
  created: boolean;
  reused: boolean;
  linkedExistingShopify: boolean;
  automation:
    ReceivingProductAutomationResult;
};

async function getProduct(
  productId: string
): Promise<any | null> {
  const result =
    await db.query(
      `
        SELECT
          id,
          barcode,
          title,
          product_data,
          review_status,
          shopify_status,
          shopify_product_id,
          shopify_variant_id,
          shopify_inventory_item_id
        FROM products
        WHERE id = $1
        LIMIT 1
      `,
      [productId]
    );

  return result.rows[0] ?? null;
}

/**
 * Bereitet ein eindeutig neues Produkt vor.
 *
 * WICHTIG:
 * - veröffentlicht niemals das Produkt
 * - bucht niemals Bestand
 * - erstellt niemals Receiving-Allocations
 * - wiederholte Aufrufe mit productMasterId
 *   verwenden denselben Product Master
 */
export async function prepareReceivingNewProduct(
  input: PrepareReceivingNewProductInput
): Promise<PrepareReceivingNewProductResult> {
  const supplier =
    cleanText(input.supplier);

  const productName =
    cleanText(input.product);

  const barcode =
    cleanBarcode(input.barcode);

  const articleNumber =
    cleanText(input.articleNumber);

  const unitSize =
    cleanText(input.unitSize);

  if (!supplier) {
    throw new Error(
      "Lieferant fehlt."
    );
  }

  if (!productName) {
    throw new Error(
      "Produktname fehlt."
    );
  }

  /*
   * 1. Idempotenz über bereits gespeicherte
   *    Product-Master-ID.
   */
  const existingProductId =
    String(
      input.productMasterId ?? ""
    ).trim();

  if (existingProductId) {
    if (
      !/^\d+$/.test(
        existingProductId
      )
    ) {
      throw new Error(
        "Ungültige Product-Master-ID im Receiving Draft."
      );
    }

    const existing =
      await getProduct(
        existingProductId
      );

    if (!existing) {
      throw new Error(
        `Product Master ${existingProductId} wurde nicht gefunden.`
      );
    }

    await rememberSupplierArticle({
      productId:
        existingProductId,
      supplier,
      articleNumber:
        articleNumber || null,
    });

    const automation =
      await automateReceivingProduct(
        existingProductId
      );

    return {
      productId:
        existingProductId,
      created: false,
      reused: true,
      linkedExistingShopify:
        Boolean(
          existing.shopify_product_id
        ),
      automation,
    };
  }

  /*
   * 2. Vor jeder Neuanlage nochmals gegen
   *    den Product Master prüfen.
   *
   *    Ein exakter Barcode darf niemals
   *    als neues Produkt angelegt werden.
   */
  const resolution =
    await resolveReceivingProductMaster({
      barcode:
        barcode || null,
      supplier,
      articleNumber:
        articleNumber || null,
      title:
        productName,
      unitSize:
        unitSize || null,
    });

  if (
    resolution.status ===
    "MATCH"
  ) {
    const matchedBarcode =
      cleanBarcode(
        resolution.product
          ?.barcode
      );

    if (
      barcode &&
      matchedBarcode === barcode
    ) {
      throw new Error(
        "EXACT_BARCODE_CONFLICT"
      );
    }
  }

  if (
    resolution.status ===
    "AMBIGUOUS" &&
    barcode
  ) {
    const exactBarcodeConflict =
      resolution.matches.some(
        (match) =>
          cleanBarcode(
            match.product
              ?.barcode
          ) === barcode
      );

    if (exactBarcodeConflict) {
      throw new Error(
        "EXACT_BARCODE_CONFLICT"
      );
    }
  }

  /*
   * 3. Shopify darf bereits einen passenden
   *    Artikel besitzen. Dann erstellen wir
   *    trotzdem den internen Product Master,
   *    verknüpfen ihn aber mit Shopify,
   *    statt dort ein Duplikat zu erzeugen.
   */
  let resolvedShopifyMatch:
    any = null;

  if (barcode) {
    const identity =
      await resolveProductIdentity({
        barcode,
        title:
          productName,
        unitSize:
          unitSize || null,
        netWeight: null,
      });

    if (
      identity.status ===
        "MULTIPLE_BARCODE_MATCHES" ||
      identity.status ===
        "MULTIPLE_IDENTITY_MATCHES"
    ) {
      throw new Error(
        "SHOPIFY_MATCH_AMBIGUOUS"
      );
    }

    if (
      identity.status ===
        "EXACT_BARCODE" ||
      identity.status ===
        "EXACT_TITLE_SIZE"
    ) {
      resolvedShopifyMatch =
        identity.match;
    }
  }

  const productDraft = {
    title:
      productName.toUpperCase(),

    barcode:
      barcode || null,

    productName,

    unitSize:
      unitSize || null,

    commerce: {
      purchasePrice:
        input.unitCost ?? null,
      pointsMultiplier: 1,
    },

    receiving: {
      supplier,
      articleNumber:
        articleNumber || null,
      lastUnitCost:
        input.unitCost ?? null,
    },
  };

  /*
   * 4. Product Master anlegen.
   *
   *    NEEDS_REVIEW bleibt absichtlich:
   *    automatisch vorbereitet bedeutet
   *    NICHT automatisch freigegeben.
   */
  const created =
    await db.query(
      `
        INSERT INTO products (
          barcode,
          title,
          product_data,
          source_type,
          review_status,
          reviewed_by,
          reviewed_at,
          shopify_status,
          shopify_product_id,
          shopify_variant_id,
          shopify_inventory_item_id,
          updated_at
        )
        VALUES (
          $1,
          $2,
          $3::jsonb,
          'alo_staff_receiving',
          'NEEDS_REVIEW',
          NULL,
          NULL,
          $4,
          $5,
          $6,
          $7,
          NOW()
        )
        RETURNING
          id,
          barcode,
          title,
          product_data,
          shopify_status,
          shopify_product_id,
          shopify_variant_id,
          shopify_inventory_item_id
      `,
      [
        barcode || null,
        productName.toUpperCase(),
        JSON.stringify(
          productDraft
        ),
        resolvedShopifyMatch
          ? "LINKED_EXISTING"
          : "NOT_SYNCED",
        resolvedShopifyMatch
          ?.productId ?? null,
        resolvedShopifyMatch
          ?.variantId ?? null,
        resolvedShopifyMatch
          ?.inventoryItemId ??
          null,
      ]
    );

  const product =
    created.rows[0];

  const productId =
    String(product.id);

  await rememberSupplierArticle({
    productId,
    supplier,
    articleNumber:
      articleNumber || null,
  });

  /*
   * 5. Bestehende Automation:
   *
   *    Online-Verifikation
   *       ↓
   *    nur fehlende Felder ergänzen
   *       ↓
   *    Shopify-DRAFT erzeugen/verknüpfen
   *
   *    KEIN Publish.
   *    KEIN Bestand.
   */
  const automation =
    await automateReceivingProduct(
      productId
    );

  return {
    productId,
    created: true,
    reused: false,
    linkedExistingShopify:
      Boolean(
        resolvedShopifyMatch
          ?.productId
      ),
    automation,
  };
}

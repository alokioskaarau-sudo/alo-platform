import { db } from "./db.js";

export type ProductMasterInput = {
  barcode: string;
  title: string;
  brand?: string | null;
  productName?: string | null;
  flavor?: string | null;
  unitSize?: string | null;
  category?: string | null;
  subcategory?: string | null;
  country?: string | null;
  shortDescription?: string | null;
  descriptionHtml?: string | null;
  ingredients?: string | null;
  allergens?: string | null;
  nutrition?: string | null;
  nutritionPer100?: unknown;
  dietary?: unknown;
  tags?: string[];
  searchKeywords?: string[];
  seoTitle?: string | null;
  seoDescription?: string | null;
  vendor?: string | null;
  productType?: string | null;
  confidence?: number | null;
  fieldConfidence?: unknown;
  warnings?: string[];
  sourceType?: string | null;
  sourceData?: unknown;
  aiDraft?: unknown;
  reviewedBy?: string | null;
};

export type ProductMasterRecord = {
  id: number;
  barcode: string;
  title: string;
  brand: string | null;
  product_name: string | null;
  flavor: string | null;
  unit_size: string | null;
  category: string | null;
  subcategory: string | null;
  country: string | null;
  short_description: string | null;
  description_html: string | null;
  ingredients: string | null;
  allergens: string | null;
  nutrition: string | null;
  nutrition_per_100: unknown;
  dietary: unknown;
  tags: string[];
  search_keywords: string[];
  seo_title: string | null;
  seo_description: string | null;
  vendor: string | null;
  product_type: string | null;
  confidence: number | null;
  field_confidence: unknown;
  warnings: string[];
  review_status: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  shopify_status: string;
  shopify_product_id: string | null;
  shopify_variant_id: string | null;
  shopify_inventory_item_id: string | null;
  source_type: string | null;
  source_data: unknown;
  ai_draft: unknown;
  created_at: string;
  updated_at: string;
};

function cleanBarcode(value: unknown): string {
  return String(value ?? "").trim().replace(/\s+/g, "");
}

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const valueClean = value.trim();
  return valueClean || null;
}

function cleanArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

export async function getProductByBarcode(
  barcodeInput: string
): Promise<ProductMasterRecord | null> {
  const barcode = cleanBarcode(barcodeInput);

  if (!barcode) {
    return null;
  }

  const result = await db.query<ProductMasterRecord>(
    `
      SELECT *
      FROM products
      WHERE barcode = $1
      LIMIT 1
    `,
    [barcode]
  );

  return result.rows[0] ?? null;
}

export async function getProductById(
  id: number
): Promise<ProductMasterRecord | null> {
  const result = await db.query<ProductMasterRecord>(
    `
      SELECT *
      FROM products
      WHERE id = $1
      LIMIT 1
    `,
    [id]
  );

  return result.rows[0] ?? null;
}

export async function saveProduct(
  input: ProductMasterInput
): Promise<ProductMasterRecord> {
  const barcode = cleanBarcode(input.barcode);
  const title = cleanText(input.title)?.toUpperCase();

  if (!barcode) {
    throw new Error("Barcode fehlt.");
  }

  if (!title) {
    throw new Error("Produkttitel fehlt.");
  }

  const client = await db.connect();

  try {
    await client.query("BEGIN");

    const previousResult =
      await client.query<ProductMasterRecord>(
        `
          SELECT *
          FROM products
          WHERE barcode = $1
          FOR UPDATE
        `,
        [barcode]
      );

    const previous = previousResult.rows[0] ?? null;

    if (previous) {
      await client.query(
        `
          INSERT INTO product_versions (
            product_id,
            snapshot,
            changed_by,
            change_source
          )
          VALUES ($1, $2::jsonb, $3, $4)
        `,
        [
          previous.id,
          JSON.stringify(previous),
          cleanText(input.reviewedBy),
          cleanText(input.sourceType) ?? "staff_app",
        ]
      );
    }

    const result =
      await client.query<ProductMasterRecord>(
        `
          INSERT INTO products (
            barcode,
            title,
            brand,
            product_name,
            flavor,
            unit_size,
            category,
            subcategory,
            country,
            short_description,
            description_html,
            ingredients,
            allergens,
            nutrition,
            nutrition_per_100,
            dietary,
            tags,
            search_keywords,
            seo_title,
            seo_description,
            vendor,
            product_type,
            confidence,
            field_confidence,
            warnings,
            review_status,
            reviewed_by,
            reviewed_at,
            source_type,
            source_data,
            ai_draft,
            updated_at
          )
          VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
            $11,$12,$13,$14,$15::jsonb,$16::jsonb,
            $17::jsonb,$18::jsonb,$19,$20,$21,$22,
            $23,$24::jsonb,$25::jsonb,
            'REVIEWED',$26,NOW(),$27,$28::jsonb,$29::jsonb,NOW()
          )

          ON CONFLICT (barcode)
          DO UPDATE SET
            title = EXCLUDED.title,
            brand = EXCLUDED.brand,
            product_name = EXCLUDED.product_name,
            flavor = EXCLUDED.flavor,
            unit_size = EXCLUDED.unit_size,
            category = EXCLUDED.category,
            subcategory = EXCLUDED.subcategory,
            country = EXCLUDED.country,
            short_description = EXCLUDED.short_description,
            description_html = EXCLUDED.description_html,
            ingredients = EXCLUDED.ingredients,
            allergens = EXCLUDED.allergens,
            nutrition = EXCLUDED.nutrition,
            nutrition_per_100 = EXCLUDED.nutrition_per_100,
            dietary = EXCLUDED.dietary,
            tags = EXCLUDED.tags,
            search_keywords = EXCLUDED.search_keywords,
            seo_title = EXCLUDED.seo_title,
            seo_description = EXCLUDED.seo_description,
            vendor = EXCLUDED.vendor,
            product_type = EXCLUDED.product_type,
            confidence = EXCLUDED.confidence,
            field_confidence = EXCLUDED.field_confidence,
            warnings = EXCLUDED.warnings,
            review_status = EXCLUDED.review_status,
            reviewed_by = EXCLUDED.reviewed_by,
            reviewed_at = EXCLUDED.reviewed_at,
            source_type = EXCLUDED.source_type,
            source_data = EXCLUDED.source_data,
            ai_draft = EXCLUDED.ai_draft,
            updated_at = NOW()

          RETURNING *
        `,
        [
          barcode,
          title,
          cleanText(input.brand),
          cleanText(input.productName),
          cleanText(input.flavor),
          cleanText(input.unitSize),
          cleanText(input.category),
          cleanText(input.subcategory),
          cleanText(input.country),
          cleanText(input.shortDescription),
          cleanText(input.descriptionHtml),
          cleanText(input.ingredients),
          cleanText(input.allergens),
          cleanText(input.nutrition),
          JSON.stringify(input.nutritionPer100 ?? {}),
          JSON.stringify(input.dietary ?? {}),
          JSON.stringify(cleanArray(input.tags)),
          JSON.stringify(cleanArray(input.searchKeywords)),
          cleanText(input.seoTitle),
          cleanText(input.seoDescription),
          cleanText(input.vendor),
          cleanText(input.productType),
          typeof input.confidence === "number"
            ? input.confidence
            : null,
          JSON.stringify(input.fieldConfidence ?? {}),
          JSON.stringify(cleanArray(input.warnings)),
          cleanText(input.reviewedBy),
          cleanText(input.sourceType) ?? "staff_app",
          JSON.stringify(input.sourceData ?? {}),
          JSON.stringify(input.aiDraft ?? {}),
        ]
      );

    await client.query("COMMIT");

    return result.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

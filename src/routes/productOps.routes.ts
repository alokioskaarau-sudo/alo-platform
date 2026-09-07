import { Router } from "express";
import multer from "multer";
import axios from "axios";

import { db } from "../database/db.js";
import { env } from "../config/env.js";
import {
  getShopifyAccessToken,
} from "../integrations/shopify/auth.js";

const router = Router();

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    const allowed = new Set([
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/heic",
      "image/heif",
    ]);

    if (!allowed.has(file.mimetype)) {
      cb(
        new Error(
          `Nicht unterstütztes Bildformat: ${file.mimetype}`
        )
      );
      return;
    }

    cb(null, true);
  },
});

let schemaPromise:
  | Promise<void>
  | null = null;

function normalizeBarcode(
  value: unknown
): string {
  return String(value ?? "")
    .replace(/\s+/g, "")
    .trim();
}

function normalizeShop(
  value: string
): string {
  return value
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "")
    .replace(/\.myshopify\.com$/, "");
}

async function ensureSchema() {
  if (schemaPromise) {
    return schemaPromise;
  }

  schemaPromise = (async () => {
    await db.query(`
      ALTER TABLE products
      ADD COLUMN IF NOT EXISTS
        product_data JSONB
        NOT NULL
        DEFAULT '{}'::jsonb
    `);

    await db.query(`
      ALTER TABLE products
      ADD COLUMN IF NOT EXISTS
        source_type TEXT
        DEFAULT 'alo_staff'
    `);

    await db.query(`
      ALTER TABLE products
      ADD COLUMN IF NOT EXISTS
        review_status TEXT
        DEFAULT 'REVIEWED'
    `);

    await db.query(`
      ALTER TABLE products
      ADD COLUMN IF NOT EXISTS
        reviewed_by TEXT
    `);

    await db.query(`
      ALTER TABLE products
      ADD COLUMN IF NOT EXISTS
        reviewed_at TIMESTAMPTZ
    `);

    await db.query(`
      ALTER TABLE products
      ADD COLUMN IF NOT EXISTS
        shopify_status TEXT
        NOT NULL
        DEFAULT 'NOT_SYNCED'
    `);

    await db.query(`
      ALTER TABLE products
      ADD COLUMN IF NOT EXISTS
        shopify_product_id TEXT
    `);

    await db.query(`
      ALTER TABLE products
      ADD COLUMN IF NOT EXISTS
        shopify_variant_id TEXT
    `);

    await db.query(`
      ALTER TABLE products
      ADD COLUMN IF NOT EXISTS
        shopify_inventory_item_id TEXT
    `);

    await db.query(`
      ALTER TABLE products
      ADD COLUMN IF NOT EXISTS
        updated_at TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW()
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS
        product_images (
          id BIGSERIAL PRIMARY KEY,

          product_id BIGINT
            NOT NULL
            REFERENCES products(id)
            ON DELETE CASCADE,

          image_data BYTEA
            NOT NULL,

          mime_type TEXT
            NOT NULL,

          original_name TEXT,

          is_primary BOOLEAN
            NOT NULL
            DEFAULT TRUE,

          created_at TIMESTAMPTZ
            NOT NULL
            DEFAULT NOW()
        )
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS
        product_images_product_idx
      ON product_images(product_id)
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS
        product_stock_snapshots (
          id BIGSERIAL PRIMARY KEY,

          product_id BIGINT
            NOT NULL
            REFERENCES products(id)
            ON DELETE CASCADE,

          store_id TEXT
            NOT NULL,

          exact_quantity INTEGER,

          stock_level TEXT
            NOT NULL
            DEFAULT 'unknown',

          note TEXT,

          updated_by TEXT,

          updated_at TIMESTAMPTZ
            NOT NULL
            DEFAULT NOW(),

          UNIQUE(product_id, store_id)
        )
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS
        product_stock_product_idx
      ON product_stock_snapshots(
        product_id,
        store_id
      )
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS
        product_signals (
          id BIGSERIAL PRIMARY KEY,

          product_id BIGINT
            NOT NULL
            REFERENCES products(id)
            ON DELETE CASCADE,

          store_id TEXT,

          signal_type TEXT
            NOT NULL,

          note TEXT,

          created_by TEXT,

          created_at TIMESTAMPTZ
            NOT NULL
            DEFAULT NOW()
        )
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS
        product_signals_product_idx
      ON product_signals(
        product_id,
        created_at DESC
      )
    `);
  })();

  return schemaPromise;
}

async function getProduct(
  id: string
) {
  await ensureSchema();

  const result = await db.query(
    `
      SELECT
        id,
        barcode,
        title,
        product_data,
        source_type,
        review_status,
        shopify_status,
        shopify_product_id,
        shopify_variant_id,
        shopify_inventory_item_id,
        updated_at
      FROM products
      WHERE id = $1
      LIMIT 1
    `,
    [id]
  );

  return result.rows[0] ?? null;
}

async function getProductStock(
  productId: string
) {
  const result = await db.query(
    `
      SELECT
        store_id,
        exact_quantity,
        stock_level,
        note,
        updated_by,
        updated_at
      FROM product_stock_snapshots
      WHERE product_id = $1
      ORDER BY store_id
    `,
    [productId]
  );

  return result.rows;
}

async function getProductSignals(
  productId: string
) {
  const result = await db.query(
    `
      SELECT
        id,
        store_id,
        signal_type,
        note,
        created_by,
        created_at
      FROM product_signals
      WHERE product_id = $1
      ORDER BY created_at DESC
      LIMIT 40
    `,
    [productId]
  );

  return result.rows;
}

function toApiProduct(
  row: any,
  stock: any[] = [],
  signals: any[] = []
) {
  return {
    id: String(row.id),
    barcode: row.barcode,
    title: row.title,
    productData:
      row.product_data ?? {},
    sourceType:
      row.source_type ?? null,
    reviewStatus:
      row.review_status ?? null,
    shopifyStatus:
      row.shopify_status ??
      "NOT_SYNCED",
    shopifyProductId:
      row.shopify_product_id ?? null,
    shopifyVariantId:
      row.shopify_variant_id ?? null,
    shopifyInventoryItemId:
      row.shopify_inventory_item_id ??
      null,
    updatedAt:
      row.updated_at ?? null,
    stock,
    signals,
  };
}

async function shopifyGraphql(
  query: string,
  variables: Record<
    string,
    unknown
  >
) {
  const token =
    await getShopifyAccessToken();

  const shop =
    normalizeShop(
      env.shopify.shop
    );

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

async function stageProductImage(
  productId: string
): Promise<
  | {
      source: string;
      alt: string;
    }
  | null
> {
  const imageResult =
    await db.query(
      `
        SELECT
          image_data,
          mime_type,
          original_name
        FROM product_images
        WHERE product_id = $1
        ORDER BY
          is_primary DESC,
          created_at DESC
        LIMIT 1
      `,
      [productId]
    );

  const image =
    imageResult.rows[0];

  if (!image) {
    return null;
  }

  const mime =
    String(
      image.mime_type ||
        "image/jpeg"
    );

  const extension =
    mime.includes("png")
      ? "png"
      : mime.includes("webp")
        ? "webp"
        : "jpg";

  const filename =
    image.original_name ||
    `alo-product-${productId}.${extension}`;

  const staged =
    await shopifyGraphql(
      `
        mutation AloStageProductImage(
          $input: [StagedUploadInput!]!
        ) {
          stagedUploadsCreate(
            input: $input
          ) {
            stagedTargets {
              url
              resourceUrl
              parameters {
                name
                value
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
        input: [
          {
            resource:
              "PRODUCT_IMAGE",
            filename,
            mimeType: mime,
            httpMethod: "POST",
          },
        ],
      }
    );

  const payload =
    staged?.stagedUploadsCreate;

  if (
    payload?.userErrors?.length
  ) {
    throw new Error(
      payload.userErrors
        .map(
          (error: any) =>
            error.message
        )
        .join(" · ")
    );
  }

  const target =
    payload?.stagedTargets?.[0];

  if (
    !target?.url ||
    !target?.resourceUrl
  ) {
    throw new Error(
      "Shopify Bild-Upload-Ziel fehlt."
    );
  }

  const form =
    new FormData();

  for (
    const parameter
    of target.parameters ?? []
  ) {
    form.append(
      parameter.name,
      parameter.value
    );
  }

  const bytes =
    new Uint8Array(
      image.image_data
    );

  form.append(
    "file",
    new Blob(
      [bytes],
      {
        type: mime,
      }
    ),
    filename
  );

  const uploadResponse =
    await fetch(
      target.url,
      {
        method: "POST",
        body: form,
      }
    );

  if (
    !uploadResponse.ok
  ) {
    throw new Error(
      `Shopify Bild-Upload fehlgeschlagen (${uploadResponse.status}).`
    );
  }

  return {
    source:
      target.resourceUrl,
    alt: filename,
  };
}

router.post(
  "/api/product-master",
  async (req, res) => {
    try {
      await ensureSchema();

      const draft =
        req.body?.draft ??
        req.body;

      const barcode =
        normalizeBarcode(
          draft?.barcode
        );

      const title =
        String(
          draft?.title ?? ""
        )
          .trim()
          .toUpperCase();

      if (!barcode) {
        res.status(400).json({
          ok: false,
          error:
            "Barcode fehlt.",
        });
        return;
      }

      if (!title) {
        res.status(400).json({
          ok: false,
          error:
            "Produkttitel fehlt.",
        });
        return;
      }

      const sourceType =
        String(
          req.body?.sourceType ??
            "alo_staff"
        );

      const reviewedBy =
        String(
          req.body?.reviewedBy ??
            "ALO STAFF"
        );

      const result =
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
              updated_at
            )
            VALUES (
              $1,
              $2,
              $3::jsonb,
              $4,
              'REVIEWED',
              $5,
              NOW(),
              NOW()
            )

            ON CONFLICT (barcode)
            DO UPDATE SET
              title =
                EXCLUDED.title,
              product_data =
                EXCLUDED.product_data,
              source_type =
                EXCLUDED.source_type,
              review_status =
                'REVIEWED',
              reviewed_by =
                EXCLUDED.reviewed_by,
              reviewed_at =
                NOW(),
              updated_at =
                NOW()

            RETURNING
              id,
              barcode,
              title,
              product_data,
              source_type,
              review_status,
              shopify_status,
              shopify_product_id,
              shopify_variant_id,
              shopify_inventory_item_id,
              updated_at
          `,
          [
            barcode,
            title,
            JSON.stringify({
              ...draft,
              barcode,
              title,
            }),
            sourceType,
            reviewedBy,
          ]
        );

      const row =
        result.rows[0];

      const stock =
        await getProductStock(
          String(row.id)
        );

      const signals =
        await getProductSignals(
          String(row.id)
        );

      res.json({
        ok: true,
        product:
          toApiProduct(
            row,
            stock,
            signals
          ),
      });
    } catch (error) {
      console.error(
        "Product Master save error:",
        error
      );

      res.status(500).json({
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Produkt konnte nicht gespeichert werden.",
      });
    }
  }
);

router.get(
  "/api/product-master/barcode/:barcode",
  async (req, res) => {
    try {
      await ensureSchema();

      const barcode =
        normalizeBarcode(
          req.params.barcode
        );

      const result =
        await db.query(
          `
            SELECT
              id,
              barcode,
              title,
              product_data,
              source_type,
              review_status,
              shopify_status,
              shopify_product_id,
              shopify_variant_id,
              shopify_inventory_item_id,
              updated_at
            FROM products
            WHERE barcode = $1
            LIMIT 1
          `,
          [barcode]
        );

      const row =
        result.rows[0];

      if (!row) {
        res.status(404).json({
          ok: false,
          found: false,
        });
        return;
      }

      const productId =
        String(row.id);

      res.json({
        ok: true,
        found: true,
        product:
          toApiProduct(
            row,
            await getProductStock(
              productId
            ),
            await getProductSignals(
              productId
            )
          ),
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Lookup fehlgeschlagen.",
      });
    }
  }
);

router.get(
  "/api/product-master",
  async (_req, res) => {
    try {
      await ensureSchema();

      const result =
        await db.query(`
          SELECT
            id,
            barcode,
            title,
            product_data,
            source_type,
            review_status,
            shopify_status,
            shopify_product_id,
            shopify_variant_id,
            shopify_inventory_item_id,
            updated_at
          FROM products
          ORDER BY updated_at DESC
          LIMIT 500
        `);

      const products =
        await Promise.all(
          result.rows.map(
            async (row) =>
              toApiProduct(
                row,
                await getProductStock(
                  String(row.id)
                ),
                []
              )
          )
        );

      res.json({
        ok: true,
        products,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Produkte konnten nicht geladen werden.",
      });
    }
  }
);

router.post(
  "/api/product-master/:id/image",
  imageUpload.single("image"),
  async (req, res) => {
    try {
      await ensureSchema();

      const file =
        req.file;

      if (!file) {
        res.status(400).json({
          ok: false,
          error:
            "Produktbild fehlt.",
        });
        return;
      }

      const productId =
        String(req.params.id);

      const product =
        await getProduct(
          productId
        );

      if (!product) {
        res.status(404).json({
          ok: false,
          error:
            "Produkt nicht gefunden.",
        });
        return;
      }

      const client =
        await db.connect();

      try {
        await client.query(
          "BEGIN"
        );

        await client.query(
          `
            UPDATE product_images
            SET is_primary = FALSE
            WHERE product_id = $1
          `,
          [req.params.id]
        );

        await client.query(
          `
            INSERT INTO
              product_images (
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
          `,
          [
            req.params.id,
            file.buffer,
            file.mimetype,
            file.originalname,
          ]
        );

        await client.query(
          "COMMIT"
        );
      } catch (error) {
        await client.query(
          "ROLLBACK"
        );
        throw error;
      } finally {
        client.release();
      }

      res.json({
        ok: true,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Bild konnte nicht gespeichert werden.",
      });
    }
  }
);

router.get(
  "/api/product-master/:id/image",
  async (req, res) => {
    try {
      await ensureSchema();

      const result =
        await db.query(
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
          [req.params.id]
        );

      const image =
        result.rows[0];

      if (!image) {
        res.status(404).end();
        return;
      }

      res.setHeader(
        "Content-Type",
        image.mime_type
      );

      res.setHeader(
        "Cache-Control",
        "public, max-age=3600"
      );

      res.send(
        image.image_data
      );
    } catch {
      res.status(500).end();
    }
  }
);

router.put(
  "/api/product-master/:id/stock/:storeId",
  async (req, res) => {
    try {
      await ensureSchema();

      const allowedStores =
        new Set([
          "aarau",
          "olten",
        ]);

      const allowedLevels =
        new Set([
          "unknown",
          "full",
          "medium",
          "low",
          "almost_empty",
          "empty",
        ]);

      const storeId =
        String(
          req.params.storeId
        ).toLowerCase();

      if (
        !allowedStores.has(
          storeId
        )
      ) {
        res.status(400).json({
          ok: false,
          error:
            "Ungültiger Standort.",
        });
        return;
      }

      const level =
        String(
          req.body?.stockLevel ??
            "unknown"
        );

      if (
        !allowedLevels.has(
          level
        )
      ) {
        res.status(400).json({
          ok: false,
          error:
            "Ungültiger Bestandsstatus.",
        });
        return;
      }

      const quantity =
        req.body?.exactQuantity ===
          null ||
        req.body?.exactQuantity ===
          undefined ||
        req.body?.exactQuantity ===
          ""
          ? null
          : Number(
              req.body
                .exactQuantity
            );

      if (
        quantity !== null &&
        (
          !Number.isInteger(
            quantity
          ) ||
          quantity < 0
        )
      ) {
        res.status(400).json({
          ok: false,
          error:
            "Exakter Bestand muss eine positive ganze Zahl sein.",
        });
        return;
      }

      const note =
        typeof req.body?.note ===
        "string"
          ? req.body.note.trim()
          : "";

      const updatedBy =
        typeof req.body
          ?.updatedBy ===
        "string"
          ? req.body.updatedBy
          : "ALO STAFF";

      await db.query(
        `
          INSERT INTO
            product_stock_snapshots (
              product_id,
              store_id,
              exact_quantity,
              stock_level,
              note,
              updated_by,
              updated_at
            )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            NOW()
          )

          ON CONFLICT (
            product_id,
            store_id
          )
          DO UPDATE SET
            exact_quantity =
              EXCLUDED.exact_quantity,
            stock_level =
              EXCLUDED.stock_level,
            note =
              EXCLUDED.note,
            updated_by =
              EXCLUDED.updated_by,
            updated_at =
              NOW()
        `,
        [
          req.params.id,
          storeId,
          quantity,
          level,
          note || null,
          updatedBy,
        ]
      );

      res.json({
        ok: true,
        stock:
          await getProductStock(
            req.params.id
          ),
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Bestand konnte nicht aktualisiert werden.",
      });
    }
  }
);

router.post(
  "/api/product-master/:id/signals",
  async (req, res) => {
    try {
      await ensureSchema();

      const allowedSignals =
        new Set([
          "SELLS_FAST",
          "SELLS_SLOW",
          "CUSTOMER_REQUEST",
          "RESTOCK",
          "TRANSFER",
          "TIKTOK_EFFECT",
          "CUSTOMER_FAVORITE",
          "TEST_PRODUCT",
          "NOTE",
        ]);

      const signalType =
        String(
          req.body?.signalType ??
            "NOTE"
        )
          .trim()
          .toUpperCase();

      if (
        !allowedSignals.has(
          signalType
        )
      ) {
        res.status(400).json({
          ok: false,
          error:
            "Ungültiges Produktsignal.",
        });
        return;
      }

      const storeId =
        typeof req.body
          ?.storeId ===
        "string"
          ? req.body.storeId
              .trim()
              .toLowerCase()
          : null;

      const note =
        typeof req.body?.note ===
        "string"
          ? req.body.note.trim()
          : null;

      await db.query(
        `
          INSERT INTO
            product_signals (
              product_id,
              store_id,
              signal_type,
              note,
              created_by
            )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5
          )
        `,
        [
          req.params.id,
          storeId,
          signalType,
          note,
          req.body
            ?.createdBy ??
            "ALO STAFF",
        ]
      );

      res.json({
        ok: true,
        signals:
          await getProductSignals(
            req.params.id
          ),
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Signal konnte nicht gespeichert werden.",
      });
    }
  }
);


function aloText(value: unknown) {
  if (value === null || value === undefined) {
    return "";
  }

  return String(value).trim();
}

function aloJoin(
  values: unknown[],
  separator = " / "
) {
  return values
    .map(aloText)
    .filter(Boolean)
    .join(separator);
}

function buildShopifyProductMetafields(
  draft: any
) {
  const nutrition =
    draft?.nutritionPer100 ?? {};

  const allergens =
    Array.isArray(draft?.allergens)
      ? draft.allergens
          .map(aloText)
          .filter(Boolean)
      : [];

  const traces =
    Array.isArray(draft?.traces)
      ? draft.traces
          .map(aloText)
          .filter(Boolean)
      : [];

  let allergenText =
    allergens.join(", ");

  if (traces.length) {
    allergenText +=
      `${allergenText ? "\n" : ""}Kann Spuren enthalten: ${traces.join(", ")}`;
  }

  const energy =
    aloJoin([
      nutrition.energyKj,
      nutrition.energyKcal,
    ]);

  const pointsRaw =
    Number(
      draft?.commerce
        ?.pointsMultiplier ??
      draft?.pointsMultiplier ??
      1
    );

  const pointsMultiplier =
    Number.isFinite(pointsRaw) &&
    pointsRaw >= 1
      ? Math.round(pointsRaw)
      : 1;

  const metafields = [
    {
      namespace: "custom",
      key: "herkunft",
      type: "single_line_text_field",
      value: aloText(
        draft?.country
      ),
    },
    {
      namespace: "custom",
      key: "inhalt",
      type: "single_line_text_field",
      value:
        aloText(draft?.unitSize) ||
        aloText(draft?.netWeight),
    },
    {
      namespace: "custom",
      key: "geschmack",
      type: "single_line_text_field",
      value: aloText(
        draft?.flavor
      ),
    },
    {
      namespace: "custom",
      key: "energie",
      type: "single_line_text_field",
      value: energy,
    },
    {
      namespace: "custom",
      key: "fett",
      type: "single_line_text_field",
      value: aloText(
        nutrition.fat
      ),
    },
    {
      namespace: "custom",
      key: "gesaettigte_fettsaeuren",
      type: "single_line_text_field",
      value: aloText(
        nutrition.saturatedFat
      ),
    },
    {
      namespace: "custom",
      key: "kohlenhydrate",
      type: "single_line_text_field",
      value: aloText(
        nutrition.carbohydrates
      ),
    },
    {
      namespace: "custom",
      key: "zucker",
      type: "single_line_text_field",
      value: aloText(
        nutrition.sugars
      ),
    },
    {
      namespace: "custom",
      key: "eiweiss",
      type: "single_line_text_field",
      value: aloText(
        nutrition.protein
      ),
    },
    {
      namespace: "custom",
      key: "salz",
      type: "single_line_text_field",
      value: aloText(
        nutrition.salt
      ),
    },
    {
      namespace: "custom",
      key: "nahrungsfasern",
      type: "single_line_text_field",
      value:
        aloText(nutrition.fiber) ||
        aloText(nutrition.fibre),
    },
    {
      namespace: "custom",
      key: "zutaten",
      type: "multi_line_text_field",
      value: aloText(
        draft?.ingredients
      ),
    },
    {
      namespace: "custom",
      key: "allergene",
      type: "multi_line_text_field",
      value: allergenText,
    },
    {
      namespace: "custom",
      key: "servierempfehlung",
      type: "multi_line_text_field",
      value: aloText(
        draft?.servingRecommendation
      ),
    },
    {
      namespace: "custom",
      key: "typ",
      type: "single_line_text_field",
      value:
        aloText(draft?.productType) ||
        aloText(draft?.category),
    },
    {
      namespace: "rewards",
      key: "points_multiplier",
      type: "number_integer",
      value: String(
        pointsMultiplier
      ),
    },
  ];

  return metafields.filter(
    (field) =>
      field.namespace === "rewards" ||
      field.value.trim().length > 0
  );
}

router.post(
  "/api/product-master/:id/shopify-draft",
  async (req, res) => {
    try {
      await ensureSchema();

      const row =
        await getProduct(
          req.params.id
        );

      if (!row) {
        res.status(404).json({
          ok: false,
          error:
            "Produkt nicht gefunden.",
        });
        return;
      }

      if (
        row.shopify_product_id
      ) {
        res.json({
          ok: true,
          alreadyExists: true,
          shopifyProductId:
            row.shopify_product_id,
          shopifyVariantId:
            row.shopify_variant_id,
          status:
            row.shopify_status,
        });
        return;
      }

      const draft =
        row.product_data ?? {};

      const productInput: any = {
        title:
          String(
            row.title
          ).toUpperCase(),
        status: "DRAFT",
      };

      if (
        draft.descriptionHtml
      ) {
        productInput.descriptionHtml =
          draft.descriptionHtml;
      }

      if (draft.vendor) {
        productInput.vendor =
          draft.vendor;
      } else if (draft.brand) {
        productInput.vendor =
          draft.brand;
      }

      if (
        draft.productType
      ) {
        productInput.productType =
          draft.productType;
      } else if (
        draft.category
      ) {
        productInput.productType =
          draft.category;
      }

      if (
        Array.isArray(
          draft.tags
        )
      ) {
        productInput.tags =
          draft.tags;
      }

      if (
        draft.seoTitle ||
        draft.seoDescription
      ) {
        productInput.seo = {};

        if (
          draft.seoTitle
        ) {
          productInput.seo.title =
            draft.seoTitle;
        }

        if (
          draft.seoDescription
        ) {
          productInput.seo.description =
            draft.seoDescription;
        }
      }

      const productMetafields =
        buildShopifyProductMetafields(
          draft
        );

      if (
        productMetafields.length
      ) {
        productInput.metafields =
          productMetafields;
      }

      const stagedImage =
        await stageProductImage(
          req.params.id
        );

      const media =
        stagedImage
          ? [
              {
                originalSource:
                  stagedImage.source,
                alt:
                  draft.title ||
                  row.title,
                mediaContentType:
                  "IMAGE",
              },
            ]
          : [];

      const created =
        await shopifyGraphql(
          `
            mutation AloCreateProduct(
              $product: ProductCreateInput!,
              $media: [CreateMediaInput!]
            ) {
              productCreate(
                product: $product,
                media: $media
              ) {
                product {
                  id
                  title
                  status

                  variants(first: 1) {
                    nodes {
                      id

                      inventoryItem {
                        id
                      }
                    }
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
            product:
              productInput,
            media,
          }
        );

      const payload =
        created?.productCreate;

      if (
        payload?.userErrors
          ?.length
      ) {
        throw new Error(
          payload.userErrors
            .map(
              (error: any) =>
                error.message
            )
            .join(" · ")
        );
      }

      const product =
        payload?.product;

      if (!product?.id) {
        throw new Error(
          "Shopify Produkt-ID fehlt."
        );
      }

      const variant =
        product.variants
          ?.nodes?.[0];

      if (variant?.id) {
        const variantInput: any = {
          id: variant.id,
        };

        const barcode =
          normalizeBarcode(
            row.barcode
          );

        if (barcode) {
          variantInput.barcode =
            barcode;
        }

        const possiblePrice =
          Number(
            draft?.commerce
              ?.sellingPrice ??
              draft?.sellingPrice ??
              NaN
          );

        if (
          Number.isFinite(
            possiblePrice
          ) &&
          possiblePrice > 0
        ) {
          variantInput.price =
            possiblePrice.toFixed(
              2
            );
        }

        const variantUpdate =
          await shopifyGraphql(
            `
              mutation AloUpdateVariant(
                $productId: ID!,
                $variants:
                  [ProductVariantsBulkInput!]!
              ) {
                productVariantsBulkUpdate(
                  productId:
                    $productId,
                  variants:
                    $variants
                ) {
                  productVariants {
                    id
                    barcode
                    price

                    inventoryItem {
                      id
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
              productId:
                product.id,
              variants: [
                variantInput,
              ],
            }
          );

        const errors =
          variantUpdate
            ?.productVariantsBulkUpdate
            ?.userErrors;

        if (
          errors?.length
        ) {
          throw new Error(
            errors
              .map(
                (error: any) =>
                  error.message
              )
              .join(" · ")
          );
        }
      }

      await db.query(
        `
          UPDATE products
          SET
            shopify_status =
              'DRAFT',
            shopify_product_id =
              $2,
            shopify_variant_id =
              $3,
            shopify_inventory_item_id =
              $4,
            updated_at =
              NOW()
          WHERE id = $1
        `,
        [
          req.params.id,
          product.id,
          variant?.id ?? null,
          variant?.inventoryItem
            ?.id ?? null,
        ]
      );

      res.json({
        ok: true,
        shopifyProductId:
          product.id,
        shopifyVariantId:
          variant?.id ?? null,
        status: "DRAFT",
        imageUploaded:
          Boolean(
            stagedImage
          ),
      });
    } catch (error) {
      console.error(
        "Shopify product draft error:",
        error
      );

      res.status(500).json({
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Shopify Draft konnte nicht erstellt werden.",
      });
    }
  }
);

export default router;

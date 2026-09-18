import {
  getShopifyOnlineInventory,
  setShopifyOnlineInventory,
} from "../services/shopifyInventory.service.js";
import {
  normalizeAloSeoDescription,
  normalizeAloSeoTitle,
} from "../utils/aloSeo.js";

import {
  getStaffUser,
  requireStaffAuth,
} from "../middleware/staffAuth.js";

import { Router } from "express";
import multer from "multer";
import { removeBackgroundIsolated } from "../services/backgroundRemoval.service.js";
import sharp from "sharp";
import OpenAI, { toFile } from "openai";
import axios from "axios";

import { db } from "../database/db.js";
import { env } from "../config/env.js";
import {
  getShopifyAccessToken,
} from "../integrations/shopify/auth.js";
import {
  resolveProductIdentity,
} from "../services/productIdentity.service.js";
import {
  createShopifyProductDraft,
  ShopifyProductDraftConflictError,
} from "../services/shopifyProductDraft.service.js";
import {
  buildShopifyCatalogPreview,
  importShopifyCatalogBatch,
  importShopifyProductToProductMaster,
} from "../services/shopifyCatalog.service.js";

const router = Router();

const productStudioOpenAI = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

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
        archived_at TIMESTAMPTZ
    `);

    await db.query(`
      ALTER TABLE products
      ADD COLUMN IF NOT EXISTS
        archived_reason TEXT
    `);

    await db.query(`
      ALTER TABLE products
      ADD COLUMN IF NOT EXISTS
        archived_barcode TEXT
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

/*
 * Synchronisiert das aktuelle primäre
 * Product-Master-Bild zu einem bereits
 * verknüpften Shopify-Produkt.
 *
 * Sicherheitsprinzip:
 * 1. vorhandene Medien lesen
 * 2. neues Bild hochladen
 * 3. neues Bild an Position 0 verschieben
 * 4. vorheriges Hauptbild löschen
 *
 * Andere Galerie-Bilder bleiben erhalten.
 */
async function syncPrimaryProductImageToShopify(
  productId: string,
  shopifyProductId: string
): Promise<{
  synced: boolean;
  mediaId: string | null;
}> {
  const stagedImage =
    await stageProductImage(productId);

  if (!stagedImage) {
    return {
      synced: false,
      mediaId: null,
    };
  }

  const existingData =
    await shopifyGraphql(
      `
        query AloProductMedia(
          $id: ID!
        ) {
          product(id: $id) {
            id
            media(first: 50) {
              nodes {
                id
                mediaContentType
              }
            }
          }
        }
      `,
      {
        id: shopifyProductId,
      }
    );

  const existingMedia =
    Array.isArray(
      existingData?.product?.media?.nodes
    )
      ? existingData.product.media.nodes
      : [];

  const previousPrimaryImageId =
    existingMedia.find(
      (media: any) =>
        media?.mediaContentType ===
        "IMAGE"
    )?.id ?? null;

  const createData =
    await shopifyGraphql(
      `
        mutation AloCreateProductMedia(
          $productId: ID!,
          $media: [CreateMediaInput!]!
        ) {
          productCreateMedia(
            productId: $productId,
            media: $media
          ) {
            media {
              id
              mediaContentType
              status
            }

            mediaUserErrors {
              field
              message
            }
          }
        }
      `,
      {
        productId:
          shopifyProductId,
        media: [
          {
            originalSource:
              stagedImage.source,
            alt:
              stagedImage.alt,
            mediaContentType:
              "IMAGE",
          },
        ],
      }
    );

  const createPayload =
    createData?.productCreateMedia;

  if (
    createPayload
      ?.mediaUserErrors
      ?.length
  ) {
    throw new Error(
      createPayload.mediaUserErrors
        .map(
          (error: any) =>
            error.message
        )
        .join(" · ")
    );
  }

  const newMediaId =
    createPayload?.media?.[0]?.id ??
    null;

  if (!newMediaId) {
    throw new Error(
      "Shopify hat keine neue Media-ID zurückgegeben."
    );
  }

  /*
   * Neues ALO-Bild wird Hauptbild.
   * Reorder läuft bei Shopify asynchron,
   * aber die Mutation selbst wird geprüft.
   */
  const reorderData =
    await shopifyGraphql(
      `
        mutation AloReorderProductMedia(
          $id: ID!,
          $moves: [MoveInput!]!
        ) {
          productReorderMedia(
            id: $id,
            moves: $moves
          ) {
            job {
              id
            }

            mediaUserErrors {
              field
              message
            }
          }
        }
      `,
      {
        id:
          shopifyProductId,
        moves: [
          {
            id:
              newMediaId,
            newPosition:
              "0",
          },
        ],
      }
    );

  const reorderPayload =
    reorderData
      ?.productReorderMedia;

  if (
    reorderPayload
      ?.mediaUserErrors
      ?.length
  ) {
    throw new Error(
      reorderPayload.mediaUserErrors
        .map(
          (error: any) =>
            error.message
        )
        .join(" · ")
    );
  }

  /*
   * Nur das bisherige erste IMAGE
   * entfernen.
   *
   * Andere Galerie-/Lifestyle-Bilder
   * bleiben erhalten.
   */
  if (
    previousPrimaryImageId &&
    previousPrimaryImageId !==
      newMediaId
  ) {
    const deleteData =
      await shopifyGraphql(
        `
          mutation AloDeleteOldProductMedia(
            $productId: ID!,
            $mediaIds: [ID!]!
          ) {
            productDeleteMedia(
              productId:
                $productId,
              mediaIds:
                $mediaIds
            ) {
              deletedMediaIds

              mediaUserErrors {
                field
                message
              }
            }
          }
        `,
        {
          productId:
            shopifyProductId,
          mediaIds: [
            previousPrimaryImageId,
          ],
        }
      );

    const deletePayload =
      deleteData
        ?.productDeleteMedia;

    if (
      deletePayload
        ?.mediaUserErrors
        ?.length
    ) {
      throw new Error(
        deletePayload.mediaUserErrors
          .map(
            (error: any) =>
              error.message
          )
          .join(" · ")
      );
    }
  }

  return {
    synced: true,
    mediaId:
      newMediaId,
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

            /*
             * EAN ist die primäre Produkt-Identität.
             *
             * Bei zwei oder mehreren gleichzeitigen Staff-Requests
             * gewinnt der erste INSERT.
             *
             * Weitere Requests mit derselben EAN bekommen durch
             * RETURNING dieselbe bestehende Product-Master-ID zurück,
             * dürfen dessen bereits gespeicherte Produktdaten aber
             * NICHT mit einem zweiten AI-Draft überschreiben.
             *
             * Die self-assignment UPDATE-Operation ist absichtlich
             * minimal. Sie erlaubt ein atomisches RETURNING des
             * bereits vorhandenen Datensatzes.
             */
            ON CONFLICT (barcode)
            DO UPDATE SET
              barcode =
                products.barcode

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

router.put(
  "/api/product-master/:id",
  async (req, res) => {
    try {
      await ensureSchema();

      const productId =
        String(req.params.id || "").trim();

      const existingResult =
        await db.query(
          `
            SELECT
              id,
              barcode,
              title,
              product_data,
              source_type,
              review_status,
              archived_at,
              shopify_status,
              shopify_product_id,
              shopify_variant_id,
              shopify_inventory_item_id,
              updated_at
            FROM products
            WHERE id = $1
            LIMIT 1
          `,
          [productId]
        );

      const existing =
        existingResult.rows[0];

      if (!existing) {
        res.status(404).json({
          ok: false,
          error: "Produkt nicht gefunden.",
        });
        return;
      }

      /*
       * Schutz vor veralteten Staff-Screens:
       * Ein bereits archiviertes Produkt darf nicht
       * über einen noch offenen Editor verändert werden.
       */
      if (existing.archived_at) {
        res.status(409).json({
          ok: false,
          code: "PRODUCT_ARCHIVED",
          error:
            "Dieses Produkt wurde bereits archiviert. Bitte die Produktliste neu laden.",
        });
        return;
      }

      const draft =
        req.body?.draft ??
        req.body ??
        {};

      const title =
        String(
          draft.title ??
          existing.title ??
          ""
        )
          .trim()
          .toUpperCase();

      if (!title) {
        res.status(400).json({
          ok: false,
          error: "Produkttitel fehlt.",
        });
        return;
      }

      /*
       * EAN-Semantik:
       *
       * - barcode fehlt im Draft:
       *   bestehenden Barcode behalten
       *
       * - barcode ist null / leer:
       *   Barcode bewusst entfernen
       *
       * - barcode enthält einen Wert:
       *   normalisieren und übernehmen
       */
      const hasBarcodeField =
        Object.prototype.hasOwnProperty.call(
          draft,
          "barcode"
        );

      const barcode =
        hasBarcodeField
          ? normalizeBarcode(
              draft.barcode
            ) || null
          : normalizeBarcode(
              existing.barcode
            ) || null;

      if (barcode) {
        const duplicate =
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
              productId,
            ]
          );

        if (duplicate.rows.length) {
          res.status(409).json({
            ok: false,
            error:
              "Diese EAN ist bereits einem anderen Produkt zugeordnet.",
          });
          return;
        }
      }

      function mergeProductDataSafely(
        current: any,
        incoming: any
      ): any {
        if (
          incoming === undefined ||
          incoming === null
        ) {
          return current;
        }

        if (
          typeof incoming === "string" &&
          !incoming.trim()
        ) {
          return current;
        }

        if (Array.isArray(incoming)) {
          return incoming.length
            ? incoming
            : current;
        }

        if (
          typeof incoming === "object" &&
          !Array.isArray(incoming)
        ) {
          const base =
            current &&
            typeof current === "object" &&
            !Array.isArray(current)
              ? current
              : {};

          const result: any = {
            ...base,
          };

          for (
            const [key, value]
            of Object.entries(incoming)
          ) {
            result[key] =
              mergeProductDataSafely(
                base[key],
                value
              );
          }

          return result;
        }

        return incoming;
      }

      /*
       * barcode ist hier bereits der endgültige gewünschte
       * Product-Master-Wert.
       *
       * Wichtig: NULL darf NICHT wieder auf existing.barcode
       * zurückfallen, da NULL ein bewusstes Entfernen der EAN
       * darstellen kann.
       */
      const safeBarcode =
        barcode;

      const mergedData =
        mergeProductDataSafely(
          existing.product_data ?? {},
          draft ?? {}
        );

      mergedData.barcode =
        safeBarcode;

      mergedData.title =
        title ||
        existing.title;

      const reviewedBy =
        String(
          req.body?.reviewedBy ??
          "ALO STAFF"
        );

      const result =
        await db.query(
          `
            UPDATE products
            SET
              barcode = $2,
              title = $3,
              product_data = $4::jsonb,
              review_status = 'REVIEWED',
              reviewed_by = $5,
              reviewed_at = NOW(),
              updated_at = NOW()
            WHERE id = $1
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
            productId,
            safeBarcode,
            title || existing.title,
            JSON.stringify(mergedData),
            reviewedBy,
          ]
        );

      const row =
        result.rows[0];

      const [
        stock,
        signals,
      ] = await Promise.all([
        getProductStock(productId),
        getProductSignals(productId),
      ]);

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
      /*
       * Race-Schutz für parallele Staff-Geräte:
       *
       * Zwei Requests können theoretisch gleichzeitig dieselbe
       * neue EAN prüfen und beide die SELECT-Vorprüfung bestehen.
       *
       * Die DB-Unique-Constraint ist deshalb die letzte
       * verbindliche Instanz. PostgreSQL 23505 wird sauber als
       * fachlicher 409-Konflikt an die App zurückgegeben.
       */
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as any).code === "23505"
      ) {
        res.status(409).json({
          ok: false,
          code: "BARCODE_ALREADY_ASSIGNED",
          error:
            "Diese EAN ist bereits einem anderen Produkt zugeordnet.",
        });
        return;
      }

      console.error(
        "Product Master update error:",
        error
      );

      res.status(500).json({
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Produkt konnte nicht aktualisiert werden.",
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
  "/api/product-master/:id",
  async (req, res) => {
    try {
      await ensureSchema();

      const productId =
        String(req.params.id || "").trim();

      if (!productId) {
        res.status(400).json({
          ok: false,
          error: "Product Master ID fehlt.",
        });
        return;
      }

      const row =
        await getProduct(productId);

      if (!row) {
        res.status(404).json({
          ok: false,
          error: "Produkt nicht gefunden.",
        });
        return;
      }

      const [stock, signals] =
        await Promise.all([
          getProductStock(productId),
          getProductSignals(productId),
        ]);

      res.json({
        ok: true,
        found: true,
        product: toApiProduct(
          row,
          stock,
          signals
        ),
      });
    } catch (error) {
      console.error(
        "Product Master get by id error:",
        error
      );

      res.status(500).json({
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Produkt konnte nicht geladen werden.",
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
          WHERE archived_at IS NULL
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


/*
 * ============================================================
 * ALO PRODUCT STUDIO V1
 * ============================================================
 *
 * Normales Mitarbeiter-Foto -> professionelles Shopbild.
 *
 * AI ist nur die optische Aufbereitung.
 * Das reale Produktfoto bleibt die verbindliche Referenz.
 */

router.post(
  "/api/product-image/studio",
  imageUpload.single("image"),
  async (req, res) => {
    try {
      const file = req.file;

      if (!file) {
        res.status(400).json({
          ok: false,
          error: "Produktfoto fehlt.",
        });
        return;
      }

      const title =
        typeof req.body?.title === "string"
          ? req.body.title.trim()
          : "";

      const brand =
        typeof req.body?.brand === "string"
          ? req.body.brand.trim()
          : "";

      const barcode =
        typeof req.body?.barcode === "string"
          ? req.body.barcode.trim()
          : "";

      const identity = [
        title
          ? `Produkt: ${title}`
          : null,
        brand
          ? `Marke: ${brand}`
          : null,
        barcode
          ? `EAN: ${barcode}`
          : null,
      ]
        .filter(Boolean)
        .join("\n");

      const sourceImage =
        await toFile(
          file.buffer,
          file.originalname ||
            "alo-product-front.png",
          {
            type:
              file.mimetype ||
              "image/png",
          }
        );

      const result: any =
        await productStudioOpenAI.images.edit({
          model: "gpt-image-2",

          image: sourceImage,

          prompt: `
ALO KIOSK PRODUCT STUDIO

Bearbeite das hochgeladene reale Produktfoto zu einem
hochwertigen professionellen E-Commerce-Produktfotografie-Bild.

PRODUKTIDENTITÄT:
${identity || "Die sichtbare Verpackung ist die verbindliche Identität."}

ABSOLUTE REGELN:

Das hochgeladene Produkt ist die verbindliche visuelle Referenz.

Es muss exakt dieselbe reale Produktvariante bleiben.

NICHT verändern oder neu erfinden:
- Marke
- Logo
- Produktname
- Geschmacksrichtung
- Sorte
- Verpackungsdesign
- Farben
- sichtbare Grafiken
- Gewichts- oder Volumenangaben
- sichtbare Produkttexte
- EAN / Barcode
- Claims auf der Verpackung

Keine andere Produktvariante erzeugen.

Keine zusätzlichen:
- Lebensmittel
- Früchte
- Chips
- Bonbons
- Getränke
- Gegenstände
- Dekorationen
- Hände
- Hintergründe
hinzufügen.

ERLAUBTE VERBESSERUNGEN:

- professionelle Studio-Ausleuchtung
- bessere Belichtung
- bessere Klarheit
- saubere natürliche Kontraste
- störende Farbstiche korrigieren
- leichte glaubwürdige Perspektivkorrektur
- Produkt sauber frontal präsentieren
- Verpackung vollständig sichtbar
- hochwertige Materialdarstellung
- Produkt mittig darstellen
- Produkt groß und präsent darstellen
- saubere Kanten

Die Verpackung darf NICHT künstlich neu gestaltet werden.

Wenn eine optische Verbesserung sichtbare Produktinformationen
verändern könnte, behalte das Originaldetail unverändert.

HINTERGRUND:
vollständig transparent.

KEIN Bodenschatten außerhalb des Produktes.

ZIEL:
Ein einheitliches Premium-Produktfotografie-Bild für den
ALO Kiosk Online-Shop, als wäre das echte Produkt professionell
im Studio fotografiert worden.
          `.trim(),

          size: "1024x1024",
          quality: "high",
          background: "transparent",
          output_format: "png",
        });

      const encoded =
        result?.data?.[0]?.b64_json;

      if (
        typeof encoded !== "string" ||
        !encoded
      ) {
        throw new Error(
          "Product Studio hat kein Bild zurückgegeben."
        );
      }

      const generated =
        Buffer.from(
          encoded,
          "base64"
        );

      /*
       * ALO IMAGE STANDARD
       *
       * Das AI-Bild wird nochmals technisch normalisiert.
       * Dadurch sind ALLE Produktbilder gleich aufgebaut.
       */

      const trimmed =
        await sharp(generated)
          .trim({
            background: {
              r: 0,
              g: 0,
              b: 0,
              alpha: 0,
            },
          })
          .png()
          .toBuffer();

      const output =
        await sharp(trimmed)
          .resize({
            width: 1040,
            height: 1040,
            fit: "contain",
            position: "centre",
            background: {
              r: 0,
              g: 0,
              b: 0,
              alpha: 0,
            },
            withoutEnlargement: false,
          })
          .extend({
            top: 80,
            bottom: 80,
            left: 80,
            right: 80,
            background: {
              r: 0,
              g: 0,
              b: 0,
              alpha: 0,
            },
          })
          .png({
            compressionLevel: 9,
          })
          .toBuffer();

      res.setHeader(
        "Content-Type",
        "image/png"
      );

      res.setHeader(
        "Cache-Control",
        "no-store"
      );

      res.setHeader(
        "X-ALO-Image-Mode",
        "product-studio"
      );

      res.send(output);
    } catch (error) {
      console.error(
        "ALO Product Studio error:",
        error
      );

      res.status(500).json({
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Product Studio fehlgeschlagen.",
      });
    }
  }
);

/*
 * ALO PRODUCT IMAGE -> SHOPIFY
 * ============================================================
 *
 * Das Bild liegt zuerst dauerhaft in product_images.
 *
 * Wenn das ALO Produkt bereits mit Shopify verbunden ist,
 * wird genau dieses gespeicherte Bild anschließend über den
 * vorhandenen stageProductImage()-Workflow zu Shopify
 * übertragen.
 *
 * Neue Produkte:
 * - haben beim ersten Bild-Upload noch keine Shopify-ID
 * - shopify-draft übernimmt das gespeicherte Bild später
 *
 * Bestehende Produkte:
 * - bekommen das neue Staff/AI-Produktbild automatisch
 *   auch in Shopify
 */
async function syncStoredProductImageToShopify(
  productId: string,
  shopifyProductId: string,
  alt: string
): Promise<boolean> {
  const stagedImage =
    await stageProductImage(productId);

  if (!stagedImage) {
    return false;
  }

  const response =
    await shopifyGraphql(
      `
        mutation AloSyncStoredProductImage(
          $product: ProductUpdateInput!,
          $media: [CreateMediaInput!]
        ) {
          productUpdate(
            product: $product,
            media: $media
          ) {
            product {
              id
            }

            userErrors {
              field
              message
            }
          }
        }
      `,
      {
        product: {
          id: shopifyProductId,
        },
        media: [
          {
            originalSource:
              stagedImage.source,
            alt:
              alt ||
              "ALO Produkt",
            mediaContentType:
              "IMAGE",
          },
        ],
      }
    );

  const payload =
    response?.productUpdate;

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

  if (!payload?.product?.id) {
    throw new Error(
      "Shopify hat nach dem Bild-Upload kein Produkt zurückgegeben."
    );
  }

  return true;
}


router.post(
  "/api/product-image/remove-background",
  imageUpload.single("image"),
  async (_req, res) => {
    /*
     * IMPORTANT:
     * Background removal is intentionally disabled inside the
     * main ALO API process.
     *
     * The ML model previously caused the Railway container to
     * exceed its memory limit and kill the complete API.
     *
     * The Staff App already falls back to the original image,
     * so product creation/editing remains fully usable.
     *
     * Background removal can later be moved into its own worker
     * or dedicated service without risking the main platform.
     */
    res.status(503).json({
      ok: false,
      error: "BACKGROUND_REMOVAL_TEMPORARILY_DISABLED",
      message:
        "Automatische Bildfreistellung ist momentan deaktiviert. Das Originalbild wird verwendet.",
    });
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

      /*
       * Bild ist jetzt garantiert in ALO CORE gespeichert.
       *
       * Falls dieses Produkt bereits eine Shopify-ID besitzt,
       * übertragen wir das neue Bild ebenfalls automatisch.
       *
       * Ein Shopify-Fehler löscht NIEMALS das zuvor erfolgreich
       * gespeicherte ALO-Bild.
       */
      let shopifyImageSynced =
        false;

      let shopifyImageError:
        string | null =
          null;

      if (
        product.shopify_product_id
      ) {
        try {
          shopifyImageSynced =
            await syncStoredProductImageToShopify(
              productId,
              String(
                product.shopify_product_id
              ),
              String(
                product.title ||
                "ALO Produkt"
              )
            );
        } catch (error) {
          shopifyImageError =
            error instanceof Error
              ? error.message
              : "Shopify Bild-Sync fehlgeschlagen.";

          console.error(
            "[ALO PRODUCT IMAGE SHOPIFY SYNC]",
            {
              productId,
              shopifyProductId:
                product.shopify_product_id,
              error:
                shopifyImageError,
            }
          );
        }
      }

      res.json({
        ok: true,
        storedInAlo: true,
        imageSaved: true,
        shopifyConnected:
          Boolean(
            product.shopify_product_id
          ),
        shopifyImageSynced,
        shopifyImageError,
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



// ============================================================
// PRODUCT MASTER - SHOPIFY ONLINE INVENTORY
// ============================================================

router.get(
  "/api/product-master/:id/online-stock",
  async (req, res) => {
    try {
      await ensureSchema();

      const productId =
        String(
          req.params.id ?? ""
        ).trim();

      const result =
        await db.query(
          `
            SELECT
              id,
              title,
              shopify_product_id,
              shopify_variant_id,
              shopify_inventory_item_id
            FROM products
            WHERE id = $1
            LIMIT 1
          `,
          [productId]
        );

      const product =
        result.rows[0];

      if (!product) {
        res.status(404).json({
          ok: false,
          error:
            "Produkt nicht gefunden.",
        });

        return;
      }

      const inventoryItemId =
        String(
          product
            .shopify_inventory_item_id ??
          ""
        ).trim();

      if (!inventoryItemId) {
        res.status(409).json({
          ok: false,
          error:
            "Produkt ist noch nicht mit einem Shopify Inventory Item verbunden.",
        });

        return;
      }

      const inventory =
        await getShopifyOnlineInventory({
          inventoryItemId,
        });

      res.json({
        ok: true,

        onlineStock: {
          productId:
            String(product.id),

          title:
            String(
              product.title ?? ""
            ),

          locationId:
            inventory.locationId,

          locationName:
            inventory.locationName,

          inventoryItemId:
            inventory.inventoryItemId,

          tracked:
            inventory.tracked,

          active:
            inventory.active,

          quantity:
            inventory.quantity,

          synced: true,
        },
      });
    } catch (error) {
      console.error(
        "Product Master online stock GET error:",
        error
      );

      res.status(500).json({
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Online-Bestand konnte nicht geladen werden.",
      });
    }
  }
);

router.put(
  "/api/product-master/:id/online-stock",
  async (req, res) => {
    try {
      await ensureSchema();

      const productId =
        String(
          req.params.id ?? ""
        ).trim();

      const quantity =
        Number(
          req.body?.quantity
        );

      if (
        !Number.isInteger(
          quantity
        ) ||
        quantity < 0
      ) {
        res.status(400).json({
          ok: false,
          error:
            "Online-Bestand muss eine ganze Zahl ab 0 sein.",
        });

        return;
      }

      const result =
        await db.query(
          `
            SELECT
              id,
              title,
              shopify_product_id,
              shopify_variant_id,
              shopify_inventory_item_id
            FROM products
            WHERE id = $1
            LIMIT 1
          `,
          [productId]
        );

      const product =
        result.rows[0];

      if (!product) {
        res.status(404).json({
          ok: false,
          error:
            "Produkt nicht gefunden.",
        });

        return;
      }

      const inventoryItemId =
        String(
          product
            .shopify_inventory_item_id ??
          ""
        ).trim();

      if (!inventoryItemId) {
        res.status(409).json({
          ok: false,
          error:
            "Produkt ist noch nicht mit einem Shopify Inventory Item verbunden.",
        });

        return;
      }

      await setShopifyOnlineInventory({
        inventoryItemId,

        quantity,

        reference:
          `product-master-${productId}-${Date.now()}`,
      });

      /*
       * Direkt wieder aus Shopify lesen.
       * So bestätigt die API nicht nur den gewünschten,
       * sondern den tatsächlich gespeicherten Bestand.
       */
      const inventory =
        await getShopifyOnlineInventory({
          inventoryItemId,
        });

      res.json({
        ok: true,

        onlineStock: {
          productId:
            String(product.id),

          title:
            String(
              product.title ?? ""
            ),

          locationId:
            inventory.locationId,

          locationName:
            inventory.locationName,

          inventoryItemId:
            inventory.inventoryItemId,

          tracked:
            inventory.tracked,

          active:
            inventory.active,

          quantity:
            inventory.quantity,

          synced: true,
        },
      });
    } catch (error) {
      console.error(
        "Product Master online stock PUT error:",
        error
      );

      res.status(500).json({
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Online-Bestand konnte nicht gespeichert werden.",
      });
    }
  }
);

router.post(
  "/api/product-master/:id/archive",
  async (req, res) => {
    try {
      await ensureSchema();

      const productId =
        String(
          req.params.id ?? ""
        ).trim();

      const reason =
        String(
          req.body?.reason ??
            "FALSCHES_PRODUKT"
        )
          .trim()
          .slice(0, 120);

      if (!productId) {
        res.status(400).json({
          ok: false,
          error:
            "Product ID fehlt.",
        });
        return;
      }

      const existing =
        await db.query(
          `
            SELECT
              id,
              barcode,
              archived_barcode,
              archived_at,
              shopify_product_id
            FROM products
            WHERE id = $1
            LIMIT 1
          `,
          [
            productId,
          ]
        );

      const row =
        existing.rows[0];

      if (!row) {
        res.status(404).json({
          ok: false,
          error:
            "Produkt nicht gefunden.",
        });
        return;
      }

      /*
       * Idempotent:
       * Ein bereits archiviertes Produkt kann gefahrlos
       * noch einmal archiviert werden.
       */
      if (row.archived_at) {
        res.json({
          ok: true,
          alreadyArchived: true,
          productId:
            String(row.id),
          archivedBarcode:
            row.archived_barcode ??
            null,
          shopifyProductId:
            row.shopify_product_id ??
            null,
          shopifyUntouched: true,
        });
        return;
      }

      const result =
        await db.query(
          `
            UPDATE products
            SET
              archived_barcode =
                COALESCE(
                  archived_barcode,
                  barcode
                ),
              barcode = NULL,
              archived_at = NOW(),
              archived_reason = $2,
              review_status = 'ARCHIVED',
              updated_at = NOW()
            WHERE id = $1
            RETURNING
              id,
              archived_barcode,
              archived_at,
              archived_reason,
              shopify_product_id
          `,
          [
            productId,
            reason ||
              "FALSCHES_PRODUKT",
          ]
        );

      const archived =
        result.rows[0];

      res.json({
        ok: true,
        archived: true,
        productId:
          String(archived.id),
        archivedBarcode:
          archived.archived_barcode ??
          null,
        archivedAt:
          archived.archived_at ??
          null,
        reason:
          archived.archived_reason ??
          null,
        shopifyProductId:
          archived.shopify_product_id ??
          null,

        /*
         * Absichtlich:
         * Archivieren in ALO darf nicht automatisch ein
         * echtes Shopify-Produkt zerstören.
         */
        shopifyUntouched: true,
      });
    } catch (error) {
      console.error(
        "Product archive error:",
        error
      );

      res.status(500).json({
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Produkt konnte nicht archiviert werden.",
      });
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


/*
 * ============================================================
 * ALO STAFF – SAFE INVENTORY COUNT
 * ============================================================
 *
 * Zentraler, authentifizierter Zähl-Endpunkt für ALO STAFF.
 *
 * Wichtig:
 * - Mitarbeiteridentität kommt ausschließlich aus Staff Auth.
 * - updatedBy wird NICHT aus dem Request akzeptiert.
 * - Menge muss eine ganze Zahl >= 0 sein.
 * - Workspace muss für den Mitarbeiter freigegeben sein.
 * - Dieser Endpoint verändert Shopify NICHT.
 * - Damit werden insbesondere keine anderen Shopify Locations
 *   deaktiviert oder verändert.
 */
router.put(
  "/api/product-master/:id/inventory-count",
  requireStaffAuth,
  async (req, res) => {
    try {
      await ensureSchema();

      const staffUser = getStaffUser(res);

      const productId = String(req.params.id);

      const workspaceRaw =
        typeof req.body?.workspace === "string"
          ? req.body.workspace.trim().toUpperCase()
          : "";

      const workspaceMap: Record<string, string> = {
        AARAU: "aarau",
        OLTEN: "olten",
        ONLINE: "online",
      };

      const storeId = workspaceMap[workspaceRaw];

      if (!storeId) {
        res.status(400).json({
          ok: false,
          error: "Ungültiger Arbeitsbereich.",
        });
        return;
      }

      if (
        !staffUser.allowedWorkspaces.includes(
          workspaceRaw as "AARAU" | "OLTEN" | "ONLINE"
        )
      ) {
        res.status(403).json({
          ok: false,
          error: "Kein Zugriff auf diesen Arbeitsbereich.",
        });
        return;
      }

      const quantity = Number(req.body?.quantity);

      if (
        !Number.isInteger(quantity) ||
        quantity < 0
      ) {
        res.status(400).json({
          ok: false,
          error:
            "Bestand muss eine ganze Zahl ab 0 sein.",
        });
        return;
      }

      const productResult = await db.query(
        `
          SELECT
            id,
            barcode,
            title
          FROM products
          WHERE id = $1
          LIMIT 1
        `,
        [productId]
      );

      if (productResult.rows.length === 0) {
        res.status(404).json({
          ok: false,
          error: "Produkt nicht gefunden.",
        });
        return;
      }

      const product = productResult.rows[0];

      const stockLevel =
        quantity === 0
          ? "empty"
          : quantity <= 2
            ? "almost_empty"
            : quantity <= 5
              ? "low"
              : quantity <= 10
                ? "medium"
                : "full";

      await db.query("BEGIN");

      try {
        await db.query(
          `
            INSERT INTO product_stock_snapshots (
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
              NULL,
              $5,
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
              note = NULL,
              updated_by =
                EXCLUDED.updated_by,
              updated_at = NOW()
          `,
          [
            productId,
            storeId,
            quantity,
            stockLevel,
            staffUser.displayName,
          ]
        );

        await db.query(
          `
            INSERT INTO staff_activity (
              staff_user_id,
              workspace,
              action,
              entity_type,
              entity_id,
              metadata,
              created_at
            )
            VALUES (
              $1,
              $2,
              'INVENTORY_COUNT',
              'PRODUCT',
              $3,
              $4::jsonb,
              NOW()
            )
          `,
          [
            staffUser.id,
            workspaceRaw,
            productId,
            JSON.stringify({
              quantity,
              stockLevel,
              barcode: product.barcode ?? null,
              title: product.title ?? null,
            }),
          ]
        );

        await db.query("COMMIT");
      } catch (error) {
        await db.query("ROLLBACK");
        throw error;
      }

      res.json({
        ok: true,
        count: {
          productId: productId,
          barcode: product.barcode ?? null,
          title: product.title ?? null,
          workspace: workspaceRaw,
          storeId,
          quantity,
          stockLevel,
          countedBy: {
            id: staffUser.id,
            displayName: staffUser.displayName,
            role: staffUser.role,
          },
        },
        stock: await getProductStock(
          productId
        ),
      });
    } catch (error) {
      console.error(
        "STAFF INVENTORY COUNT ERROR",
        error
      );

      res.status(500).json({
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Bestand konnte nicht gezählt werden.",
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
  "/api/product-ops/shopify/import-all",
  async (req, res) => {
    try {
      await ensureSchema();

      const rawLimit = req.query.limit;

      let limit: number | undefined;

      if (
        typeof rawLimit === "string" &&
        rawLimit.trim()
      ) {
        const parsed =
          Number(rawLimit);

        if (
          !Number.isInteger(parsed) ||
          parsed < 1 ||
          parsed > 500
        ) {
          res.status(400).json({
            ok: false,
            error:
              "limit muss eine ganze Zahl zwischen 1 und 500 sein.",
          });
          return;
        }

        limit = parsed;
      }

      const rawConfirm =
        req.query.confirm;

      const confirmedImportAll =
        typeof rawConfirm === "string" &&
        rawConfirm === "IMPORT_ALL";

      if (
        limit === undefined &&
        !confirmedImportAll
      ) {
        res.status(400).json({
          ok: false,
          error:
            "Vollständiger Shopify-Import blockiert. Nutze limit=1..500 oder confirm=IMPORT_ALL.",
        });
        return;
      }

      const before =
        await buildShopifyCatalogPreview();

      const result =
        await importShopifyCatalogBatch(
          limit
        );

      const after =
        await buildShopifyCatalogPreview();

      res.json({
        ok: result.failed === 0,
        limit: limit ?? null,
        attempted: result.attempted,
        imported: result.imported,
        alreadyLinked:
          result.alreadyLinked,
        linkedExisting:
          result.linkedExisting,
        failed: result.failed,
        before: before.summary,
        after: after.summary,
        failures: result.failures,
        results: result.results,
      });
    } catch (error) {
      console.error(
        "Shopify bulk import error:",
        error
      );

      res.status(500).json({
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Shopify-Katalog konnte nicht importiert werden.",
      });
    }
  }
);

router.post(
  "/api/product-ops/shopify/import-one",
  async (req, res) => {
    try {
      await ensureSchema();

      const shopifyProductId =
        typeof req.body?.shopifyProductId === "string"
          ? req.body.shopifyProductId.trim()
          : "";

      if (!shopifyProductId) {
        res.status(400).json({
          ok: false,
          error: "Shopify Product ID fehlt.",
        });
        return;
      }

      const result =
        await importShopifyProductToProductMaster(
          shopifyProductId
        );

      res.json({
        ok: true,
        ...result,
      });
    } catch (error) {
      console.error(
        "Shopify single product import error:",
        error
      );

      res.status(500).json({
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Shopify-Produkt konnte nicht importiert werden.",
      });
    }
  }
);

router.get(
  "/api/product-ops/shopify/catalog-preview",
  async (_req, res) => {
    try {
      await ensureSchema();

      const preview =
        await buildShopifyCatalogPreview();

      res.json({
        ok: true,
        readOnly: true,
        ...preview,
      });
    } catch (error) {
      console.error(
        "Shopify catalog preview error:",
        error
      );

      res.status(500).json({
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Shopify-Katalog konnte nicht geprüft werden.",
      });
    }
  }
);



type AloPackagingType =
  | "snack_bag"
  | "wrapper"
  | "plastic_bag"
  | "cardboard_box"
  | "aluminum_can"
  | "pet_bottle"
  | "glass_bottle"
  | "plastic_cup"
  | "jar"
  | "other";

function parseAloAmount(
  value: unknown
): {
  amount: number;
  unit: "g" | "kg" | "ml" | "l";
} | null {
  if (
    typeof value !== "string" &&
    typeof value !== "number"
  ) {
    return null;
  }

  const raw =
    String(value)
      .trim()
      .toLowerCase()
      .replace(",", ".");

  const match =
    raw.match(
      /(\d+(?:\.\d+)?)\s*(kg|g|ml|l)\b/
    );

  if (!match) {
    return null;
  }

  const amount =
    Number(match[1]);

  if (
    !Number.isFinite(amount) ||
    amount <= 0
  ) {
    return null;
  }

  return {
    amount,
    unit:
      match[2] as
        | "g"
        | "kg"
        | "ml"
        | "l",
  };
}

function inferAloPackagingType(
  draft: any
): AloPackagingType {
  const text =
    [
      draft?.title,
      draft?.productName,
      draft?.category,
      draft?.subcategory,
      draft?.productType,
      draft?.packagingType,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

  if (
    /glasflasche|glass bottle/.test(
      text
    )
  ) {
    return "glass_bottle";
  }

  if (
    /pet[- ]?flasche|pet bottle|plastic bottle|kunststoffflasche/.test(
      text
    )
  ) {
    return "pet_bottle";
  }

  if (
    /dose|can|energy drink|softdrink|soft drink/.test(
      text
    )
  ) {
    return "aluminum_can";
  }

  if (
    /jar|glasbehälter|glasbehaelter/.test(
      text
    )
  ) {
    return "jar";
  }

  if (
    /becher|cup/.test(
      text
    )
  ) {
    return "plastic_cup";
  }

  if (
    /box|schachtel|karton/.test(
      text
    )
  ) {
    return "cardboard_box";
  }

  if (
    /riegel|bar|wrapper/.test(
      text
    )
  ) {
    return "wrapper";
  }

  if (
    /chips|takis|crisps|snack/.test(
      text
    )
  ) {
    return "snack_bag";
  }

  if (
    /bonbon|candy|gummy|gummies|sweets/.test(
      text
    )
  ) {
    return "plastic_bag";
  }

  return "other";
}

function getAloPackagingTareGrams(
  type: AloPackagingType,
  contentGrams: number
): number {
  switch (type) {
    case "wrapper":
      return 3;

    case "snack_bag":
      return contentGrams <= 150
        ? 7
        : 10;

    case "plastic_bag":
      return contentGrams <= 250
        ? 6
        : 10;

    case "cardboard_box":
      return contentGrams <= 250
        ? 18
        : 30;

    case "aluminum_can":
      return 16;

    case "pet_bottle":
      return contentGrams <= 600
        ? 25
        : 40;

    case "glass_bottle":
      return contentGrams <= 600
        ? 250
        : 400;

    case "plastic_cup":
      return 15;

    case "jar":
      return 180;

    default:
      return Math.max(
        5,
        Math.min(
          25,
          Math.round(
            contentGrams * 0.03
          )
        )
      );
  }
}

function calculateAloShippingWeightGrams(
  draft: any
): number | null {
  /*
   * Falls später ein echtes verifiziertes Bruttogewicht
   * vorhanden ist, hat dieses immer Vorrang.
   */

  const gross =
    parseAloAmount(
      draft?.grossWeight ??
      draft?.shippingWeight
    );

  if (
    gross &&
    (
      gross.unit === "g" ||
      gross.unit === "kg"
    )
  ) {
    return Math.round(
      gross.unit === "kg"
        ? gross.amount * 1000
        : gross.amount
    );
  }

  /*
   * netWeight ist bevorzugt.
   * unitSize ist Fallback.
   */

  const amount =
    parseAloAmount(
      draft?.netWeight ??
      draft?.unitSize
    );

  if (!amount) {
    return null;
  }

  let contentGrams: number;

  if (amount.unit === "kg") {
    contentGrams =
      amount.amount * 1000;
  } else if (
    amount.unit === "g"
  ) {
    contentGrams =
      amount.amount;
  } else if (
    amount.unit === "l"
  ) {
    /*
     * Versand-Schätzung für typische Getränke.
     * NICHT als Produkt-Nettogewicht speichern.
     */
    contentGrams =
      amount.amount * 1000;
  } else {
    /*
     * ml -> ungefähre Versandmasse typischer
     * wasserbasierter Getränke.
     */
    contentGrams =
      amount.amount;
  }

  const packagingType =
    inferAloPackagingType(
      draft
    );

  const packagingGrams =
    getAloPackagingTareGrams(
      packagingType,
      contentGrams
    );

  return Math.ceil(
    contentGrams +
    packagingGrams
  );
}

function parseShippingWeightGrams(
  value: unknown
): number | null {
  if (
    typeof value !== "string" &&
    typeof value !== "number"
  ) {
    return null;
  }

  const raw = String(value)
    .trim()
    .toLowerCase()
    .replace(",", ".");

  if (!raw) {
    return null;
  }

  const match = raw.match(
    /^(\d+(?:\.\d+)?)\s*(g|kg)$/
  );

  if (!match) {
    return null;
  }

  const amount = Number(match[1]);

  if (
    !Number.isFinite(amount) ||
    amount <= 0
  ) {
    return null;
  }

  const grams =
    match[2] === "kg"
      ? amount * 1000
      : amount;

  return Math.round(grams * 1000) / 1000;
}


type AloCanonicalCollection = {
  id: string;
  handle: string;
  title: string;
};

const ALO_CANONICAL_COLLECTIONS = {
  drinks: {
    id: "gid://shopify/Collection/299715133524",
    handle: "drinks",
    title: "DRINKS",
  },
  eistee: {
    id: "gid://shopify/Collection/301935001684",
    handle: "eistee",
    title: "EISTEE",
  },
  durstloscher: {
    id: "gid://shopify/Collection/303819653204",
    handle: "durstloscher",
    title: "Durstlöscher",
  },
  softdrinks: {
    id: "gid://shopify/Collection/301934215252",
    handle: "softdrinks-schweiz",
    title: "SOFTDRINKS",
  },
  limonade: {
    id: "gid://shopify/Collection/301934608468",
    handle: "limonade",
    title: "LIMONADE",
  },
  energy: {
    id: "gid://shopify/Collection/301934575700",
    handle: "energy-drinks",
    title: "Alle Energy Drinks",
  },
  snacks: {
    id: "gid://shopify/Collection/299715985492",
    handle: "snacks-1",
    title: "SNACKS",
  },
  sweets: {
    id: "gid://shopify/Collection/299716247636",
    handle: "sweets-candys",
    title: "SWEETS",
  },
  chocolate: {
    id: "gid://shopify/Collection/301720633428",
    handle: "chocolate",
    title: "CHOCOLATE",
  },
  cookies: {
    id: "gid://shopify/Collection/266208772180",
    handle: "cookies",
    title: "Cookies",
  },
  chips: {
    id: "gid://shopify/Collection/301956235348",
    handle: "chips",
    title: "CHIPS",
  },
  riegel: {
    id: "gid://shopify/Collection/266208673876",
    handle: "riegel",
    title: "Riegel",
  },
} satisfies Record<string, AloCanonicalCollection>;

function normalizeAloTaxonomyText(
  value: unknown
): string {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ß/g, "ss")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function resolveAloCanonicalCollections(
  draft: any,
  fallbackTitle?: unknown
): AloCanonicalCollection[] {
  const category =
    normalizeAloTaxonomyText(
      draft?.category
    );

  const subcategory =
    normalizeAloTaxonomyText(
      draft?.subcategory
    );

  const productType =
    normalizeAloTaxonomyText(
      draft?.productType
    );

  const brand =
    normalizeAloTaxonomyText(
      draft?.brand ??
      draft?.vendor
    );

  const title =
    normalizeAloTaxonomyText(
      draft?.title ??
      draft?.productName ??
      fallbackTitle
    );

  const tags = Array.isArray(draft?.tags)
    ? draft.tags
        .map(normalizeAloTaxonomyText)
        .join(" ")
    : normalizeAloTaxonomyText(
        draft?.tags
      );

  const text = [
    category,
    subcategory,
    productType,
    brand,
    title,
    tags,
  ]
    .filter(Boolean)
    .join(" ");

  const result =
    new Map<
      string,
      AloCanonicalCollection
    >();

  const add = (
    collection:
      AloCanonicalCollection
  ) => {
    result.set(
      collection.id,
      collection
    );
  };

  const isDrink =
    /\bdrinks?\b/.test(category) ||
    /\bgetranke\b/.test(category) ||
    /\bsoftdrinks?\b/.test(category) ||
    /\bdrink\b/.test(productType) ||
    /\bgetrank\b/.test(productType) ||
    /\berfrischungsgetrank/.test(text) ||
    /\blimonade\b/.test(text) ||
    /\beistee\b/.test(text) ||
    /\benergy drinks?\b/.test(text) ||
    /\bmate\b/.test(text) ||
    brand === "durstloscher";

  if (isDrink) {
    add(
      ALO_CANONICAL_COLLECTIONS.drinks
    );
  }

  if (
    isDrink &&
    (
      /\beistee\b/.test(text) ||
      /\bice tea\b/.test(text) ||
      /\biced tea\b/.test(text)
    )
  ) {
    add(
      ALO_CANONICAL_COLLECTIONS.eistee
    );
  }

  if (
    brand === "durstloscher" ||
    /\bdurstloscher\b/.test(title)
  ) {
    add(
      ALO_CANONICAL_COLLECTIONS.drinks
    );

    add(
      ALO_CANONICAL_COLLECTIONS.durstloscher
    );

    if (
      /\beistee\b/.test(text) ||
      /\bice tea\b/.test(text) ||
      /\biced tea\b/.test(text)
    ) {
      add(
        ALO_CANONICAL_COLLECTIONS.eistee
      );
    }
  }

  if (
    isDrink &&
    (
      /\bsoft ?drinks?\b/.test(text) ||
      /\bkohlensaurehaltig/.test(text)
    )
  ) {
    add(
      ALO_CANONICAL_COLLECTIONS.softdrinks
    );
  }

  if (
    isDrink &&
    /\blimonade\b/.test(text)
  ) {
    add(
      ALO_CANONICAL_COLLECTIONS.limonade
    );
  }

  if (
    isDrink &&
    /\benergy drinks?\b/.test(text)
  ) {
    add(
      ALO_CANONICAL_COLLECTIONS.energy
    );
  }

  if (
    /\bsnacks?\b/.test(category) ||
    /\bsnacks?\b/.test(productType)
  ) {
    add(
      ALO_CANONICAL_COLLECTIONS.snacks
    );
  }

  if (
    /\bsweets?\b/.test(category) ||
    /\bsussigkeiten\b/.test(category) ||
    /\bsusswaren\b/.test(category)
  ) {
    add(
      ALO_CANONICAL_COLLECTIONS.sweets
    );
  }

  if (
    /\bchocolate\b/.test(category) ||
    /\bschokolade\b/.test(category)
  ) {
    add(
      ALO_CANONICAL_COLLECTIONS.chocolate
    );
  }

  if (
    /\bcookies?\b/.test(text) ||
    /\bkekse?\b/.test(text)
  ) {
    add(
      ALO_CANONICAL_COLLECTIONS.cookies
    );
  }

  if (
    /\bchips?\b/.test(text) ||
    /\bkartoffelchips\b/.test(text) ||
    /\btortilla chips?\b/.test(text)
  ) {
    add(
      ALO_CANONICAL_COLLECTIONS.snacks
    );

    add(
      ALO_CANONICAL_COLLECTIONS.chips
    );
  }

  if (
    /\briegel\b/.test(text) ||
    /\bbar\b/.test(productType)
  ) {
    add(
      ALO_CANONICAL_COLLECTIONS.riegel
    );
  }

  return [...result.values()];
}

type AloCollectionSyncResult = {
  requested: AloCanonicalCollection[];
  added: AloCanonicalCollection[];
  alreadyMember: AloCanonicalCollection[];
  skipped: Array<{
    collection: AloCanonicalCollection;
    reason: string;
  }>;
};


type AloPublicationSyncResult = {
  status:
    | "available"
    | "permission_missing"
    | "error";
  publications: Array<{
    id: string;
    name: string;
  }>;
  warning?: string;
};

let aloPublicationAccessCache:
  {
    expiresAt: number;
    result: AloPublicationSyncResult;
  } | null = null;

const ALO_PUBLICATION_ACCESS_CACHE_MS =
  10 * 60 * 1000;

async function inspectAloPublicationAccess():
  Promise<AloPublicationSyncResult> {
  const now =
    Date.now();

  if (
    aloPublicationAccessCache &&
    aloPublicationAccessCache.expiresAt >
      now
  ) {
    return {
      ...aloPublicationAccessCache.result,
      publications:
        aloPublicationAccessCache.result
          .publications
          .map(
            (publication) => ({
              ...publication,
            })
          ),
    };
  }
  try {
    const data =
      await shopifyGraphql(
        `
          query AloPublicationCapability {
            publications(first: 50) {
              nodes {
                id
                name
              }
            }
          }
        `,
        {}
      );

    const publications =
      (
        data
          ?.publications
          ?.nodes ?? []
      )
        .map((publication: any) => ({
          id:
            String(
              publication?.id ?? ""
            ),
          name:
            String(
              publication?.name ?? ""
            ),
        }))
        .filter(
          (publication: {
            id: string;
            name: string;
          }) =>
            Boolean(
              publication.id
            )
        );

    const result:
      AloPublicationSyncResult = {
        status: "available",
        publications,
      };

    aloPublicationAccessCache = {
      expiresAt:
        now +
        ALO_PUBLICATION_ACCESS_CACHE_MS,
      result,
    };

    return result;
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : String(error);

    const normalized =
      message.toLowerCase();

    if (
      normalized.includes(
        "read_publications"
      ) ||
      (
        normalized.includes(
          "access denied"
        ) &&
        normalized.includes(
          "publication"
        )
      )
    ) {
      const result:
        AloPublicationSyncResult = {
          status:
            "permission_missing",
          publications: [],
          warning:
            "Shopify Publication-Zugriff fehlt. Produkt- und Collection-Sync wurden trotzdem erfolgreich ausgeführt.",
        };

      aloPublicationAccessCache = {
        expiresAt:
          now +
          ALO_PUBLICATION_ACCESS_CACHE_MS,
        result,
      };

      return result;
    }

    return {
      status: "error",
      publications: [],
      warning:
        message ||
        "Publication-Status konnte nicht geprüft werden.",
    };
  }
}


async function publishAloProductToAllPublications(
  shopifyProductId: string
): Promise<AloPublicationSyncResult> {
  const access =
    await inspectAloPublicationAccess();

  if (
    access.status !== "available" ||
    !access.publications.length
  ) {
    return access;
  }

  try {
    const data =
      await shopifyGraphql(
        `
          mutation AloPublishProductEverywhere(
            $id: ID!,
            $input: [PublicationInput!]!
          ) {
            publishablePublish(
              id: $id,
              input: $input
            ) {
              userErrors {
                field
                message
              }
            }
          }
        `,
        {
          id: shopifyProductId,
          input:
            access.publications.map(
              (publication) => ({
                publicationId:
                  publication.id,
              })
            ),
        }
      );

    const errors =
      data
        ?.publishablePublish
        ?.userErrors ?? [];

    if (errors.length) {
      return {
        status: "error",
        publications:
          access.publications,
        warning:
          errors
            .map(
              (error: any) =>
                error.message
            )
            .join(" · "),
      };
    }

    return {
      status: "available",
      publications:
        access.publications,
    };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : String(error);

    const normalized =
      message.toLowerCase();

    if (
      normalized.includes(
        "write_publications"
      ) ||
      (
        normalized.includes(
          "access denied"
        ) &&
        normalized.includes(
          "publication"
        )
      )
    ) {
      return {
        status:
          "permission_missing",
        publications:
          access.publications,
        warning:
          "Shopify write_publications fehlt. Produkt ist ACTIVE, konnte aber nicht automatisch auf alle Vertriebskanäle veröffentlicht werden.",
      };
    }

    return {
      status: "error",
      publications:
        access.publications,
      warning:
        message ||
        "Vertriebskanäle konnten nicht synchronisiert werden.",
    };
  }
}


async function syncAloCanonicalCollections(
  shopifyProductId: string,
  collections: AloCanonicalCollection[]
): Promise<AloCollectionSyncResult> {
  const uniqueCollections =
    [...new Map(
      collections.map((collection) => [
        collection.id,
        collection,
      ])
    ).values()];

  const result: AloCollectionSyncResult = {
    requested: uniqueCollections,
    added: [],
    alreadyMember: [],
    skipped: [],
  };

  if (!uniqueCollections.length) {
    return result;
  }

  for (
    const collection
    of uniqueCollections
  ) {
    try {
      /*
       * Shopify 2026-07:
       * Produkte werden nicht mehr direkt über
       * collectionAddProducts gepflegt.
       *
       * Wir brauchen den Conditions-Source der
       * jeweiligen Collection.
       */
      const collectionData =
        await shopifyGraphql(
          `
            query AloCollectionSource(
              $id: ID!
            ) {
              collection(id: $id) {
                id
                title

                sources {
                  __typename
                  id
                  title

                  ... on CollectionConditionsSource {
                    targetType
                    shareable

                    inclusion {
                      selections(
                        first: 250
                      ) {
                        nodes {
                          product {
                            id
                          }

                          variantIds
                        }
                      }
                    }
                  }
                }
              }
            }
          `,
          {
            id:
              collection.id,
          }
        );

      const shopifyCollection =
        collectionData
          ?.collection;

      if (
        !shopifyCollection?.id
      ) {
        result.skipped.push({
          collection,
          reason:
            "Collection wurde in Shopify nicht gefunden.",
        });

        continue;
      }

      const sources =
        Array.isArray(
          shopifyCollection.sources
        )
          ? shopifyCollection.sources
          : [];

      const conditionSource =
        sources.find(
          (source: any) =>
            source
              ?.__typename ===
              "CollectionConditionsSource" &&
            (
              !source.targetType ||
              source.targetType ===
                "PRODUCTS"
            )
        );

      if (
        !conditionSource?.id
      ) {
        result.skipped.push({
          collection,
          reason:
            "Keine beschreibbare Product-Collection-Source gefunden.",
        });

        continue;
      }

      const existingSelections =
        conditionSource
          ?.inclusion
          ?.selections
          ?.nodes ?? [];

      const alreadySelected =
        existingSelections.some(
          (selection: any) =>
            selection
              ?.product
              ?.id ===
            shopifyProductId
        );

      if (
        alreadySelected
      ) {
        result.alreadyMember.push(
          collection
        );

        continue;
      }

      const updateData =
        await shopifyGraphql(
          `
            mutation AloAddProductToCollection(
              $collection:
                CollectionUpdateInput!
            ) {
              collectionUpdate(
                collection: $collection
              ) {
                collection {
                  id
                  title
                }

                userErrors {
                  field
                  message
                }
              }
            }
          `,
          {
            collection: {
              id:
                collection.id,

              sourcesToUpdate: [
                {
                  condition: {
                    id:
                      conditionSource.id,

                    inclusion: {
                      selectionsToAdd: [
                        {
                          productId:
                            shopifyProductId,
                        },
                      ],
                    },
                  },
                },
              ],
            },
          }
        );

      const payload =
        updateData
          ?.collectionUpdate;

      const errors =
        payload
          ?.userErrors ?? [];

      if (
        errors.length
      ) {
        result.skipped.push({
          collection,
          reason:
            errors
              .map(
                (error: any) =>
                  error?.message
              )
              .filter(Boolean)
              .join(" · ") ||
            "Unbekannter Shopify Collection-Fehler.",
        });

        continue;
      }

      result.added.push(
        collection
      );
    } catch (error) {
      result.skipped.push({
        collection,
        reason:
          error instanceof Error
            ? error.message
            : String(error),
      });
    }
  }

  return result;
}

router.post(
  "/api/product-master/:id/sync-to-shopify",
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
        !row.shopify_product_id
      ) {
        res.status(409).json({
          ok: false,
          code:
            "SHOPIFY_NOT_LINKED",
          error:
            "Produkt ist noch nicht mit Shopify verknüpft.",
        });
        return;
      }

      const linkedProductCheck =
        await shopifyGraphql(
          `
            query AloLinkedProductCheck(
              $id: ID!
            ) {
              product(id: $id) {
                id
                title
                status
              }
            }
          `,
          {
            id:
              row.shopify_product_id,
          }
        );

      if (
        !linkedProductCheck?.product
      ) {
        const existingProductData =
          row.product_data ?? {};

        const existingShopifyData =
          existingProductData?.shopify ??
          {};

        const orphanedShopifyData = {
          ...existingShopifyData,
          productId:
            row.shopify_product_id,
          variantId:
            row.shopify_variant_id ??
            existingShopifyData.variantId ??
            null,
          linkState:
            "ORPHANED",
          linkError:
            "Shopify product does not exist",
          checkedAt:
            new Date().toISOString(),
        };

        await db.query(
          `
            UPDATE products
            SET
              shopify_status = $2,
              product_data =
                COALESCE(
                  product_data,
                  '{}'::jsonb
                )
                || jsonb_build_object(
                  'shopify',
                  $3::jsonb
                ),
              updated_at = NOW()
            WHERE id = $1
          `,
          [
            req.params.id,
            "ORPHANED",
            JSON.stringify(
              orphanedShopifyData
            ),
          ]
        );

        res.status(409).json({
          ok: false,
          code:
            "SHOPIFY_PRODUCT_MISSING",
          productId:
            req.params.id,
          shopifyProductId:
            row.shopify_product_id,
          shopifyVariantId:
            row.shopify_variant_id ??
            null,
          status:
            "ORPHANED",
          recoverable:
            true,
          error:
            "Die gespeicherte Shopify-Verknüpfung ist verwaist: Das Shopify-Produkt existiert nicht mehr.",
        });

        return;
      }

      const draft =
        row.product_data ?? {};

      const productInput: any = {
        id:
          row.shopify_product_id,
        title:
          String(
            draft.title ??
            row.title
          )
            .trim()
            .toUpperCase(),
      };

      if (
        draft.descriptionHtml !==
        undefined
      ) {
        productInput.descriptionHtml =
          String(
            draft.descriptionHtml ??
            ""
          );
      }

      const vendor =
        aloText(
          draft.brand
        ) ??
        aloText(
          draft.vendor
        );

      if (vendor) {
        productInput.vendor =
          vendor;
      }

      const productType =
        draft.productType ??
        draft.category;

      if (
        productType !== undefined
      ) {
        productInput.productType =
          String(
            productType ?? ""
          );
      }

      if (
        Array.isArray(
          draft.tags
        )
      ) {
        productInput.tags =
          draft.tags
            .map((tag: unknown) =>
              String(tag).trim()
            )
            .filter(Boolean);
      }

      const seoTitle =
        normalizeAloSeoTitle(
          draft.seoTitle,
          draft.title ??
            row.title
        );

      const seoDescription =
        normalizeAloSeoDescription(
          draft.seoDescription,
          draft.title ??
            row.title
        );

      productInput.seo = {
        title: seoTitle,
        description:
          seoDescription,
      };

      const metafields =
        buildShopifyProductMetafields(
          draft
        );

      if (metafields.length) {
        productInput.metafields =
          metafields;
      }

      const updated =
        await shopifyGraphql(
          `
            mutation AloSyncProduct(
              $product: ProductUpdateInput!
            ) {
              productUpdate(
                product: $product
              ) {
                product {
                  id
                  title
                  status
                  vendor
                  productType
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
          }
        );

      const productPayload =
        updated?.productUpdate;

      if (
        productPayload?.userErrors
          ?.length
      ) {
        throw new Error(
          productPayload.userErrors
            .map(
              (error: any) =>
                error.message
            )
            .join(" · ")
        );
      }

      const shopifyProduct =
        productPayload?.product;

      if (
        !shopifyProduct?.id
      ) {
        throw new Error(
          "Shopify hat kein aktualisiertes Produkt zurückgegeben."
        );
      }

      let variant:
        | {
            id: string;
            barcode?: string | null;
            price?: string | null;
            inventoryItem?: {
              id?: string | null;
            } | null;
          }
        | undefined;

      const shippingWeightGrams =
        calculateAloShippingWeightGrams(
          draft
        );

      if (
        row.shopify_variant_id
      ) {
        const variantInput: any = {
          id:
            row.shopify_variant_id,
        };

        const barcode =
          normalizeBarcode(
            row.barcode
          );

        variantInput.barcode =
          barcode || null;

        if (
          shippingWeightGrams !== null
        ) {
          variantInput.inventoryItem = {
            measurement: {
              weight: {
                value:
                  shippingWeightGrams,
                unit: "GRAMS",
              },
            },
            requiresShipping: true,
          };
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
          possiblePrice >= 0
        ) {
          variantInput.price =
            possiblePrice.toFixed(
              2
            );
        }


        /*
         * ALO SALE PRICING
         *
         * regularPrice bleibt der ursprüngliche Verkaufspreis.
         * sellingPrice ist der aktuell aktive Shopify-Preis.
         *
         * Bei 25/50 % Rabatt bekommt Shopify zusätzlich
         * compareAtPrice, damit der Originalpreis als
         * Streichpreis dargestellt wird.
         *
         * Bei NORMAL wird compareAtPrice explizit auf null
         * gesetzt, damit ein früherer Sale entfernt wird.
         */
        const possibleRegularPrice =
          Number(
            draft?.commerce
              ?.regularPrice ??
            NaN
          );

        const discountPercent =
          Number(
            draft?.commerce
              ?.discountPercent ??
            0
          );

        const hasActiveDiscount =
          (
            discountPercent === 25 ||
            discountPercent === 50
          ) &&
          Number.isFinite(
            possibleRegularPrice
          ) &&
          possibleRegularPrice > 0 &&
          Number.isFinite(
            possiblePrice
          ) &&
          possiblePrice >= 0 &&
          possibleRegularPrice >
            possiblePrice;

        variantInput.compareAtPrice =
          hasActiveDiscount
            ? possibleRegularPrice.toFixed(2)
            : null;

        const variantUpdate =
          await shopifyGraphql(
            `
              mutation AloSyncVariant(
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
                compareAtPrice

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
                row.shopify_product_id,
              variants: [
                variantInput,
              ],
            }
          );

        const variantPayload =
          variantUpdate
            ?.productVariantsBulkUpdate;

        if (
          variantPayload
            ?.userErrors
            ?.length
        ) {
          throw new Error(
            variantPayload.userErrors
              .map(
                (error: any) =>
                  error.message
              )
              .join(" · ")
          );
        }

        variant =
          variantPayload
            ?.productVariants?.[0];
      }

      const finalVariantId =
        variant?.id ??
        row.shopify_variant_id ??
        null;

      const finalInventoryId =
        variant?.inventoryItem?.id ??
        row.shopify_inventory_item_id ??
        null;

      if (
        shippingWeightGrams !== null &&
        finalInventoryId
      ) {
        const inventoryUpdate =
          await shopifyGraphql(
            `
              mutation AloSyncInventoryWeight(
                $id: ID!,
                $input: InventoryItemInput!
              ) {
                inventoryItemUpdate(
                  id: $id,
                  input: $input
                ) {
                  inventoryItem {
                    id

                    measurement {
                      weight {
                        value
                        unit
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
              id: finalInventoryId,
              input: {
                measurement: {
                  weight: {
                    value:
                      shippingWeightGrams,
                    unit: "GRAMS",
                  },
                },
                requiresShipping: true,
              },
            }
          );

        const inventoryPayload =
          inventoryUpdate
            ?.inventoryItemUpdate;

        if (
          inventoryPayload
            ?.userErrors
            ?.length
        ) {
          throw new Error(
            inventoryPayload.userErrors
              .map(
                (error: any) =>
                  error.message
              )
              .join(" · ")
          );
        }
      }

      const canonicalCollections =
        resolveAloCanonicalCollections(
          draft,
          shopifyProduct.title ??
            row.title
        );

      const collectionSync =
        await syncAloCanonicalCollections(
          shopifyProduct.id,
          canonicalCollections
        );

      const publicationSync =
        await inspectAloPublicationAccess();

      const nextShopifyData = {
        ...(
          draft.shopify ??
          {}
        ),
        productId:
          shopifyProduct.id,
        variantId:
          finalVariantId,
        inventoryItemId:
          finalInventoryId,
        status:
          shopifyProduct.status ??
          row.shopify_status,
        originalTitle:
          shopifyProduct.title,
        collections:
          collectionSync.requested.map(
            (collection) => ({
              id: collection.id,
              handle:
                collection.handle,
              title:
                collection.title,
            })
          ),
        collectionSync: {
          added:
            collectionSync.added.map(
              (collection) =>
                collection.handle
            ),
          alreadyMember:
            collectionSync.alreadyMember.map(
              (collection) =>
                collection.handle
            ),
          skipped:
            collectionSync.skipped.map(
              (entry) => ({
                handle:
                  entry.collection.handle,
                reason:
                  entry.reason,
              })
            ),
          syncedAt:
            new Date().toISOString(),
        },
        publicationSync: {
          status:
            publicationSync.status,
          publications:
            publicationSync.publications,
          warning:
            publicationSync.warning ??
            null,
          checkedAt:
            new Date().toISOString(),
        },
      };

      await db.query(
        `
          UPDATE products
          SET
            title = $2,
            shopify_status = $3,
            shopify_variant_id = $4,
            shopify_inventory_item_id = $5,
            product_data =
              COALESCE(
                product_data,
                '{}'::jsonb
              )
              || jsonb_build_object(
                'shopify',
                $6::jsonb
              ),
            updated_at = NOW()
          WHERE id = $1
        `,
        [
          req.params.id,
          String(
            shopifyProduct.title
          ).toUpperCase(),
          shopifyProduct.status ??
            row.shopify_status ??
            "LINKED",
          finalVariantId,
          finalInventoryId,
          JSON.stringify(
            nextShopifyData
          ),
        ]
      );

      res.json({
        ok: true,
        synced: true,
        productId:
          req.params.id,
        shopifyProductId:
          shopifyProduct.id,
        shopifyVariantId:
          finalVariantId,
        title:
          shopifyProduct.title,
        status:
          shopifyProduct.status,
        barcode:
          variant?.barcode ??
          row.barcode ??
          null,
        price:
          variant?.price ??
          null,
        collections: {
          requested:
            collectionSync.requested.map(
              (collection) =>
                collection.handle
            ),
          added:
            collectionSync.added.map(
              (collection) =>
                collection.handle
            ),
          alreadyMember:
            collectionSync.alreadyMember.map(
              (collection) =>
                collection.handle
            ),
          skipped:
            collectionSync.skipped.map(
              (entry) => ({
                handle:
                  entry.collection.handle,
                reason:
                  entry.reason,
              })
            ),
        },
        publication: {
          status:
            publicationSync.status,
          publications:
            publicationSync.publications,
          warning:
            publicationSync.warning ??
            null,
        },
      });
    } catch (error) {
      console.error(
        "Shopify product sync error:",
        error
      );

      res.status(500).json({
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Produkt konnte nicht mit Shopify synchronisiert werden.",
      });
    }
  }
);


// ============================================================
// PRODUCT MASTER - SHOPIFY PRODUCT STATUS
// ACTIVE <-> DRAFT
// ============================================================

router.post(
  "/api/product-master/:id/shopify-status",
  async (req, res) => {
    try {
      await ensureSchema();

      const productId =
        String(
          req.params.id ?? ""
        ).trim();

      const requestedStatus =
        String(
          req.body?.status ?? ""
        )
          .trim()
          .toUpperCase();

      if (
        requestedStatus !== "ACTIVE" &&
        requestedStatus !== "DRAFT"
      ) {
        res.status(400).json({
          ok: false,
          error:
            "Shopify Status muss ACTIVE oder DRAFT sein.",
        });

        return;
      }

      const result =
        await db.query(
          `
            SELECT
              id,
              title,
              shopify_product_id,
              shopify_variant_id,
              shopify_inventory_item_id,
              shopify_status,
              product_data
            FROM products
            WHERE id = $1
            LIMIT 1
          `,
          [productId]
        );

      const row =
        result.rows[0];

      if (!row) {
        res.status(404).json({
          ok: false,
          error:
            "Produkt nicht gefunden.",
        });

        return;
      }

      const rawShopifyProductId =
        String(
          row.shopify_product_id ?? ""
        ).trim();

      if (!rawShopifyProductId) {
        res.status(409).json({
          ok: false,
          error:
            "Produkt ist noch nicht mit Shopify verknüpft.",
        });

        return;
      }

      const shopifyProductId =
        rawShopifyProductId.startsWith(
          "gid://shopify/Product/"
        )
          ? rawShopifyProductId
          : `gid://shopify/Product/${rawShopifyProductId}`;

      const linkedProductCheck =
        await shopifyGraphql(
          `
            query AloStatusLinkedProductCheck(
              $id: ID!
            ) {
              product(id: $id) {
                id
                status
              }
            }
          `,
          {
            id:
              shopifyProductId,
          }
        );

      if (
        !linkedProductCheck?.product?.id
      ) {
        await db.query(
          `
            UPDATE products
            SET
              shopify_status = 'ORPHANED',
              product_data =
                COALESCE(
                  product_data,
                  '{}'::jsonb
                )
                ||
                jsonb_build_object(
                  'shopify',
                  COALESCE(
                    product_data->'shopify',
                    '{}'::jsonb
                  )
                  ||
                  jsonb_build_object(
                    'productId',
                    $2::text,
                    'linkState',
                    'ORPHANED',
                    'linkError',
                    'Shopify product does not exist',
                    'checkedAt',
                    NOW()::text
                  )
                ),
              updated_at = NOW()
            WHERE id = $1
          `,
          [
            productId,
            shopifyProductId,
          ]
        );

        res.status(409).json({
          ok: false,
          code:
            "SHOPIFY_PRODUCT_MISSING",
          productId,
          shopifyProductId,
          status:
            "ORPHANED",
          recoverable: true,
          error:
            "Die gespeicherte Shopify-Verknüpfung ist verwaist: Das Shopify-Produkt existiert nicht mehr.",
        });
        return;
      }

      const data =
        await shopifyGraphql(
          `
            mutation AloSetProductStatus(
              $product: ProductUpdateInput!
            ) {
              productUpdate(
                product: $product
              ) {
                product {
                  id
                  title
                  status
                }

                userErrors {
                  field
                  message
                }
              }
            }
          `,
          {
            product: {
              id:
                shopifyProductId,

              status:
                requestedStatus,
            },
          }
        );

      const payload =
        data?.productUpdate;

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

      const shopifyProduct =
        payload?.product;

      if (!shopifyProduct?.id) {
        throw new Error(
          "Shopify hat das aktualisierte Produkt nicht bestätigt."
        );
      }

      const confirmedStatus =
        String(
          shopifyProduct.status ??
          requestedStatus
        )
          .trim()
          .toUpperCase();

      let activeCollectionSync:
        AloCollectionSyncResult | null =
          null;

      let activePublicationSync:
        AloPublicationSyncResult | null =
          null;

      let activeInventory:
        any = null;

      if (
        confirmedStatus ===
        "ACTIVE"
      ) {
        /*
         * ACTIVE bedeutet bei ALO:
         *
         * 1. Shopify Produkt ACTIVE
         * 2. kanonische Collections synchronisieren
         * 3. auf alle verfügbaren Publications publizieren
         * 4. zentralen Shopify-Bestand verifizieren
         *
         * Die vorhandene Bestandsmenge wird hier
         * NICHT verändert.
         */

        const draft =
          row.product_data ?? {};

        const canonicalCollections =
          resolveAloCanonicalCollections(
            draft,
            shopifyProduct.title ??
              row.title
          );

        activeCollectionSync =
          await syncAloCanonicalCollections(
            shopifyProduct.id,
            canonicalCollections
          );

        activePublicationSync =
          await publishAloProductToAllPublications(
            shopifyProduct.id
          );

        const inventoryItemId =
          String(
            row.shopify_inventory_item_id ??
            draft?.shopify?.inventoryItemId ??
            ""
          ).trim();

        if (inventoryItemId) {
          try {
            activeInventory =
              await getShopifyOnlineInventory({
                inventoryItemId,
              });
          } catch (error) {
            activeInventory = {
              ok: false,
              warning:
                error instanceof Error
                  ? error.message
                  : String(error),
            };
          }
        }
      }

      await db.query(
        `
          UPDATE products
          SET
            shopify_status = $2,

            product_data =
              COALESCE(
                product_data,
                '{}'::jsonb
              )
              ||
              jsonb_build_object(
                'shopify',
                COALESCE(
                  product_data->'shopify',
                  '{}'::jsonb
                )
                ||
                jsonb_build_object(
                  'status',
                  $2::text,
                  'productId',
                  $3::text,
                  'activeSync',
                  $4::jsonb
                )
              ),

            updated_at = NOW()

          WHERE id = $1
        `,
        [
          productId,
          confirmedStatus,
          shopifyProduct.id,
          JSON.stringify({
            collections:
              activeCollectionSync
                ? {
                    requested:
                      activeCollectionSync.requested.map(
                        (collection) =>
                          collection.handle
                      ),
                    added:
                      activeCollectionSync.added.map(
                        (collection) =>
                          collection.handle
                      ),
                    alreadyMember:
                      activeCollectionSync.alreadyMember.map(
                        (collection) =>
                          collection.handle
                      ),
                    skipped:
                      activeCollectionSync.skipped.map(
                        (entry) => ({
                          handle:
                            entry.collection.handle,
                          reason:
                            entry.reason,
                        })
                      ),
                  }
                : null,
            publications:
              activePublicationSync,
            inventory:
              activeInventory,
            syncedAt:
              new Date().toISOString(),
          }),
        ]
      );

      res.json({
        ok: true,

        productId,

        shopifyProductId:
          shopifyProduct.id,

        status:
          confirmedStatus,

        title:
          shopifyProduct.title ??
          row.title ??
          null,

        sync:
          confirmedStatus ===
          "ACTIVE"
            ? {
                collections:
                  activeCollectionSync,
                publications:
                  activePublicationSync,
                inventory:
                  activeInventory,
              }
            : null,
      });
    } catch (error) {
      console.error(
        "Shopify product status error:",
        error
      );

      res.status(500).json({
        ok: false,

        error:
          error instanceof Error
            ? error.message
            : "Shopify Status konnte nicht geändert werden.",
      });
    }
  }
);

router.post(
  "/api/product-master/:id/shopify-draft",
  async (req, res) => {
    try {
      await ensureSchema();

      const result =
        await createShopifyProductDraft(
          req.params.id
        );

      res.json(result);
    } catch (error) {
      console.error(
        "Shopify product draft error:",
        error
      );

      if (
        error instanceof
        ShopifyProductDraftConflictError
      ) {
        res.status(409).json({
          ok: false,
          conflict: true,
          reason:
            error.reason,
          ...(error.details ?? {}),
          error:
            error.message,
        });
        return;
      }

      const message =
        error instanceof Error
          ? error.message
          : "Shopify Draft konnte nicht erstellt werden.";

      res.status(
        message ===
          "Produkt nicht gefunden."
          ? 404
          : 500
      ).json({
        ok: false,
        error: message,
      });
    }
  }
);

export default router;

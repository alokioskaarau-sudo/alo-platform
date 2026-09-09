import { Router } from "express";
import type { PoolClient } from "pg";
import { db } from "../database/db.js";
import {
  resolveProductIdentity,
} from "../services/productIdentity.service.js";
import {
  prepareReceivingNewProduct,
} from "../services/receivingProductPreparation.service.js";

import {
  setShopifyOnlineInventory,
} from "../services/shopifyInventory.service.js";
import {
  automateReceivingProduct,
} from "../services/receivingProductAutomation.service.js";
import {
  rememberSupplierArticle,
  resolveReceivingProductMaster,
} from "../services/receivingProductMatcher.service.js";

const router = Router();

type StoreId =
  | "aarau"
  | "olten"
  | "online";

type ReceivingAllocation = {
  aarau?: number | null;
  olten?: number | null;
  online?: number | null;
};

class ReceivingValidationError extends Error {
  statusCode = 422;

  constructor(message: string) {
    super(message);
    this.name = "ReceivingValidationError";
  }
}

type ReceivingLineInput = {
  product: string;
  barcode?: string | null;
  articleNumber?: string | null;
  quantity: number;
  unit?: string | null;
  cases?: number | null;
  unitsPerCase?: number | null;
  totalUnits?: number | null;
  unitSize?: string | null;
  purchasePrice?: number | null;
  totalPrice?: number | null;
  expiry?: string | null;
  batch?: string | null;
  allocations?: ReceivingAllocation | null;

  /**
   * Explizite Mitarbeiter-Zuordnung aus ALO STAFF.
   *
   * Wird serverseitig validiert und schlägt nur den
   * automatischen Product-Master-Matcher.
   */
  resolution?:
    | "MANUAL_EXISTING"
    | "MANUAL_NEW"
    | null;
  productMasterId?: string | number | null;
};

async function resolveManualProductMaster(
  input: ReceivingLineInput,
  queryable: {
    query: (
      text: string,
      values?: any[]
    ) => Promise<any>;
  },
  position: number
): Promise<any | null> {
  if (
    input.resolution !==
    "MANUAL_EXISTING"
  ) {
    return null;
  }

  const productMasterId =
    String(
      input.productMasterId ?? ""
    ).trim();

  if (
    !productMasterId ||
    !/^\d+$/.test(productMasterId)
  ) {
    throw new ReceivingValidationError(
      `Position ${position}: Für die manuelle Zuordnung fehlt ein gültiger Product Master.`
    );
  }

  const result =
    await queryable.query(
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
      [productMasterId]
    );

  if (!result.rows[0]) {
    throw new ReceivingValidationError(
      `Position ${position}: Product Master ${productMasterId} wurde nicht gefunden.`
    );
  }

  return result.rows[0];
}

function cleanBarcode(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, "").trim();
}

function cleanText(value: unknown): string {
  return String(value ?? "").trim();
}

function numberOrNull(value: unknown): number | null {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed)
    ? parsed
    : null;
}

function resolveReceivedQuantity(
  input: ReceivingLineInput,
  position: number
): number {
  const visibleQuantity =
    numberOrNull(input.quantity);

  const cases =
    numberOrNull(input.cases);

  const unitsPerCase =
    numberOrNull(input.unitsPerCase);

  const totalUnits =
    numberOrNull(input.totalUnits);

  const cleanPositiveInteger = (
    value: number | null
  ): number | null => {
    if (
      value === null ||
      !Number.isFinite(value) ||
      value <= 0 ||
      !Number.isInteger(value)
    ) {
      return null;
    }

    return value;
  };

  const q =
    cleanPositiveInteger(
      visibleQuantity
    );

  const c =
    cleanPositiveInteger(cases);

  const u =
    cleanPositiveInteger(
      unitsPerCase
    );

  const total =
    cleanPositiveInteger(
      totalUnits
    );

  if (
    totalUnits !== null &&
    total === null
  ) {
    throw new ReceivingValidationError(
      `Position ${position}: Gesamtstückzahl ist ungültig.`
    );
  }

  if (
    cases !== null &&
    c === null
  ) {
    throw new ReceivingValidationError(
      `Position ${position}: Kartonanzahl ist ungültig.`
    );
  }

  if (
    unitsPerCase !== null &&
    u === null
  ) {
    throw new ReceivingValidationError(
      `Position ${position}: Stück pro Karton ist ungültig.`
    );
  }

  if (c !== null && u !== null) {
    const calculated =
      c * u;

    if (
      total !== null &&
      total !== calculated
    ) {
      throw new ReceivingValidationError(
        `Position ${position}: Mengen widersprechen sich (${c} × ${u} = ${calculated}, aber Gesamtstückzahl ${total}).`
      );
    }

    return total ?? calculated;
  }

  if (total !== null) {
    return total;
  }

  if (q !== null) {
    return q;
  }

  throw new ReceivingValidationError(
    `Position ${position}: Keine gültige Stückzahl vorhanden.`
  );
}


function looksLikePackagingUnit(
  value: unknown
): boolean {
  const unit = cleanText(value)
    .toLowerCase()
    .replace(/[._-]+/g, " ");

  if (!unit) {
    return false;
  }

  return [
    "karton",
    "carton",
    "case",
    "tray",
    "display",
    "box",
    "kiste",
    "packungseinheit",
  ].some((token) =>
    unit.includes(token)
  );
}

function validateReceivingPackaging(
  input: ReceivingLineInput,
  position: number
): void {
  const cases =
    numberOrNull(input.cases);

  const unitsPerCase =
    numberOrNull(input.unitsPerCase);

  const totalUnits =
    numberOrNull(input.totalUnits);

  if (
    looksLikePackagingUnit(input.unit) &&
    unitsPerCase === null &&
    totalUnits === null
  ) {
    throw new ReceivingValidationError(
      `Position ${position}: Verpackungseinheit "${cleanText(
        input.unit
      )}" erkannt, aber Stück pro Verpackung bzw. Gesamtstückzahl fehlt.`
    );
  }

  if (
    cases !== null &&
    unitsPerCase === null &&
    totalUnits === null
  ) {
    throw new ReceivingValidationError(
      `Position ${position}: ${cases} Verpackungseinheiten erkannt, aber Stück pro Verpackung bzw. Gesamtstückzahl fehlt.`
    );
  }
}

function resolveAllocations(
  input: ReceivingLineInput,
  quantity: number,
  position: number
): Record<StoreId, number> {
  const raw =
    input.allocations &&
    typeof input.allocations === "object"
      ? input.allocations
      : null;

  if (!raw) {
    throw new ReceivingValidationError(
      `Position ${position}: Verteilung auf Aarau, Olten und Online fehlt.`
    );
  }

  const parseAllocation = (
    store: StoreId
  ): number => {
    const value =
      raw[store] === null ||
      raw[store] === undefined
        ? 0
        : Number(raw[store]);

    if (
      !Number.isInteger(value) ||
      value < 0
    ) {
      throw new ReceivingValidationError(
        `Position ${position}: Ungültige Menge für ${store}.`
      );
    }

    return value;
  };

  const allocations: Record<
    StoreId,
    number
  > = {
    aarau: parseAllocation("aarau"),
    olten: parseAllocation("olten"),
    online: parseAllocation("online"),
  };

  const allocated =
    allocations.aarau +
    allocations.olten +
    allocations.online;

  if (allocated !== quantity) {
    throw new ReceivingValidationError(
      `Position ${position}: ${quantity} Stück geliefert, aber ${allocated} Stück verteilt.`
    );
  }

  return allocations;
}

function calculateUnitCost(
  quantity: number,
  purchasePrice: number | null,
  totalPrice: number | null
): number | null {
  if (
    totalPrice !== null &&
    quantity > 0
  ) {
    return Number(
      (totalPrice / quantity).toFixed(4)
    );
  }

  if (purchasePrice !== null) {
    return Number(
      purchasePrice.toFixed(4)
    );
  }

  return null;
}

function stockLevelForQuantity(
  quantity: number
) {
  if (quantity <= 0) {
    return "empty";
  }

  if (quantity <= 3) {
    return "almost_empty";
  }

  if (quantity <= 8) {
    return "low";
  }

  if (quantity <= 20) {
    return "medium";
  }

  return "full";
}

async function ensureReceivingSchema() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS receiving_deliveries (
      id BIGSERIAL PRIMARY KEY,
      store_id TEXT NOT NULL,
      supplier TEXT NOT NULL,
      delivery_note TEXT NOT NULL,
      document_date DATE,
      currency TEXT NOT NULL DEFAULT 'CHF',
      received_by TEXT,
      note TEXT,
      source_type TEXT NOT NULL DEFAULT 'ALO_STAFF',
      status TEXT NOT NULL DEFAULT 'EXPECTED',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(store_id, supplier, delivery_note)
    )
  `);

  await db.query(`
    ALTER TABLE receiving_deliveries
    ADD COLUMN IF NOT EXISTS
      status TEXT NOT NULL DEFAULT 'EXPECTED'
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS receiving_drafts (
      id BIGSERIAL PRIMARY KEY,
      employee_name TEXT,
      supplier TEXT,
      delivery_note TEXT,
      document_date DATE,
      currency TEXT,
      note TEXT,
      status TEXT NOT NULL DEFAULT 'DRAFT',
      draft_data JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS
      receiving_drafts_status_updated_idx
    ON receiving_drafts(
      status,
      updated_at DESC
    )
  `);


  await db.query(`
    CREATE TABLE IF NOT EXISTS receiving_lines (
      id BIGSERIAL PRIMARY KEY,
      delivery_id BIGINT NOT NULL
        REFERENCES receiving_deliveries(id)
        ON DELETE CASCADE,
      product_id BIGINT
        REFERENCES products(id)
        ON DELETE SET NULL,
      product_name TEXT NOT NULL,
      barcode TEXT,
      article_number TEXT,
      quantity INTEGER NOT NULL,
      cases INTEGER,
      units_per_case INTEGER,
      unit_size TEXT,
      unit_purchase_cost NUMERIC(12,4),
      line_total NUMERIC(12,2),
      expiry DATE,
      batch TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS
      receiving_lines_product_idx
    ON receiving_lines(product_id)
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS
      receiving_lines_delivery_idx
    ON receiving_lines(delivery_id)
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS
      receiving_allocations (
        id BIGSERIAL PRIMARY KEY,
        receiving_line_id BIGINT
          NOT NULL
          REFERENCES receiving_lines(id)
          ON DELETE CASCADE,
        store_id TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'EXPECTED',
        accepted_quantity INTEGER NOT NULL DEFAULT 0,
        accepted_at TIMESTAMPTZ,
        accepted_by TEXT,
        shopify_sync_status TEXT NOT NULL DEFAULT 'NOT_REQUIRED',
        shopify_sync_error TEXT,
        shopify_synced_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ
          NOT NULL
          DEFAULT NOW(),
        UNIQUE(
          receiving_line_id,
          store_id
        )
      )
  `);

  await db.query(`
    ALTER TABLE receiving_allocations
    ADD COLUMN IF NOT EXISTS
      status TEXT NOT NULL DEFAULT 'EXPECTED'
  `);

  await db.query(`
    ALTER TABLE receiving_allocations
    ADD COLUMN IF NOT EXISTS
      accepted_quantity INTEGER NOT NULL DEFAULT 0
  `);

  await db.query(`
    ALTER TABLE receiving_allocations
    ADD COLUMN IF NOT EXISTS
      accepted_at TIMESTAMPTZ
  `);

  await db.query(`
    ALTER TABLE receiving_allocations
    ADD COLUMN IF NOT EXISTS
      accepted_by TEXT
  `);

  await db.query(`
    ALTER TABLE receiving_allocations
    ADD COLUMN IF NOT EXISTS
      shopify_sync_status TEXT NOT NULL DEFAULT 'NOT_REQUIRED'
  `);

  await db.query(`
    ALTER TABLE receiving_allocations
    ADD COLUMN IF NOT EXISTS
      shopify_sync_error TEXT
  `);

  await db.query(`
    ALTER TABLE receiving_allocations
    ADD COLUMN IF NOT EXISTS
      shopify_synced_at TIMESTAMPTZ
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS
      receiving_allocations_line_idx
    ON receiving_allocations(
      receiving_line_id,
      store_id
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS stock_movements (
      id BIGSERIAL PRIMARY KEY,
      product_id BIGINT NOT NULL
        REFERENCES products(id)
        ON DELETE CASCADE,
      store_id TEXT NOT NULL,
      movement_type TEXT NOT NULL,
      quantity_delta INTEGER NOT NULL,
      reference_type TEXT,
      reference_id TEXT,
      note TEXT,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS
      stock_movements_product_store_idx
    ON stock_movements(
      product_id,
      store_id,
      created_at DESC
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS product_batches (
      id BIGSERIAL PRIMARY KEY,
      product_id BIGINT NOT NULL
        REFERENCES products(id)
        ON DELETE CASCADE,
      store_id TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      expiry DATE,
      batch TEXT,
      receiving_line_id BIGINT
        REFERENCES receiving_lines(id)
        ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS
      product_batches_product_store_idx
    ON product_batches(
      product_id,
      store_id,
      expiry
    )
  `);
}


/*
 * =========================================================
 * RECEIVING WORK DRAFTS
 *
 * Persistenter Arbeitsstand VOR EXPECTED.
 *
 * Dadurch darf ALO STAFF geschlossen / neu geladen werden,
 * ohne dass eine große Warenannahme verloren geht.
 * =========================================================
 */

router.post(
  "/drafts",
  async (req, res) => {
    try {
      await ensureReceivingSchema();

      const {
        employeeName,
        supplier,
        deliveryNote,
        documentDate,
        currency,
        note,
        data,
      } = req.body ?? {};

      const result = await db.query(
        `
          INSERT INTO receiving_drafts (
            employee_name,
            supplier,
            delivery_note,
            document_date,
            currency,
            note,
            draft_data
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7::jsonb
          )
          RETURNING *
        `,
        [
          cleanText(employeeName) || null,
          cleanText(supplier) || null,
          cleanText(deliveryNote) || null,
          documentDate || null,
          cleanText(currency) || null,
          cleanText(note) || null,
          JSON.stringify(
            data &&
            typeof data === "object"
              ? data
              : {}
          ),
        ]
      );

      const draft = result.rows[0];

      res.json({
        ok: true,
        draft: {
          id: String(draft.id),
          status: draft.status,
          employeeName:
            draft.employee_name,
          supplier: draft.supplier,
          deliveryNote:
            draft.delivery_note,
          documentDate:
            draft.document_date,
          currency: draft.currency,
          note: draft.note,
          data: draft.draft_data,
          createdAt: draft.created_at,
          updatedAt: draft.updated_at,
        },
      });
    } catch (error) {
      console.error(
        "[ALO RECEIVING DRAFT CREATE]",
        error
      );

      res.status(500).json({
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Warenannahme-Draft konnte nicht erstellt werden.",
      });
    }
  }
);


router.get(
  "/drafts",
  async (_req, res) => {
    try {
      await ensureReceivingSchema();

      const result = await db.query(
        `
          SELECT *
          FROM receiving_drafts
          WHERE status = 'DRAFT'
          ORDER BY updated_at DESC
          LIMIT 100
        `
      );

      res.json({
        ok: true,
        count: result.rows.length,
        drafts: result.rows.map(
          (draft: any) => ({
            id: String(draft.id),
            status: draft.status,
            employeeName:
              draft.employee_name,
            supplier: draft.supplier,
            deliveryNote:
              draft.delivery_note,
            documentDate:
              draft.document_date,
            currency: draft.currency,
            note: draft.note,
            data: draft.draft_data,
            createdAt:
              draft.created_at,
            updatedAt:
              draft.updated_at,
          })
        ),
      });
    } catch (error) {
      console.error(
        "[ALO RECEIVING DRAFT LIST]",
        error
      );

      res.status(500).json({
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Warenannahme-Drafts konnten nicht geladen werden.",
      });
    }
  }
);


router.get(
  "/drafts/:draftId",
  async (req, res) => {
    try {
      await ensureReceivingSchema();

      const draftId =
        String(
          req.params.draftId ?? ""
        ).trim();

      if (!/^\d+$/.test(draftId)) {
        res.status(400).json({
          ok: false,
          error: "Ungültige Draft-ID.",
        });
        return;
      }

      const result = await db.query(
        `
          SELECT *
          FROM receiving_drafts
          WHERE id = $1
          LIMIT 1
        `,
        [draftId]
      );

      const draft = result.rows[0];

      if (!draft) {
        res.status(404).json({
          ok: false,
          error:
            "Warenannahme-Draft wurde nicht gefunden.",
        });
        return;
      }

      res.json({
        ok: true,
        draft: {
          id: String(draft.id),
          status: draft.status,
          employeeName:
            draft.employee_name,
          supplier: draft.supplier,
          deliveryNote:
            draft.delivery_note,
          documentDate:
            draft.document_date,
          currency: draft.currency,
          note: draft.note,
          data: draft.draft_data,
          createdAt: draft.created_at,
          updatedAt: draft.updated_at,
        },
      });
    } catch (error) {
      console.error(
        "[ALO RECEIVING DRAFT GET]",
        error
      );

      res.status(500).json({
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Warenannahme-Draft konnte nicht geladen werden.",
      });
    }
  }
);


router.patch(
  "/drafts/:draftId",
  async (req, res) => {
    try {
      await ensureReceivingSchema();

      const draftId =
        String(
          req.params.draftId ?? ""
        ).trim();

      if (!/^\d+$/.test(draftId)) {
        res.status(400).json({
          ok: false,
          error: "Ungültige Draft-ID.",
        });
        return;
      }

      const {
        employeeName,
        supplier,
        deliveryNote,
        documentDate,
        currency,
        note,
        data,
      } = req.body ?? {};

      const result = await db.query(
        `
          UPDATE receiving_drafts
          SET
            employee_name = $2,
            supplier = $3,
            delivery_note = $4,
            document_date = $5,
            currency = $6,
            note = $7,
            draft_data =
              COALESCE(
                draft_data,
                '{}'::jsonb
              ) ||
              $8::jsonb,
            updated_at = NOW()
          WHERE
            id = $1
            AND status = 'DRAFT'
          RETURNING *
        `,
        [
          draftId,
          cleanText(employeeName) || null,
          cleanText(supplier) || null,
          cleanText(deliveryNote) || null,
          documentDate || null,
          cleanText(currency) || null,
          cleanText(note) || null,
          JSON.stringify(
            data &&
            typeof data === "object"
              ? data
              : {}
          ),
        ]
      );

      const draft = result.rows[0];

      if (!draft) {
        res.status(404).json({
          ok: false,
          error:
            "Aktiver Warenannahme-Draft wurde nicht gefunden.",
        });
        return;
      }

      res.json({
        ok: true,
        draft: {
          id: String(draft.id),
          status: draft.status,
          updatedAt:
            draft.updated_at,
        },
      });
    } catch (error) {
      console.error(
        "[ALO RECEIVING DRAFT UPDATE]",
        error
      );

      res.status(500).json({
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Warenannahme-Draft konnte nicht gespeichert werden.",
      });
    }
  }
);


router.post(
  "/drafts/:draftId/prepare-product",
  async (req, res) => {
    let preparationLockClient:
      PoolClient | null = null;

    let preparationLockKey:
      string | null = null;

    try {
      await ensureReceivingSchema();

      const draftId =
        String(
          req.params.draftId ?? ""
        ).trim();

      if (!/^\d+$/.test(draftId)) {
        res.status(400).json({
          ok: false,
          error:
            "Ungültige Draft-ID.",
        });
        return;
      }

      const lineId =
        String(
          req.body?.lineId ?? ""
        ).trim();

      if (!lineId) {
        res.status(400).json({
          ok: false,
          error:
            "Draft-Positions-ID fehlt.",
        });
        return;
      }

      const mode =
        String(
          req.body?.mode ??
            "AUTO_NEW"
        )
          .trim()
          .toUpperCase();

      if (
        mode !== "AUTO_NEW" &&
        mode !== "MANUAL_NEW"
      ) {
        res.status(400).json({
          ok: false,
          error:
            "Ungültiger Preparation-Modus.",
        });

        return;
      }

      /*
       * CONCURRENCY LOCK
       *
       * Zwei fast gleichzeitige Requests derselben
       * Draft-Position dürfen niemals parallel einen
       * Product Master erzeugen.
       *
       * Der zweite Request wartet hier und liest
       * anschliessend den bereits aktualisierten Draft.
       */
      preparationLockClient =
        await db.connect();

      preparationLockKey =
        `receiving-draft:${draftId}:line:${lineId}`;

      await preparationLockClient.query(
        `
          SELECT pg_advisory_lock(
            hashtext($1)
          )
        `,
        [preparationLockKey]
      );

      /*
       * Draft ERST NACH dem Lock lesen.
       *
       * Die Position selbst besitzt eine
       * stabile line.id aus ALO STAFF.
       */
      const draftResult =
        await db.query(
          `
            SELECT
              id,
              supplier,
              status,
              draft_data
            FROM receiving_drafts
            WHERE
              id = $1
              AND status = 'DRAFT'
            LIMIT 1
          `,
          [draftId]
        );

      if (
        draftResult.rows.length === 0
      ) {
        res.status(404).json({
          ok: false,
          error:
            "Offene Warenannahme wurde nicht gefunden.",
        });
        return;
      }

      const draft =
        draftResult.rows[0];

      const data =
        draft.draft_data &&
        typeof draft.draft_data ===
          "object"
          ? draft.draft_data
          : {};

      const lines =
        Array.isArray(data.lines)
          ? data.lines
          : [];

      const line =
        lines.find(
          (entry: any) =>
            String(
              entry?.id ?? ""
            ) === lineId
        );

      if (!line) {
        res.status(404).json({
          ok: false,
          error:
            "Lieferposition wurde im Draft nicht gefunden.",
        });
        return;
      }

      /*
       * preparationByLine ist die dauerhafte
       * Idempotenz-Marke.
       *
       * Sobald eine Product-Master-ID hier
       * steht, darf diese Position niemals
       * blind nochmals neu angelegt werden.
       */
      const preparationByLine =
        data.preparationByLine &&
        typeof data.preparationByLine ===
          "object"
          ? {
              ...data.preparationByLine,
            }
          : {};

      const previous =
        preparationByLine[lineId] &&
        typeof preparationByLine[
          lineId
        ] === "object"
          ? preparationByLine[lineId]
          : {};

      const previousProductMasterId =
        String(
          previous.productMasterId ??
            ""
        ).trim();

      const supplier =
        String(
          draft.supplier ?? ""
        ).trim();

      if (!supplier) {
        res.status(400).json({
          ok: false,
          error:
            "Lieferant fehlt im Draft.",
        });
        return;
      }

      /*
       * WICHTIG:
       * Dieser Endpunkt wird nur aufgerufen,
       * nachdem ALO CORE die Position als
       * NEW bestätigt hat.
       *
       * REVIEW wird vom Frontend niemals
       * automatisch hierher geschickt.
       */
      const result =
        await prepareReceivingNewProduct({
          supplier,
          product:
            String(
              line.product ?? ""
            ).trim(),
          barcode:
            line.barcode ?? null,
          articleNumber:
            line.articleNumber ??
            null,
          unitSize:
            line.unitSize ??
            null,
          unitCost:
            line.purchasePrice ??
            null,
          manualOverride:
            mode === "MANUAL_NEW",

          productMasterId:
            previousProductMasterId ||
            null,
        });

      /*
       * Nach erfolgreicher Preparation sofort
       * Product-Master-ID dauerhaft im
       * Server-Draft speichern.
       */
      preparationByLine[lineId] = {
        status:
          result.automation.status,
        productMasterId:
          result.productId,
        created:
          result.created,
        reused:
          result.reused,
        linkedExistingShopify:
          result.linkedExistingShopify,
        automationStatus:
          result.automation.status,
        preparedAt:
          new Date().toISOString(),
      };

      const preparation =
        preparationByLine[lineId];

      await db.query(
        `
          UPDATE receiving_drafts
          SET
            draft_data =
              jsonb_set(
                COALESCE(
                  draft_data,
                  '{}'::jsonb
                ) ||
                jsonb_build_object(
                  'preparationByLine',
                  COALESCE(
                    draft_data
                      -> 'preparationByLine',
                    '{}'::jsonb
                  )
                ),
                ARRAY[
                  'preparationByLine',
                  $3
                ],
                $2::jsonb,
                true
              ),
            updated_at = NOW()
          WHERE
            id = $1
            AND status = 'DRAFT'
        `,
        [
          draftId,
          JSON.stringify(
            preparation
          ),
          lineId,
        ]
      );

      res.json({
        ok: true,
        draftId,
        lineId,
        preparation,
      });
    } catch (error) {
      console.error(
        "[ALO RECEIVING PREPARE PRODUCT]",
        error
      );

      const message =
        error instanceof Error
          ? error.message
          : "Produkt konnte nicht vorbereitet werden.";

      /*
       * Konflikte werden bewusst nicht als
       * generischer Serverfehler behandelt.
       */
      if (
        message ===
          "EXACT_BARCODE_CONFLICT" ||
        message ===
          "SHOPIFY_MATCH_AMBIGUOUS" ||
        message ===
          "PRODUCT_MATCH_REQUIRES_REVIEW"
      ) {
        res.status(409).json({
          ok: false,
          code: message,
          error:
            message ===
            "EXACT_BARCODE_CONFLICT"
              ? "Der Barcode gehört bereits zu einem bestehenden Product Master."
              : "Shopify enthält mehrere mögliche Treffer. Produkt muss geprüft werden.",
        });
        return;
      }

      res.status(500).json({
        ok: false,
        error: message,
      });
    } finally {
      if (
        preparationLockClient &&
        preparationLockKey
      ) {
        try {
          await preparationLockClient.query(
            `
              SELECT pg_advisory_unlock(
                hashtext($1)
              )
            `,
            [preparationLockKey]
          );
        } catch (unlockError) {
          console.error(
            "[ALO RECEIVING PREPARE PRODUCT UNLOCK]",
            unlockError
          );
        } finally {
          preparationLockClient.release();
        }
      }
    }
  }
);


router.delete(
  "/drafts/:draftId",
  async (req, res) => {
    try {
      await ensureReceivingSchema();

      const draftId =
        String(
          req.params.draftId ?? ""
        ).trim();

      if (!/^\d+$/.test(draftId)) {
        res.status(400).json({
          ok: false,
          error: "Ungültige Draft-ID.",
        });
        return;
      }

      const result = await db.query(
        `
          UPDATE receiving_drafts
          SET
            status = 'CANCELLED',
            updated_at = NOW()
          WHERE
            id = $1
            AND status = 'DRAFT'
          RETURNING id
        `,
        [draftId]
      );

      res.json({
        ok: true,
        cancelled:
          result.rowCount === 1,
        draftId,
      });
    } catch (error) {
      console.error(
        "[ALO RECEIVING DRAFT DELETE]",
        error
      );

      res.status(500).json({
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Warenannahme-Draft konnte nicht gelöscht werden.",
      });
    }
  }
);



router.post(
  "/preview",
  async (req, res) => {
    try {
      await ensureReceivingSchema();

      const {
        supplier,
        deliveryNote,
        lines,
      } = req.body ?? {};

      if (!cleanText(supplier)) {
        res.status(400).json({
          ok: false,
          error: "Lieferant fehlt.",
        });
        return;
      }

      if (!cleanText(deliveryNote)) {
        res.status(400).json({
          ok: false,
          error: "Lieferscheinnummer fehlt.",
        });
        return;
      }

      if (
        !Array.isArray(lines) ||
        lines.length === 0
      ) {
        res.status(400).json({
          ok: false,
          error:
            "Keine Lieferpositionen vorhanden.",
        });
        return;
      }

      const previewLines: any[] = [];

      for (
        let index = 0;
        index < lines.length;
        index += 1
      ) {
        const input =
          lines[index] as ReceivingLineInput;

        const productName =
          cleanText(input.product);

        const barcode =
          cleanBarcode(input.barcode);

        if (!productName) {
          previewLines.push({
            position: index + 1,
            classification: "REVIEW",
            reason: "MISSING_PRODUCT_NAME",
            product: "",
            barcode: barcode || null,
            quantity: null,
          });
          continue;
        }

        let quantity: number;

        try {
          validateReceivingPackaging(
            input,
            index + 1
          );

          quantity =
            resolveReceivedQuantity(
              input,
              index + 1
            );
        } catch (error) {
          previewLines.push({
            position: index + 1,
            classification: "REVIEW",
            reason: "INVALID_QUANTITY",
            product: productName,
            barcode: barcode || null,
            quantity: null,
            error:
              error instanceof Error
                ? error.message
                : "Menge konnte nicht geprüft werden.",
          });
          continue;
        }

        const manualNew =
          input.resolution ===
          "MANUAL_NEW";

        if (manualNew) {
          const conflict =
            await resolveReceivingProductMaster({
              barcode,
              supplier,
              articleNumber:
                input.articleNumber ?? null,
              title: productName,
              unitSize:
                input.unitSize ?? null,
            });

          const normalizedBarcode =
            String(barcode ?? "").trim();

          const exactBarcodeConflict =
            normalizedBarcode
              ? conflict.status === "MATCH"
                ? String(
                    conflict.product?.barcode ??
                      ""
                  ).trim() ===
                  normalizedBarcode
                : conflict.status ===
                    "AMBIGUOUS"
                  ? conflict.matches.some(
                      (match) =>
                        String(
                          match.product
                            ?.barcode ?? ""
                        ).trim() ===
                        normalizedBarcode
                    )
                  : false
              : false;

          if (exactBarcodeConflict) {
            const matches =
              conflict.status === "MATCH"
                ? [
                    {
                      productMasterId:
                        String(
                          conflict.product.id
                        ),
                      title:
                        conflict.product.title,
                      confidence:
                        conflict.confidence,
                    },
                  ]
                : conflict.status ===
                    "AMBIGUOUS"
                  ? conflict.matches
                      .filter(
                        (match) =>
                          String(
                            match.product
                              ?.barcode ?? ""
                          ).trim() ===
                          normalizedBarcode
                      )
                      .map((match) => ({
                        productMasterId:
                          String(
                            match.product.id
                          ),
                        title:
                          match.product.title,
                        confidence:
                          match.confidence,
                      }))
                  : [];

            previewLines.push({
              position: index + 1,
              classification: "REVIEW",
              reason:
                "MANUAL_NEW_EXACT_BARCODE_CONFLICT",
              product: productName,
              barcode:
                barcode || null,
              quantity,
              cases:
                input.cases ?? null,
              unitsPerCase:
                input.unitsPerCase ?? null,
              unitSize:
                input.unitSize ?? null,
              purchasePrice:
                input.purchasePrice ?? null,
              totalPrice:
                input.totalPrice ?? null,
              expiry:
                input.expiry ?? null,
              batch:
                input.batch ?? null,
              productMasterId: null,
              matches,
            });

            continue;
          }

          previewLines.push({
            position: index + 1,
            classification: "NEW",
            reason: "MANUAL_NEW",
            product: productName,
            barcode:
              barcode || null,
            quantity,
            cases:
              input.cases ?? null,
            unitsPerCase:
              input.unitsPerCase ?? null,
            unitSize:
              input.unitSize ?? null,
            purchasePrice:
              input.purchasePrice ?? null,
            totalPrice:
              input.totalPrice ?? null,
            expiry:
              input.expiry ?? null,
            batch:
              input.batch ?? null,
            productMasterId: null,
            matchedBy:
              "MANUAL_NEW",
          });

          continue;
        }

        const manualProductMaster =
          await resolveManualProductMaster(
            input,
            db,
            index + 1
          );

        const productMasterResolution =
          manualProductMaster
            ? null
            : await resolveReceivingProductMaster({
                barcode,
                supplier,
                articleNumber:
                  input.articleNumber ?? null,
                title: productName,
                unitSize:
                  input.unitSize ?? null,
              });

        if (manualProductMaster) {
          previewLines.push({
            position: index + 1,
            classification: "EXISTING",
            reason:
              "MANUAL_PRODUCT_MASTER",
            product: productName,
            barcode: barcode || null,
            quantity,
            cases: input.cases ?? null,
            unitsPerCase:
              input.unitsPerCase ?? null,
            unitSize:
              input.unitSize ?? null,
            purchasePrice:
              input.purchasePrice ?? null,
            totalPrice:
              input.totalPrice ?? null,
            expiry:
              input.expiry ?? null,
            batch:
              input.batch ?? null,
            productMasterId:
              String(
                manualProductMaster.id
              ),
            productMasterTitle:
              manualProductMaster.title,
            shopifyProductId:
              manualProductMaster
                .shopify_product_id,
            shopifyVariantId:
              manualProductMaster
                .shopify_variant_id,
            shopifyTitle:
              manualProductMaster.title,
            matchedBy:
              "MANUAL_EXISTING",
          });

          continue;
        }

        if (
          productMasterResolution?.status ===
          "AMBIGUOUS"
        ) {
          previewLines.push({
            position: index + 1,
            classification: "REVIEW",
            reason:
              "AMBIGUOUS_PRODUCT_MASTER_MATCH",
            product: productName,
            barcode: barcode || null,
            quantity,
            cases: input.cases ?? null,
            unitsPerCase:
              input.unitsPerCase ?? null,
            unitSize:
              input.unitSize ?? null,
            purchasePrice:
              input.purchasePrice ?? null,
            totalPrice:
              input.totalPrice ?? null,
            expiry:
              input.expiry ?? null,
            batch:
              input.batch ?? null,
            productMasterId: null,
            matches:
              productMasterResolution.matches.map(
                (match) => ({
                  productMasterId:
                    String(match.product.id),
                  title:
                    match.product.title,
                  confidence:
                    match.confidence,
                })
              ),
          });
          continue;
        }

        const productMaster =
          productMasterResolution?.status ===
          "MATCH"
            ? productMasterResolution.product
            : null;

        const productMasterMatchedBy =
          productMasterResolution?.status ===
          "MATCH"
            ? productMasterResolution.matchedBy
            : null;

        if (productMaster) {
          previewLines.push({
            position: index + 1,
            classification: "EXISTING",
            reason:
              productMasterMatchedBy ===
              "SUPPLIER_ARTICLE"
                ? "SUPPLIER_ARTICLE"
                : productMasterMatchedBy ===
                  "TITLE_SIZE"
                  ? "PRODUCT_MASTER_TITLE_SIZE"
                  : "PRODUCT_MASTER_BARCODE",
            product: productName,
            barcode: barcode || null,
            quantity,
            cases: input.cases ?? null,
            unitsPerCase:
              input.unitsPerCase ?? null,
            unitSize:
              input.unitSize ?? null,
            purchasePrice:
              input.purchasePrice ?? null,
            totalPrice:
              input.totalPrice ?? null,
            expiry:
              input.expiry ?? null,
            batch:
              input.batch ?? null,
            productMasterId:
              String(productMaster.id),
            productMasterTitle:
              productMaster.title,
            shopifyProductId:
              productMaster.shopify_product_id,
            shopifyVariantId:
              productMaster.shopify_variant_id,
            shopifyTitle:
              productMaster.title,
            matchedBy:
              productMasterMatchedBy ??
              "PRODUCT_MASTER",
          });
          continue;
        }

        const identity =
          await resolveProductIdentity({
            barcode,
            title:
              productMaster?.product_data
                ?.title ??
              productMaster?.title ??
              productName,
            unitSize:
              productMaster?.product_data
                ?.unitSize ??
              input.unitSize,
            netWeight:
              productMaster?.product_data
                ?.netWeight,
          });

        if (
          identity.status ===
            "EXACT_TITLE_SIZE" &&
          !barcode &&
          !productMaster
        ) {
          previewLines.push({
            position: index + 1,
            classification: "REVIEW",
            reason: "BARCODE_REQUIRED_FOR_RECEIVING",
            product: productName,
            barcode: null,
            quantity,
            cases: input.cases ?? null,
            unitsPerCase:
              input.unitsPerCase ?? null,
            unitSize:
              input.unitSize ?? null,
            purchasePrice:
              input.purchasePrice ?? null,
            totalPrice:
              input.totalPrice ?? null,
            expiry:
              input.expiry ?? null,
            batch:
              input.batch ?? null,
            productMasterId: null,
            shopifyProductId:
              identity.match.productId,
            shopifyVariantId:
              identity.match.variantId,
            shopifyTitle:
              identity.match.productTitle,
            matchedBy: "TITLE_SIZE",
          });
          continue;
        }

        if (
          identity.status ===
            "EXACT_BARCODE" ||
          identity.status ===
            "EXACT_TITLE_SIZE"
        ) {
          previewLines.push({
            position: index + 1,
            classification: "EXISTING",
            reason:
              identity.status,
            product: productName,
            barcode: barcode || null,
            quantity,
            cases: input.cases ?? null,
            unitsPerCase:
              input.unitsPerCase ?? null,
            unitSize:
              input.unitSize ?? null,
            purchasePrice:
              input.purchasePrice ?? null,
            totalPrice:
              input.totalPrice ?? null,
            expiry:
              input.expiry ?? null,
            batch:
              input.batch ?? null,
            productMasterId:
              productMaster
                ? String(productMaster.id)
                : null,
            productMasterTitle:
              productMaster?.title ?? null,
            shopifyProductId:
              identity.match.productId,
            shopifyVariantId:
              identity.match.variantId,
            shopifyTitle:
              identity.match.productTitle,
            matchedBy:
              identity.status ===
                "EXACT_BARCODE"
                ? "BARCODE"
                : "TITLE_SIZE",
          });
          continue;
        }

        if (
          identity.status ===
            "MULTIPLE_BARCODE_MATCHES" ||
          identity.status ===
            "MULTIPLE_IDENTITY_MATCHES"
        ) {
          previewLines.push({
            position: index + 1,
            classification: "REVIEW",
            reason:
              identity.status,
            product: productName,
            barcode: barcode || null,
            quantity,
            cases: input.cases ?? null,
            unitsPerCase:
              input.unitsPerCase ?? null,
            unitSize:
              input.unitSize ?? null,
            purchasePrice:
              input.purchasePrice ?? null,
            totalPrice:
              input.totalPrice ?? null,
            expiry:
              input.expiry ?? null,
            batch:
              input.batch ?? null,
            productMasterId:
              productMaster
                ? String(productMaster.id)
                : null,
            matches:
              identity.matches,
          });
          continue;
        }

        if (
          identity.status ===
          "INSUFFICIENT_IDENTITY"
        ) {
          previewLines.push({
            position: index + 1,
            classification: "REVIEW",
            reason:
              barcode
                ? "NO_SAFE_SHOPIFY_MATCH"
                : "MISSING_BARCODE_OR_SIZE",
            product: productName,
            barcode: barcode || null,
            quantity,
            cases: input.cases ?? null,
            unitsPerCase:
              input.unitsPerCase ?? null,
            unitSize:
              input.unitSize ?? null,
            purchasePrice:
              input.purchasePrice ?? null,
            totalPrice:
              input.totalPrice ?? null,
            expiry:
              input.expiry ?? null,
            batch:
              input.batch ?? null,
            productMasterId:
              productMaster
                ? String(productMaster.id)
                : null,
          });
          continue;
        }

        previewLines.push({
          position: index + 1,
          classification: "NEW",
          reason: "NO_SHOPIFY_MATCH",
          product: productName,
          barcode: barcode || null,
          quantity,
          cases: input.cases ?? null,
          unitsPerCase:
            input.unitsPerCase ?? null,
          unitSize:
            input.unitSize ?? null,
          purchasePrice:
            input.purchasePrice ?? null,
          totalPrice:
            input.totalPrice ?? null,
          expiry:
            input.expiry ?? null,
          batch:
            input.batch ?? null,
          productMasterId:
            productMaster
              ? String(productMaster.id)
              : null,
        });
      }

      const existing =
        previewLines.filter(
          (line) =>
            line.classification ===
            "EXISTING"
        ).length;

      const newProducts =
        previewLines.filter(
          (line) =>
            line.classification === "NEW"
        ).length;

      const review =
        previewLines.filter(
          (line) =>
            line.classification ===
            "REVIEW"
        ).length;

      res.json({
        ok: true,
        preview: true,
        store: "distribution",
        supplier:
          cleanText(supplier),
        deliveryNote:
          cleanText(deliveryNote),
        summary: {
          positions:
            previewLines.length,
          units:
            previewLines.reduce(
              (sum, line) =>
                sum +
                (Number.isFinite(
                  line.quantity
                )
                  ? line.quantity
                  : 0),
              0
            ),
          existing,
          newProducts,
          review,
          readyToComplete:
            review === 0,
        },
        lines: previewLines,
      });
    } catch (error) {
      console.error(
        "[ALO RECEIVING PREVIEW]",
        error
      );

      res.status(500).json({
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Warenannahme-Vorschau fehlgeschlagen.",
      });
    }
  }
);

router.post(
  "/complete",
  async (req, res) => {
    const client =
      await db.connect();

    try {
      await ensureReceivingSchema();

      const {
        store,
        supplier,
        deliveryNote,
        documentDate,
        currency,
        receivedBy,
        note,
        lines,
      } = req.body ?? {};

      if (!cleanText(supplier)) {
        res.status(400).json({
          ok: false,
          error:
            "Lieferant fehlt.",
        });
        return;
      }

      if (!cleanText(deliveryNote)) {
        res.status(400).json({
          ok: false,
          error:
            "Lieferscheinnummer fehlt.",
        });
        return;
      }

      if (
        !Array.isArray(lines) ||
        lines.length === 0
      ) {
        res.status(400).json({
          ok: false,
          error:
            "Keine Lieferpositionen vorhanden.",
        });
        return;
      }

      await client.query("BEGIN");

      const deliveryResult =
        await client.query(
          `
            INSERT INTO receiving_deliveries (
              store_id,
              supplier,
              delivery_note,
              document_date,
              currency,
              received_by,
              note
            )
            VALUES (
              $1, $2, $3, $4, $5, $6, $7
            )
            RETURNING *
          `,
          [
            "distribution",
            cleanText(supplier),
            cleanText(deliveryNote),
            documentDate || null,
            cleanText(currency) || "CHF",
            cleanText(receivedBy) || null,
            cleanText(note) || null,
          ]
        );

      const delivery =
        deliveryResult.rows[0];

      const results: any[] = [];

      for (
        let index = 0;
        index < lines.length;
        index += 1
      ) {
        const input =
          lines[index] as ReceivingLineInput;

        const productName =
          cleanText(input.product);

        const barcode =
          cleanBarcode(input.barcode);

        validateReceivingPackaging(
          input,
          index + 1
        );

        const quantity =
          resolveReceivedQuantity(
            input,
            index + 1
          );

        const allocations =
          resolveAllocations(
            input,
            quantity,
            index + 1
          );

        if (!productName) {
          throw new ReceivingValidationError(
            `Position ${index + 1}: Produktname fehlt.`
          );
        }

        if (
          !Number.isFinite(quantity) ||
          quantity < 1
        ) {
          throw new ReceivingValidationError(
            `${productName}: ungültige Menge.`
          );
        }

        const purchasePrice =
          numberOrNull(
            input.purchasePrice
          );

        const totalPrice =
          numberOrNull(
            input.totalPrice
          );

        const unitCost =
          calculateUnitCost(
            quantity,
            purchasePrice,
            totalPrice
          );

        let product: any = null;
        let createdProduct = false;
        let linkedExistingShopify = false;
        let resolvedShopifyMatch: any = null;

        const manualNew =
          input.resolution ===
          "MANUAL_NEW";

        const manualProductMaster =
          manualNew
            ? null
            : await resolveManualProductMaster(
                input,
                client,
                index + 1
              );

        const productMasterResolution =
          manualProductMaster
            ? null
            : await resolveReceivingProductMaster(
                {
                  barcode,
                  supplier,
                  articleNumber:
                    input.articleNumber ?? null,
                  title: productName,
                  unitSize:
                    input.unitSize ?? null,
                },
                client
              );

        if (manualNew && barcode) {
          const normalizedBarcode =
            String(barcode).trim();

          const exactBarcodeConflict =
            productMasterResolution?.status ===
            "MATCH"
              ? String(
                  productMasterResolution
                    .product?.barcode ?? ""
                ).trim() ===
                normalizedBarcode
              : productMasterResolution
                    ?.status === "AMBIGUOUS"
                ? productMasterResolution.matches.some(
                    (match) =>
                      String(
                        match.product
                          ?.barcode ?? ""
                      ).trim() ===
                      normalizedBarcode
                  )
                : false;

          if (exactBarcodeConflict) {
            throw new ReceivingValidationError(
              `${productName}: dieser Barcode ist bereits einem Product Master zugeordnet. Bitte bestehenden Artikel verwenden.`
            );
          }
        }

        if (
          !manualNew &&
          productMasterResolution?.status ===
          "AMBIGUOUS"
        ) {
          throw new ReceivingValidationError(
            `${productName}: mehrere ähnliche Product-Master-Produkte gefunden. Bitte Position prüfen.`
          );
        }

        if (manualProductMaster) {
          product =
            manualProductMaster;
        } else if (
          !manualNew &&
          productMasterResolution?.status ===
          "MATCH"
        ) {
          product =
            productMasterResolution.product;
        }

        if (!product && barcode) {
          const identity =
            await resolveProductIdentity({
              barcode,
              title: productName,
              unitSize:
                input.unitSize ?? null,
              netWeight: null,
            });

          if (
            identity.status ===
              "MULTIPLE_BARCODE_MATCHES" ||
            identity.status ===
              "MULTIPLE_IDENTITY_MATCHES"
          ) {
            throw new ReceivingValidationError(
              `${productName}: mehrere mögliche Shopify-Produkte gefunden. Bitte Position prüfen.`
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

        if (
          !product &&
          (barcode || manualNew)
        ) {
          const draft = {
            title:
              productName.toUpperCase(),
            barcode:
              barcode || null,
            productName,
            unitSize:
              input.unitSize ?? null,
            commerce: {
              purchasePrice:
                unitCost,
              pointsMultiplier: 1,
            },
            receiving: {
              supplier:
                cleanText(supplier),
              articleNumber:
                input.articleNumber ??
                null,
              lastUnitCost:
                unitCost,
            },
          };

          const created =
            await client.query(
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
                JSON.stringify(draft),
                resolvedShopifyMatch
                  ? "LINKED_EXISTING"
                  : "NOT_SYNCED",
                resolvedShopifyMatch
                  ?.productId ?? null,
                resolvedShopifyMatch
                  ?.variantId ?? null,
                resolvedShopifyMatch
                  ?.inventoryItemId ?? null,
              ]
            );

          product = created.rows[0];
          createdProduct = true;
          linkedExistingShopify =
            Boolean(
              resolvedShopifyMatch
                ?.productId
            );
        }

        if (!product) {
          throw new ReceivingValidationError(
            `${productName}: kein Barcode vorhanden. Bitte Barcode scannen, bevor die Lieferung abgeschlossen wird.`
          );
        }

        const existingData =
          product.product_data &&
          typeof product.product_data ===
            "object"
            ? product.product_data
            : {};

        const commerce = {
          ...(existingData.commerce ??
            {}),
          ...(unitCost !== null
            ? {
                purchasePrice:
                  unitCost,
              }
            : {}),
        };

        const receiving = {
          ...(existingData.receiving ??
            {}),
          supplier:
            cleanText(supplier),
          articleNumber:
            input.articleNumber ??
            existingData.receiving
              ?.articleNumber ??
            null,
          lastUnitCost:
            unitCost ??
            existingData.receiving
              ?.lastUnitCost ??
            null,
          lastDeliveryAt:
            new Date().toISOString(),
        };

        await client.query(
          `
            UPDATE products
            SET
              product_data =
                product_data ||
                $2::jsonb,
              updated_at = NOW()
            WHERE id = $1
          `,
          [
            product.id,
            JSON.stringify({
              commerce,
              receiving,
            }),
          ]
        );

        await rememberSupplierArticle(
          {
            productId: product.id,
            supplier,
            articleNumber:
              input.articleNumber ?? null,
          },
          client
        );

        const lineResult =
          await client.query(
            `
              INSERT INTO receiving_lines (
                delivery_id,
                product_id,
                product_name,
                barcode,
                article_number,
                quantity,
                cases,
                units_per_case,
                unit_size,
                unit_purchase_cost,
                line_total,
                expiry,
                batch
              )
              VALUES (
                $1, $2, $3, $4, $5,
                $6, $7, $8, $9, $10,
                $11, $12, $13
              )
              RETURNING id
            `,
            [
              delivery.id,
              product.id,
              productName,
              barcode || null,
              input.articleNumber ??
                null,
              quantity,
              input.cases ?? null,
              input.unitsPerCase ??
                null,
              input.unitSize ?? null,
              unitCost,
              totalPrice,
              input.expiry || null,
              cleanText(input.batch) ||
                null,
            ]
          );

        const receivingLineId =
          lineResult.rows[0].id;

        const stockResults: Array<{
          store: StoreId;
          quantity: number;
          previousQuantity: number;
          newQuantity: number;
          status: "EXPECTED";
        }> = [];

        const allocationEntries =
          Object.entries(
            allocations
          ) as Array<
            [StoreId, number]
          >;

        for (
          const [
            allocationStore,
            allocationQuantity,
          ] of allocationEntries
        ) {
          if (allocationQuantity <= 0) {
            continue;
          }

          await client.query(
            `
              INSERT INTO
                receiving_allocations (
                  receiving_line_id,
                  store_id,
                  quantity
                )
              VALUES (
                $1,
                $2,
                $3
              )
            `,
            [
              receivingLineId,
              allocationStore,
              allocationQuantity,
            ]
          );

          stockResults.push({
            store: allocationStore,
            quantity: allocationQuantity,
            previousQuantity: 0,
            newQuantity: 0,
            status: "EXPECTED",
          });        }

        results.push({
          lineId:
            String(receivingLineId),
          productId:
            String(product.id),
          barcode,
          product: productName,
          quantity,
          allocations,
          stock: stockResults,
          receivingStatus: "EXPECTED",
          unitPurchaseCost:
            unitCost,
          createdProduct,
          linkedExistingShopify,
          shopifyProductId:
            product.shopify_product_id ??
            null,
          shopifyVariantId:
            product.shopify_variant_id ??
            null,
          shopifyInventoryItemId:
            product.shopify_inventory_item_id ??
            null,
          needsReview:
            createdProduct,
        });
      }

      await client.query("COMMIT");

      for (const line of results) {
        if (line.createdProduct) {
          try {
            const automation =
              await automateReceivingProduct(
                line.productId
              );

            line.productAutomation =
              automation;

            if (
              automation.status ===
              "READY_FOR_REVIEW"
            ) {
              line.shopifyProductId =
                automation.shopify
                  .shopifyProductId;

              line.shopifyVariantId =
                automation.shopify
                  .shopifyVariantId;

              line.shopifyInventoryItemId =
                automation.shopify
                  .shopifyInventoryItemId;
            }
          } catch (
            automationError
          ) {
            console.error(
              "[ALO RECEIVING PRODUCT AUTOMATION]",
              {
                deliveryId:
                  String(
                    delivery.id
                  ),
                lineId:
                  line.lineId,
                productId:
                  line.productId,
                error:
                  automationError instanceof Error
                    ? automationError.message
                    : automationError,
              }
            );

            line.productAutomation = {
              status:
                "FAILED",
              productId:
                line.productId,
              error:
                automationError instanceof Error
                  ? automationError.message
                  : "Produkt-Automation fehlgeschlagen.",
            };
          }
        } else {
          line.productAutomation = {
            status:
              "NOT_REQUIRED",
          };
        }

        line.shopifyInventorySync = {
          status: "NOT_REQUESTED",
          reason: "WAITING_FOR_ACCEPTANCE",
        };
      }

      res.json({
        ok: true,
        delivery: {
          id: String(delivery.id),
          store:
            delivery.store_id,
          supplier:
            delivery.supplier,
          deliveryNote:
            delivery.delivery_note,
        },
        summary: {
          positions:
            results.length,
          units:
            results.reduce(
              (
                total,
                line
              ) =>
                total +
                line.quantity,
              0
            ),
          newProducts:
            results.filter(
              (line) =>
                line.createdProduct
            ).length,
          productsNeedingReview:
            results.filter(
              (line) =>
                line.needsReview
            ).length,
        },
        lines: results,
      });
    } catch (error: any) {
      try {
        await client.query(
          "ROLLBACK"
        );
      } catch {}

      console.error(
        "[ALO RECEIVING]",
        error
      );

      const duplicate =
        error?.code === "23505";

      const validation =
        error instanceof ReceivingValidationError;

      const status =
        duplicate
          ? 409
          : validation
            ? error.statusCode
            : 500;

      res
        .status(status)
        .json({
          ok: false,
          code: duplicate
            ? "DUPLICATE_DELIVERY"
            : validation
              ? "RECEIVING_VALIDATION_ERROR"
              : "RECEIVING_INTERNAL_ERROR",
          error: duplicate
            ? "Dieser Lieferschein wurde für diesen Standort bereits verbucht."
            : error instanceof Error
              ? error.message
              : "Wareneingang konnte nicht gespeichert werden.",
        });
    } finally {
      client.release();
    }
  }
);


/* =========================================================
   STAGED RECEIVING V3
   EXPECTED -> ARRIVED -> ACCEPTED
========================================================= */

router.delete(
  "/deliveries/:deliveryId",
  async (req, res) => {
    const client =
      await db.connect();

    try {
      await ensureReceivingSchema();

      const deliveryId =
        String(
          req.params.deliveryId ?? ""
        ).trim();

      if (!/^\d+$/.test(deliveryId)) {
        res.status(400).json({
          ok: false,
          error:
            "Ungültige Lieferungs-ID.",
        });
        return;
      }

      await client.query("BEGIN");

      /*
       * Ganze Lieferung sperren.
       */
      const deliveryResult =
        await client.query(
          `
            SELECT
              id,
              supplier,
              delivery_note,
              status
            FROM receiving_deliveries
            WHERE id = $1
            FOR UPDATE
          `,
          [deliveryId]
        );

      if (
        deliveryResult.rows.length === 0
      ) {
        await client.query(
          "ROLLBACK"
        );

        res.status(404).json({
          ok: false,
          error:
            "Lieferung nicht gefunden.",
        });
        return;
      }

      /*
       * Harte Sicherheitsregel:
       *
       * Sobald auch nur EINE Allocation
       * ACCEPTED ist, darf die Lieferung
       * niemals gelöscht werden.
       */
      const acceptedResult =
        await client.query(
          `
            SELECT
              a.id,
              a.store_id
            FROM receiving_allocations a
            JOIN receiving_lines rl
              ON rl.id =
                a.receiving_line_id
            WHERE
              rl.delivery_id = $1
              AND a.status = 'ACCEPTED'
            LIMIT 1
            FOR UPDATE OF a
          `,
          [deliveryId]
        );

      if (
        acceptedResult.rows.length > 0
      ) {
        await client.query(
          "ROLLBACK"
        );

        res.status(409).json({
          ok: false,
          code:
            "DELIVERY_ALREADY_ACCEPTED",
          error:
            "Diese Lieferung kann nicht entfernt werden, weil bereits Ware angenommen und Bestand gebucht wurde.",
        });
        return;
      }

      /*
       * Zusätzlich alle noch vorhandenen
       * Allocations sperren, damit während
       * des Löschens kein ARRIVE/ACCEPT
       * parallel laufen kann.
       */
      await client.query(
        `
          SELECT
            a.id
          FROM receiving_allocations a
          JOIN receiving_lines rl
            ON rl.id =
              a.receiving_line_id
          WHERE rl.delivery_id = $1
          FOR UPDATE OF a
        `,
        [deliveryId]
      );

      const delivery =
        deliveryResult.rows[0];

      /*
       * receiving_lines:
       *   ON DELETE CASCADE
       *
       * receiving_allocations:
       *   ON DELETE CASCADE
       *
       * Kein ACCEPTED vorhanden =>
       * kein realer Bestand muss
       * rückgängig gemacht werden.
       */
      await client.query(
        `
          DELETE FROM receiving_deliveries
          WHERE id = $1
        `,
        [deliveryId]
      );

      await client.query("COMMIT");

      res.json({
        ok: true,
        removed: true,
        deliveryId,
        supplier:
          delivery.supplier,
        deliveryNote:
          delivery.delivery_note,
      });
    } catch (error) {
      try {
        await client.query(
          "ROLLBACK"
        );
      } catch {}

      console.error(
        "[ALO RECEIVING DELETE DELIVERY]",
        error
      );

      res.status(500).json({
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Lieferung konnte nicht entfernt werden.",
      });
    } finally {
      client.release();
    }
  }
);


router.get(
  "/pending",
  async (req, res) => {
    try {
      await ensureReceivingSchema();

      const store =
        cleanText(req.query.store);

      if (
        !store ||
        !["aarau", "olten", "online"].includes(
          store
        )
      ) {
        res.status(400).json({
          ok: false,
          error:
            "Gültiger Standort erforderlich: aarau, olten oder online.",
        });
        return;
      }

      const result = await db.query(
        `
          SELECT
            a.id AS allocation_id,
            a.store_id,
            a.quantity,
            a.status,
            a.accepted_quantity,
            a.accepted_at,
            a.accepted_by,
            a.shopify_sync_status,
            a.shopify_sync_error,

            rl.id AS line_id,
            rl.product_id,
            rl.product_name,
            rl.barcode,
            rl.article_number,
            rl.unit_size,
            rl.expiry,
            rl.batch,

            d.id AS delivery_id,
            d.supplier,
            d.delivery_note,
            d.document_date,
            d.status AS delivery_status,
            d.created_at,

            p.shopify_inventory_item_id

          FROM receiving_allocations a

          JOIN receiving_lines rl
            ON rl.id =
              a.receiving_line_id

          JOIN receiving_deliveries d
            ON d.id =
              rl.delivery_id

          LEFT JOIN products p
            ON p.id =
              rl.product_id

          WHERE
            a.store_id = $1
            AND (
              a.status <> 'ACCEPTED'
              OR (
                a.store_id = 'online'
                AND a.status = 'ACCEPTED'
                AND a.shopify_sync_status IN (
                  'PENDING',
                  'FAILED'
                )
              )
            )

          ORDER BY
            CASE
              WHEN
                a.status = 'ACCEPTED'
                AND a.shopify_sync_status = 'FAILED'
                THEN 0
              WHEN
                a.status = 'ACCEPTED'
                AND a.shopify_sync_status = 'PENDING'
                THEN 1
              WHEN a.status = 'ARRIVED'
                THEN 2
              ELSE 3
            END,
            d.created_at ASC,
            rl.id ASC
        `,
        [store]
      );

      res.json({
        ok: true,
        store,
        count:
          result.rows.length,
        allocations:
          result.rows.map(
            (row: any) => ({
              allocationId:
                String(
                  row.allocation_id
                ),
              deliveryId:
                String(
                  row.delivery_id
                ),
              lineId:
                String(row.line_id),

              store:
                row.store_id,
              status:
                row.status,

              quantity:
                Number(row.quantity),
              acceptedQuantity:
                Number(
                  row.accepted_quantity ??
                    0
                ),

              supplier:
                row.supplier,
              deliveryNote:
                row.delivery_note,
              documentDate:
                row.document_date,

              productId:
                row.product_id
                  ? String(
                      row.product_id
                    )
                  : null,

              product:
                row.product_name,
              barcode:
                row.barcode,
              articleNumber:
                row.article_number,
              unitSize:
                row.unit_size,
              expiry:
                row.expiry,
              batch:
                row.batch,

              acceptedAt:
                row.accepted_at,
              acceptedBy:
                row.accepted_by,

              shopifyInventorySync: {
                status:
                  row.shopify_sync_status,
                error:
                  row.shopify_sync_error,
              },
            })
          ),
      });
    } catch (error) {
      console.error(
        "[ALO RECEIVING PENDING]",
        error
      );

      res.status(500).json({
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Offene Warenannahmen konnten nicht geladen werden.",
      });
    }
  }
);


router.post(
  "/allocations/:allocationId/arrive",
  async (req, res) => {
    const client =
      await db.connect();

    try {
      await ensureReceivingSchema();

      const allocationId =
        String(
          req.params.allocationId ??
            ""
        ).trim();

      if (
        !/^\d+$/.test(
          allocationId
        )
      ) {
        res.status(400).json({
          ok: false,
          error:
            "Ungültige Warenannahme-ID.",
        });
        return;
      }

      await client.query(
        "BEGIN"
      );

      const locked =
        await client.query(
          `
            SELECT
              a.id,
              a.status,
              a.quantity,
              a.store_id,
              rl.delivery_id
            FROM receiving_allocations a

            JOIN receiving_lines rl
              ON rl.id =
                a.receiving_line_id

            WHERE a.id = $1

            FOR UPDATE OF a
          `,
          [allocationId]
        );

      if (
        locked.rows.length === 0
      ) {
        await client.query(
          "ROLLBACK"
        );

        res.status(404).json({
          ok: false,
          error:
            "Warenannahme nicht gefunden.",
        });
        return;
      }

      const allocation =
        locked.rows[0];

      if (
        allocation.status ===
        "ACCEPTED"
      ) {
        await client.query(
          "COMMIT"
        );

        res.json({
          ok: true,
          allocationId,
          status: "ACCEPTED",
          alreadyAccepted: true,
        });
        return;
      }

      await client.query(
        `
          UPDATE receiving_allocations
          SET status = 'ARRIVED'
          WHERE id = $1
        `,
        [allocationId]
      );

      await client.query(
        `
          UPDATE receiving_deliveries
          SET status = 'ARRIVED'
          WHERE
            id = $1
            AND status = 'EXPECTED'
        `,
        [
          allocation.delivery_id,
        ]
      );

      await client.query(
        "COMMIT"
      );

      res.json({
        ok: true,
        allocationId,
        store:
          allocation.store_id,
        quantity:
          Number(
            allocation.quantity
          ),
        status: "ARRIVED",
      });
    } catch (error) {
      try {
        await client.query(
          "ROLLBACK"
        );
      } catch {}

      console.error(
        "[ALO RECEIVING ARRIVE]",
        error
      );

      res.status(500).json({
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Ware konnte nicht als eingetroffen markiert werden.",
      });
    } finally {
      client.release();
    }
  }
);


router.post(
  "/allocations/:allocationId/accept",
  async (req, res) => {
    const client =
      await db.connect();

    let onlineSync:
      | {
          allocationId: string;
          inventoryItemId: string;
          quantity: number;
          reference: string;
        }
      | null = null;

    let responseData: any =
      null;

    try {
      await ensureReceivingSchema();

      const allocationId =
        String(
          req.params.allocationId ??
            ""
        ).trim();

      const acceptedBy =
        cleanText(
          req.body?.acceptedBy
        ) || "ALO STAFF";

      if (
        !/^\d+$/.test(
          allocationId
        )
      ) {
        res.status(400).json({
          ok: false,
          error:
            "Ungültige Warenannahme-ID.",
        });
        return;
      }

      await client.query(
        "BEGIN"
      );

      const locked =
        await client.query(
          `
            SELECT
              a.id,
              a.store_id,
              a.quantity,
              a.status,
              a.accepted_quantity,

              rl.id AS line_id,
              rl.delivery_id,
              rl.product_id,
              rl.product_name,
              rl.expiry,
              rl.batch,

              d.supplier,
              d.delivery_note,

              p.shopify_inventory_item_id

            FROM receiving_allocations a

            JOIN receiving_lines rl
              ON rl.id =
                a.receiving_line_id

            JOIN receiving_deliveries d
              ON d.id =
                rl.delivery_id

            JOIN products p
              ON p.id =
                rl.product_id

            WHERE a.id = $1

            FOR UPDATE OF a
          `,
          [allocationId]
        );

      if (
        locked.rows.length === 0
      ) {
        await client.query(
          "ROLLBACK"
        );

        res.status(404).json({
          ok: false,
          error:
            "Warenannahme nicht gefunden.",
        });
        return;
      }

      const row =
        locked.rows[0];

      if (
        row.status ===
        "ACCEPTED"
      ) {
        await client.query(
          "COMMIT"
        );

        res.json({
          ok: true,
          allocationId,
          status: "ACCEPTED",
          alreadyAccepted: true,
          quantity:
            Number(
              row.accepted_quantity ??
                row.quantity
            ),
        });
        return;
      }

      const quantity =
        Number(row.quantity);

      if (
        !Number.isInteger(
          quantity
        ) ||
        quantity <= 0
      ) {
        throw new Error(
          "Ungültige Annahmemenge."
        );
      }

      /* -----------------------------------------
         Stock Snapshot sicher anlegen
      ----------------------------------------- */

      await client.query(
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
            0,
            'empty',
            $3,
            $4,
            NOW()
          )

          ON CONFLICT (
            product_id,
            store_id
          )

          DO NOTHING
        `,
        [
          row.product_id,
          row.store_id,
          `LS ${row.delivery_note}`,
          acceptedBy,
        ]
      );

      const lockedStock =
        await client.query(
          `
            SELECT
              exact_quantity
            FROM
              product_stock_snapshots

            WHERE
              product_id = $1
              AND store_id = $2

            FOR UPDATE
          `,
          [
            row.product_id,
            row.store_id,
          ]
        );

      const previousQuantity =
        Number(
          lockedStock.rows[0]
            ?.exact_quantity ?? 0
        );

      const newQuantity =
        previousQuantity +
        quantity;

      /* -----------------------------------------
         Audit Movement
      ----------------------------------------- */

      await client.query(
        `
          INSERT INTO stock_movements (
            product_id,
            store_id,
            movement_type,
            quantity_delta,
            reference_type,
            reference_id,
            note,
            created_by
          )

          VALUES (
            $1,
            $2,
            'RECEIVING',
            $3,
            'RECEIVING_ALLOCATION',
            $4,
            $5,
            $6
          )
        `,
        [
          row.product_id,
          row.store_id,
          quantity,
          allocationId,
          `Warenannahme · ${row.supplier} · LS ${row.delivery_note}`,
          acceptedBy,
        ]
      );

      /* -----------------------------------------
         Bestand aktualisieren
      ----------------------------------------- */

      await client.query(
        `
          UPDATE
            product_stock_snapshots

          SET
            exact_quantity = $3,
            stock_level = $4,
            note = $5,
            updated_by = $6,
            updated_at = NOW()

          WHERE
            product_id = $1
            AND store_id = $2
        `,
        [
          row.product_id,
          row.store_id,
          newQuantity,
          stockLevelForQuantity(
            newQuantity
          ),
          `LS ${row.delivery_note}`,
          acceptedBy,
        ]
      );

      /* -----------------------------------------
         MHD / Batch erst JETZT
      ----------------------------------------- */

      if (
        row.expiry ||
        cleanText(row.batch)
      ) {
        await client.query(
          `
            INSERT INTO product_batches (
              product_id,
              store_id,
              quantity,
              expiry,
              batch,
              receiving_line_id
            )

            VALUES (
              $1,
              $2,
              $3,
              $4,
              $5,
              $6
            )
          `,
          [
            row.product_id,
            row.store_id,
            quantity,
            row.expiry || null,
            cleanText(row.batch) ||
              null,
            row.line_id,
          ]
        );
      }

      /* -----------------------------------------
         Allocation final übernehmen
      ----------------------------------------- */

      const shopifyStatus =
        row.store_id ===
        "online"
          ? "PENDING"
          : "NOT_REQUIRED";

      await client.query(
        `
          UPDATE receiving_allocations

          SET
            status = 'ACCEPTED',
            accepted_quantity = $2,
            accepted_at = NOW(),
            accepted_by = $3,
            shopify_sync_status = $4,
            shopify_sync_error = NULL

          WHERE id = $1
        `,
        [
          allocationId,
          quantity,
          acceptedBy,
          shopifyStatus,
        ]
      );

      /* -----------------------------------------
         Delivery Gesamtstatus
      ----------------------------------------- */

      const remaining =
        await client.query(
          `
            SELECT COUNT(*)::int
              AS remaining

            FROM receiving_allocations a

            JOIN receiving_lines rl
              ON rl.id =
                a.receiving_line_id

            WHERE
              rl.delivery_id = $1
              AND a.status <>
                'ACCEPTED'
          `,
          [row.delivery_id]
        );

      const remainingCount =
        Number(
          remaining.rows[0]
            ?.remaining ?? 0
        );

      await client.query(
        `
          UPDATE receiving_deliveries
          SET status = $2
          WHERE id = $1
        `,
        [
          row.delivery_id,
          remainingCount === 0
            ? "ACCEPTED"
            : "ARRIVED",
        ]
      );

      responseData = {
        allocationId,
        deliveryId:
          String(
            row.delivery_id
          ),
        lineId:
          String(row.line_id),
        productId:
          String(
            row.product_id
          ),
        product:
          row.product_name,
        store:
          row.store_id,
        quantity,
        previousQuantity,
        newQuantity,
        status: "ACCEPTED",
        deliveryStatus:
          remainingCount === 0
            ? "ACCEPTED"
            : "ARRIVED",
      };

      if (
        row.store_id ===
        "online" &&
        row.shopify_inventory_item_id
      ) {
        onlineSync = {
          allocationId,
          inventoryItemId:
            String(
              row.shopify_inventory_item_id
            ),
          quantity:
            newQuantity,
          reference:
            `receiving-${allocationId}`,
        };
      }

      await client.query(
        "COMMIT"
      );
    } catch (error) {
      try {
        await client.query(
          "ROLLBACK"
        );
      } catch {}

      console.error(
        "[ALO RECEIVING ACCEPT]",
        error
      );

      res.status(500).json({
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Warenannahme konnte nicht übernommen werden.",
      });

      return;
    } finally {
      client.release();
    }

    /* -----------------------------------------
       Shopify erst NACH erfolgreicher
       interner Warenannahme
    ----------------------------------------- */

    if (onlineSync) {
      try {
        const sync =
          await setShopifyOnlineInventory({
            inventoryItemId:
              onlineSync.inventoryItemId,
            quantity:
              onlineSync.quantity,
            reference:
              onlineSync.reference,
          });

        await db.query(
          `
            UPDATE receiving_allocations
            SET
              shopify_sync_status =
                'SYNCED',
              shopify_sync_error =
                NULL,
              shopify_synced_at =
                NOW()

            WHERE id = $1
          `,
          [
            onlineSync.allocationId,
          ]
        );

        responseData.shopifyInventorySync = {
          status: "SYNCED",
          locationId:
            sync.locationId,
          quantity:
            sync.quantity,
        };
      } catch (syncError) {
        const message =
          syncError instanceof Error
            ? syncError.message
            : "Shopify-Bestand konnte nicht synchronisiert werden.";

        await db.query(
          `
            UPDATE receiving_allocations
            SET
              shopify_sync_status =
                'FAILED',
              shopify_sync_error =
                $2

            WHERE id = $1
          `,
          [
            onlineSync.allocationId,
            message,
          ]
        );

        responseData.shopifyInventorySync = {
          status: "FAILED",
          error: message,
        };
      }
    } else if (
      responseData?.store ===
      "online"
    ) {
      await db.query(
        `
          UPDATE receiving_allocations
          SET
            shopify_sync_status =
              'FAILED',
            shopify_sync_error =
              'NO_SHOPIFY_INVENTORY_ITEM'

          WHERE id = $1
        `,
        [
          responseData.allocationId,
        ]
      );

      responseData.shopifyInventorySync = {
        status: "FAILED",
        error:
          "NO_SHOPIFY_INVENTORY_ITEM",
      };
    } else {
      responseData.shopifyInventorySync = {
        status: "NOT_REQUIRED",
      };
    }

    res.json({
      ok: true,
      ...responseData,
    });
  }
);



/* =========================================================
   RETRY SHOPIFY INVENTORY
   Nur für bereits ACCEPTED Online-Ware.
   KEINE interne Bestandsbuchung.
========================================================= */

router.post(
  "/allocations/:allocationId/retry-shopify",
  async (req, res) => {
    try {
      await ensureReceivingSchema();

      const allocationId =
        String(
          req.params.allocationId ?? ""
        ).trim();

      if (!/^\d+$/.test(allocationId)) {
        res.status(400).json({
          ok: false,
          error: "Ungültige Warenannahme-ID.",
        });
        return;
      }

      const result = await db.query(
        `
          SELECT
            a.id,
            a.status,
            a.store_id,
            a.shopify_sync_status,

            rl.product_id,

            p.shopify_inventory_item_id,

            s.exact_quantity

          FROM receiving_allocations a

          JOIN receiving_lines rl
            ON rl.id = a.receiving_line_id

          JOIN products p
            ON p.id = rl.product_id

          LEFT JOIN product_stock_snapshots s
            ON s.product_id = rl.product_id
            AND s.store_id = 'online'

          WHERE a.id = $1
        `,
        [allocationId]
      );

      if (result.rows.length === 0) {
        res.status(404).json({
          ok: false,
          error: "Warenannahme nicht gefunden.",
        });
        return;
      }

      const row = result.rows[0];

      if (row.store_id !== "online") {
        res.status(400).json({
          ok: false,
          error:
            "Shopify-Sync ist nur für Online-Bestand verfügbar.",
        });
        return;
      }

      if (row.status !== "ACCEPTED") {
        res.status(409).json({
          ok: false,
          error:
            "Shopify darf erst nach der tatsächlichen Warenübernahme synchronisiert werden.",
        });
        return;
      }

      if (!row.shopify_inventory_item_id) {
        await db.query(
          `
            UPDATE receiving_allocations
            SET
              shopify_sync_status = 'FAILED',
              shopify_sync_error =
                'NO_SHOPIFY_INVENTORY_ITEM'
            WHERE id = $1
          `,
          [allocationId]
        );

        res.status(409).json({
          ok: false,
          error: "NO_SHOPIFY_INVENTORY_ITEM",
        });
        return;
      }

      const quantity =
        Number(row.exact_quantity ?? 0);

      try {
        const sync =
          await setShopifyOnlineInventory({
            inventoryItemId:
              String(
                row.shopify_inventory_item_id
              ),
            quantity,
            reference:
              `receiving-${allocationId}-retry`,
          });

        await db.query(
          `
            UPDATE receiving_allocations
            SET
              shopify_sync_status = 'SYNCED',
              shopify_sync_error = NULL,
              shopify_synced_at = NOW()
            WHERE id = $1
          `,
          [allocationId]
        );

        res.json({
          ok: true,
          allocationId,
          status: "ACCEPTED",
          internalStockChanged: false,
          shopifyInventorySync: {
            status: "SYNCED",
            locationId: sync.locationId,
            quantity: sync.quantity,
          },
        });
      } catch (syncError) {
        const message =
          syncError instanceof Error
            ? syncError.message
            : "Shopify-Bestand konnte nicht synchronisiert werden.";

        await db.query(
          `
            UPDATE receiving_allocations
            SET
              shopify_sync_status = 'FAILED',
              shopify_sync_error = $2
            WHERE id = $1
          `,
          [
            allocationId,
            message,
          ]
        );

        res.status(502).json({
          ok: false,
          allocationId,
          status: "ACCEPTED",
          internalStockChanged: false,
          shopifyInventorySync: {
            status: "FAILED",
            error: message,
          },
        });
      }
    } catch (error) {
      console.error(
        "[ALO RECEIVING SHOPIFY RETRY]",
        error
      );

      res.status(500).json({
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Shopify-Sync konnte nicht erneut ausgeführt werden.",
      });
    }
  }
);



/* =========================================================
   EDIT PLANNED RECEIVING DISTRIBUTION
   Nur solange noch NICHTS ACCEPTED wurde.
========================================================= */

router.patch(
  "/deliveries/:deliveryId/allocations",
  async (req, res) => {
    const client =
      await db.connect();

    try {
      await ensureReceivingSchema();

      const deliveryId =
        String(
          req.params.deliveryId ?? ""
        ).trim();

      const lines =
        req.body?.lines;

      if (!/^\d+$/.test(deliveryId)) {
        res.status(400).json({
          ok: false,
          error: "Ungültige Lieferungs-ID.",
        });
        return;
      }

      if (
        !Array.isArray(lines) ||
        lines.length === 0
      ) {
        res.status(400).json({
          ok: false,
          error:
            "Mindestens eine Lieferposition muss übergeben werden.",
        });
        return;
      }

      await client.query("BEGIN");

      /* -----------------------------------------
         Lieferung sperren
      ----------------------------------------- */

      const deliveryResult =
        await client.query(
          `
            SELECT
              id,
              status,
              supplier,
              delivery_note

            FROM receiving_deliveries

            WHERE id = $1

            FOR UPDATE
          `,
          [deliveryId]
        );

      if (
        deliveryResult.rows.length === 0
      ) {
        await client.query("ROLLBACK");

        res.status(404).json({
          ok: false,
          error: "Lieferung nicht gefunden.",
        });
        return;
      }

      /* -----------------------------------------
         Sobald irgendetwas ACCEPTED ist:
         keine Verteilung mehr verändern.
      ----------------------------------------- */

      const acceptedResult =
        await client.query(
          `
            SELECT
              a.id,
              a.receiving_line_id,
              a.store_id

            FROM receiving_allocations a

            JOIN receiving_lines rl
              ON rl.id =
                a.receiving_line_id

            WHERE
              rl.delivery_id = $1
              AND a.status = 'ACCEPTED'

            LIMIT 1

            FOR UPDATE OF a
          `,
          [deliveryId]
        );

      if (
        acceptedResult.rows.length > 0
      ) {
        await client.query("ROLLBACK");

        res.status(409).json({
          ok: false,
          code:
            "DELIVERY_ALREADY_PARTIALLY_ACCEPTED",
          error:
            "Die Verteilung kann nicht mehr geändert werden, weil bereits Ware übernommen wurde.",
        });
        return;
      }

      const updatedLines: any[] = [];

      for (const input of lines) {
        const lineId =
          String(
            input?.lineId ?? ""
          ).trim();

        if (!/^\d+$/.test(lineId)) {
          throw new ReceivingValidationError(
            "Ungültige Lieferpositions-ID."
          );
        }

        const lineResult =
          await client.query(
            `
              SELECT
                id,
                quantity,
                product_id,
                product_name

              FROM receiving_lines

              WHERE
                id = $1
                AND delivery_id = $2

              FOR UPDATE
            `,
            [
              lineId,
              deliveryId,
            ]
          );

        if (
          lineResult.rows.length === 0
        ) {
          throw new ReceivingValidationError(
            `Lieferposition ${lineId} gehört nicht zu dieser Lieferung.`
          );
        }

        const line =
          lineResult.rows[0];

        const quantity =
          Number(line.quantity);

        const raw =
          input?.allocations ?? {};

        const allocations = {
          aarau:
            Number(raw.aarau ?? 0),
          olten:
            Number(raw.olten ?? 0),
          online:
            Number(raw.online ?? 0),
        };

        for (
          const [store, value]
          of Object.entries(allocations)
        ) {
          if (
            !Number.isInteger(value) ||
            value < 0
          ) {
            throw new ReceivingValidationError(
              `Ungültige Menge für ${store}.`
            );
          }
        }

        const total =
          allocations.aarau +
          allocations.olten +
          allocations.online;

        if (total !== quantity) {
          throw new ReceivingValidationError(
            `${line.product_name}: Verteilung ${total} stimmt nicht mit Liefermenge ${quantity} überein.`
          );
        }

        /* -----------------------------------------
           Alte Planung dieser Position entfernen.
           Noch nichts ACCEPTED -> sicher.
        ----------------------------------------- */

        await client.query(
          `
            DELETE FROM receiving_allocations
            WHERE receiving_line_id = $1
          `,
          [lineId]
        );

        /* -----------------------------------------
           Neue Planung speichern.
           Geänderte Verteilung startet wieder
           sauber als EXPECTED.
        ----------------------------------------- */

        for (
          const store of [
            "aarau",
            "olten",
            "online",
          ] as const
        ) {
          const amount =
            allocations[store];

          if (amount <= 0) {
            continue;
          }

          await client.query(
            `
              INSERT INTO receiving_allocations (
                receiving_line_id,
                store_id,
                quantity,
                status,
                accepted_quantity,
                shopify_sync_status
              )

              VALUES (
                $1,
                $2,
                $3,
                'EXPECTED',
                0,
                'NOT_REQUIRED'
              )
            `,
            [
              lineId,
              store,
              amount,
            ]
          );
        }

        updatedLines.push({
          lineId,
          productId:
            line.product_id
              ? String(
                  line.product_id
                )
              : null,
          product:
            line.product_name,
          quantity,
          allocations,
        });
      }

      /* -----------------------------------------
         Lieferung nach Änderung wieder EXPECTED
      ----------------------------------------- */

      await client.query(
        `
          UPDATE receiving_deliveries
          SET status = 'EXPECTED'
          WHERE id = $1
        `,
        [deliveryId]
      );

      await client.query("COMMIT");

      res.json({
        ok: true,
        deliveryId,
        status: "EXPECTED",
        lines: updatedLines,
      });
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {}

      console.error(
        "[ALO RECEIVING EDIT ALLOCATIONS]",
        error
      );

      const validation =
        error instanceof
        ReceivingValidationError;

      res
        .status(
          validation
            ? error.statusCode
            : 500
        )
        .json({
          ok: false,
          code: validation
            ? "RECEIVING_VALIDATION_ERROR"
            : "RECEIVING_INTERNAL_ERROR",
          error:
            error instanceof Error
              ? error.message
              : "Verteilung konnte nicht geändert werden.",
        });
    } finally {
      client.release();
    }
  }
);


export default router;

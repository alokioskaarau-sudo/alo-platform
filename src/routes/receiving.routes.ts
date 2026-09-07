import { Router } from "express";
import { db } from "../database/db.js";

const router = Router();

type StoreId = "aarau" | "olten";

type ReceivingLineInput = {
  product: string;
  barcode?: string | null;
  articleNumber?: string | null;
  quantity: number;
  cases?: number | null;
  unitsPerCase?: number | null;
  totalUnits?: number | null;
  unitSize?: string | null;
  purchasePrice?: number | null;
  totalPrice?: number | null;
  expiry?: string | null;
  batch?: string | null;
};

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
    throw new Error(
      `Position ${position}: Gesamtstückzahl ist ungültig.`
    );
  }

  if (
    cases !== null &&
    c === null
  ) {
    throw new Error(
      `Position ${position}: Kartonanzahl ist ungültig.`
    );
  }

  if (
    unitsPerCase !== null &&
    u === null
  ) {
    throw new Error(
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
      throw new Error(
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

  throw new Error(
    `Position ${position}: Keine gültige Stückzahl vorhanden.`
  );
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
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(store_id, supplier, delivery_note)
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

      if (
        store !== "aarau" &&
        store !== "olten"
      ) {
        res.status(400).json({
          ok: false,
          error:
            "Ungültiger Standort.",
        });
        return;
      }

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
            store,
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

        const quantity =
          resolveReceivedQuantity(
            input,
            index + 1
          );

        if (!productName) {
          throw new Error(
            `Position ${index + 1}: Produktname fehlt.`
          );
        }

        if (
          !Number.isFinite(quantity) ||
          quantity < 1
        ) {
          throw new Error(
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

        if (barcode) {
          const existing =
            await client.query(
              `
                SELECT
                  id,
                  barcode,
                  title,
                  product_data
                FROM products
                WHERE barcode = $1
                LIMIT 1
              `,
              [barcode]
            );

          product =
            existing.rows[0] ?? null;
        }

        if (!product && barcode) {
          const draft = {
            title:
              productName.toUpperCase(),
            barcode,
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
                  updated_at
                )
                VALUES (
                  $1,
                  $2,
                  $3::jsonb,
                  'alo_staff_receiving',
                  'NEEDS_REVIEW',
                  'ALO STAFF',
                  NOW(),
                  NOW()
                )
                RETURNING
                  id,
                  barcode,
                  title,
                  product_data
              `,
              [
                barcode,
                productName.toUpperCase(),
                JSON.stringify(draft),
              ]
            );

          product = created.rows[0];
          createdProduct = true;
        }

        if (!product) {
          throw new Error(
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
              'DELIVERY',
              $4,
              $5,
              $6
            )
          `,
          [
            product.id,
            store,
            quantity,
            String(delivery.id),
            `Warenannahme · ${cleanText(
              supplier
            )} · LS ${cleanText(
              deliveryNote
            )}`,
            cleanText(receivedBy) ||
              "ALO STAFF",
          ]
        );

        const currentStock =
          await client.query(
            `
              SELECT exact_quantity
              FROM product_stock_snapshots
              WHERE
                product_id = $1
                AND store_id = $2
              LIMIT 1
            `,
            [
              product.id,
              store,
            ]
          );

        const previousQuantity =
          Number(
            currentStock.rows[0]
              ?.exact_quantity ?? 0
          );

        const nextQuantity =
          previousQuantity + quantity;

        await client.query(
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
              $1, $2, $3, $4, $5, $6, NOW()
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
              updated_at = NOW()
          `,
          [
            product.id,
            store,
            nextQuantity,
            stockLevelForQuantity(
              nextQuantity
            ),
            `LS ${cleanText(
              deliveryNote
            )}`,
            cleanText(receivedBy) ||
              "ALO STAFF",
          ]
        );

        if (
          input.expiry ||
          cleanText(input.batch)
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
                $1, $2, $3, $4, $5, $6
              )
            `,
            [
              product.id,
              store,
              quantity,
              input.expiry || null,
              cleanText(input.batch) ||
                null,
              receivingLineId,
            ]
          );
        }

        results.push({
          lineId:
            String(receivingLineId),
          productId:
            String(product.id),
          barcode,
          product: productName,
          quantity,
          previousQuantity,
          newQuantity:
            nextQuantity,
          unitPurchaseCost:
            unitCost,
          createdProduct,
          needsReview:
            createdProduct,
        });
      }

      await client.query("COMMIT");

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

      res
        .status(
          duplicate ? 409 : 500
        )
        .json({
          ok: false,
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

export default router;

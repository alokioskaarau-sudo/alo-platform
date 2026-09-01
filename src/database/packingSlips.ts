import { db } from "./db.js";

export type PackingSlipRecord = {
  id: string;
  shopify_order_id: string;
  shopify_order_name: string;
  pdf_base64: string | null;
  status: string;
  print_status: string;
  print_count: number;
  printer_name: string | null;
  printed_at: Date | null;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
};

export async function findPackingSlip(
  shopifyOrderId: string
): Promise<PackingSlipRecord | null> {

  const result =
    await db.query<PackingSlipRecord>(
      `
        SELECT *
        FROM packing_slips
        WHERE shopify_order_id = $1
        LIMIT 1
      `,
      [shopifyOrderId]
    );

  return result.rows[0] ?? null;
}

export async function reservePackingSlip(
  input: {
    shopifyOrderId: string;
    shopifyOrderName: string;
  }
): Promise<{
  created: boolean;
  record: PackingSlipRecord;
}> {

  const insert =
    await db.query<PackingSlipRecord>(
      `
        INSERT INTO packing_slips (
          shopify_order_id,
          shopify_order_name,
          status
        )
        VALUES (
          $1,
          $2,
          'PENDING'
        )
        ON CONFLICT (
          shopify_order_id
        )
        DO NOTHING
        RETURNING *
      `,
      [
        input.shopifyOrderId,
        input.shopifyOrderName,
      ]
    );

  if (insert.rows[0]) {
    return {
      created: true,
      record: insert.rows[0],
    };
  }

  const existing =
    await findPackingSlip(
      input.shopifyOrderId
    );

  if (!existing) {
    throw new Error(
      "Lieferschein konnte nicht reserviert werden."
    );
  }

  return {
    created: false,
    record: existing,
  };
}

export async function completePackingSlip(
  id: string,
  pdfBase64: string
): Promise<PackingSlipRecord> {

  const result =
    await db.query<PackingSlipRecord>(
      `
        UPDATE packing_slips
        SET
          pdf_base64 = $2,
          status = 'COMPLETED',
          error_message = NULL,
          updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `,
      [
        id,
        pdfBase64,
      ]
    );

  if (!result.rows[0]) {
    throw new Error(
      "Lieferschein-Datensatz nicht gefunden."
    );
  }

  return result.rows[0];
}

export async function failPackingSlip(
  id: string,
  errorMessage: string
) {

  await db.query(
    `
      UPDATE packing_slips
      SET
        status = 'FAILED',
        error_message = $2,
        updated_at = NOW()
      WHERE id = $1
    `,
    [
      id,
      errorMessage,
    ]
  );
}


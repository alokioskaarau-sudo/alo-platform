import { db } from "./db.js";

export type LabelMode =
  | "SPECIMEN"
  | "LIVE"
  | "PICKUP";

export type ShippingLabelRecord = {
  id: string;

  shopify_order_id: string;
  shopify_order_name: string;

  swisspost_ident_code:
    | string
    | null;

  label_mode: LabelMode;

  service: string;

  weight_grams:
    | number
    | null;

  address_quality:
    | string
    | null;

  status: string;

  label_pdf_base64:
    | string
    | null;

  error_message:
    | string
    | null;

  created_at: Date;
  updated_at: Date;
};


export async function findShippingLabel(
  shopifyOrderId: string,
  mode: LabelMode
): Promise<ShippingLabelRecord | null> {
  const result =
    await db.query<ShippingLabelRecord>(
      `
        SELECT *
        FROM shipping_labels
        WHERE shopify_order_id = $1
          AND label_mode = $2
        LIMIT 1
      `,
      [
        shopifyOrderId,
        mode,
      ]
    );

  return result.rows[0] ?? null;
}


export async function reserveShippingLabel(
  input: {
    shopifyOrderId: string;
    shopifyOrderName: string;

    mode: LabelMode;

    service: string;
    weightGrams: number;

    addressQuality: string;
  }
): Promise<{
  created: boolean;
  record: ShippingLabelRecord;
}> {
  const insert =
    await db.query<ShippingLabelRecord>(
      `
        INSERT INTO shipping_labels (
          shopify_order_id,
          shopify_order_name,
          label_mode,
          service,
          weight_grams,
          address_quality,
          status
        )

        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          'RESERVED'
        )

        ON CONFLICT (
          shopify_order_id,
          label_mode
        )
        DO NOTHING

        RETURNING *
      `,
      [
        input.shopifyOrderId,
        input.shopifyOrderName,
        input.mode,
        input.service,
        input.weightGrams,
        input.addressQuality,
      ]
    );

  if (insert.rows[0]) {
    return {
      created: true,
      record: insert.rows[0],
    };
  }

  const existing =
    await findShippingLabel(
      input.shopifyOrderId,
      input.mode
    );

  if (!existing) {
    throw new Error(
      "Shipping Label konnte nicht reserviert werden."
    );
  }

  return {
    created: false,
    record: existing,
  };
}


export async function completeShippingLabel(
  id: string,
  input: {
    identCode: string | null;
    pdfBase64: string;
  }
): Promise<ShippingLabelRecord> {
  const result =
    await db.query<ShippingLabelRecord>(
      `
        UPDATE shipping_labels

        SET
          swisspost_ident_code = $2,
          label_pdf_base64 = $3,
          status = 'COMPLETED',
          error_message = NULL,
          updated_at = NOW()

        WHERE id = $1

        RETURNING *
      `,
      [
        id,
        input.identCode,
        input.pdfBase64,
      ]
    );

  if (!result.rows[0]) {
    throw new Error(
      "Shipping Label Datensatz nicht gefunden."
    );
  }

  return result.rows[0];
}


export async function failShippingLabel(
  id: string,
  errorMessage: string
) {
  await db.query(
    `
      UPDATE shipping_labels

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

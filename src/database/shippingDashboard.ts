import { db } from "./db.js";

export type ShippingDashboardRecord = {
  id: string;

  shopify_order_id: string;
  shopify_order_name: string;

  swisspost_ident_code:
    | string
    | null;

  label_mode: string;

  service: string;

  weight_grams:
    | number
    | null;

  address_quality:
    | string
    | null;

  status: string;

  tracking_number:
    | string
    | null;

  shipment_status: string;

  print_status: string;

  print_count: number;

  printer_name:
    | string
    | null;

  printed_at:
    | Date
    | null;

  fulfilled_at:
    | Date
    | null;

  error_message:
    | string
    | null;

  created_at: Date;

  updated_at: Date;
};


// ==========================================================
// ALLE SHIPPING LABELS
// ==========================================================

export async function getShippingDashboardLabels(
  limit = 100
): Promise<ShippingDashboardRecord[]> {
  const result =
    await db.query<ShippingDashboardRecord>(
      `
        SELECT
          id,
          shopify_order_id,
          shopify_order_name,
          swisspost_ident_code,
          label_mode,
          service,
          weight_grams,
          address_quality,
          status,
          tracking_number,
          shipment_status,
          print_status,
          print_count,
          printer_name,
          printed_at,
          fulfilled_at,
          error_message,
          created_at,
          updated_at
        FROM shipping_labels
        ORDER BY created_at DESC
        LIMIT $1
      `,
      [limit]
    );

  return result.rows;
}


// ==========================================================
// EIN LABEL
// ==========================================================

export async function getShippingDashboardLabelById(
  id: string
): Promise<ShippingDashboardRecord | null> {
  const result =
    await db.query<ShippingDashboardRecord>(
      `
        SELECT
          id,
          shopify_order_id,
          shopify_order_name,
          swisspost_ident_code,
          label_mode,
          service,
          weight_grams,
          address_quality,
          status,
          tracking_number,
          shipment_status,
          print_status,
          print_count,
          printer_name,
          printed_at,
          fulfilled_at,
          error_message,
          created_at,
          updated_at
        FROM shipping_labels
        WHERE id = $1
        LIMIT 1
      `,
      [id]
    );

  return result.rows[0] ?? null;
}


// ==========================================================
// PDF AUS DB
// ==========================================================

export async function getShippingLabelPdf(
  id: string
): Promise<{
  id: string;
  orderName: string;
  pdfBase64: string;
} | null> {
  const result =
    await db.query<{
      id: string;
      shopify_order_name: string;
      label_pdf_base64:
        | string
        | null;
    }>(
      `
        SELECT
          id,
          shopify_order_name,
          label_pdf_base64
        FROM shipping_labels
        WHERE id = $1
        LIMIT 1
      `,
      [id]
    );

  const row =
    result.rows[0];

  if (
    !row ||
    !row.label_pdf_base64
  ) {
    return null;
  }

  return {
    id: row.id,
    orderName:
      row.shopify_order_name,
    pdfBase64:
      row.label_pdf_base64,
  };
}


// ==========================================================
// PRINT JOB ERSTELLEN
// ==========================================================

export async function createPrintJob(
  shippingLabelId: string,
  printerName?: string
) {
  const label =
    await getShippingDashboardLabelById(
      shippingLabelId
    );

  if (!label) {
    throw new Error(
      "Shipping Label wurde nicht gefunden."
    );
  }

  if (
    label.status !== "COMPLETED"
  ) {
    throw new Error(
      "Nur vollständig erstellte Labels können gedruckt werden."
    );
  }

  const existing =
    await db.query(
      `
        SELECT *
        FROM print_jobs
        WHERE shipping_label_id = $1
          AND status IN (
            'PENDING',
            'PRINTING'
          )
        LIMIT 1
      `,
      [shippingLabelId]
    );

  if (existing.rows[0]) {
    return {
      created: false,
      job:
        existing.rows[0],
    };
  }

  const result =
    await db.query(
      `
        INSERT INTO print_jobs (
          shipping_label_id,
          printer_name,
          status
        )
        VALUES (
          $1,
          $2,
          'PENDING'
        )
        RETURNING *
      `,
      [
        shippingLabelId,
        printerName ?? null,
      ]
    );

  await db.query(
    `
      UPDATE shipping_labels
      SET
        print_status = 'QUEUED',
        printer_name = COALESCE(
          $2,
          printer_name
        ),
        updated_at = NOW()
      WHERE id = $1
    `,
    [
      shippingLabelId,
      printerName ?? null,
    ]
  );

  return {
    created: true,
    job:
      result.rows[0],
  };
}


// ==========================================================
// NÄCHSTEN PRINT JOB HOLEN
// ==========================================================

export async function claimNextPrintJob(
  printerName: string
) {
  const client =
    await db.connect();

  try {
    await client.query(
      "BEGIN"
    );

    const result =
      await client.query(
        `
          SELECT
            pj.id,
            pj.shipping_label_id,
            pj.printer_name,
            pj.status,
            sl.shopify_order_name,
            sl.label_pdf_base64
          FROM print_jobs pj

          JOIN shipping_labels sl
            ON sl.id =
              pj.shipping_label_id

          WHERE
            pj.status = 'PENDING'

            AND (
              pj.printer_name IS NULL
              OR pj.printer_name = $1
            )

          ORDER BY
            pj.requested_at ASC

          FOR UPDATE
          SKIP LOCKED

          LIMIT 1
        `,
        [printerName]
      );

    const job =
      result.rows[0];

    if (!job) {
      await client.query(
        "COMMIT"
      );

      return null;
    }

    await client.query(
      `
        UPDATE print_jobs
        SET
          status = 'PRINTING',
          printer_name = $2,
          attempts =
            attempts + 1,
          started_at = NOW(),
          updated_at = NOW()
        WHERE id = $1
      `,
      [
        job.id,
        printerName,
      ]
    );

    await client.query(
      `
        UPDATE shipping_labels
        SET
          print_status = 'PRINTING',
          printer_name = $2,
          updated_at = NOW()
        WHERE id = $1
      `,
      [
        job.shipping_label_id,
        printerName,
      ]
    );

    await client.query(
      "COMMIT"
    );

    return {
      ...job,
      printer_name:
        printerName,
      status:
        "PRINTING",
    };
  } catch (error) {
    await client.query(
      "ROLLBACK"
    );

    throw error;
  } finally {
    client.release();
  }
}


// ==========================================================
// PRINT JOB ERFOLGREICH
// ==========================================================

export async function completePrintJob(
  printJobId: string
) {
  const client =
    await db.connect();

  try {
    await client.query(
      "BEGIN"
    );

    const jobResult =
      await client.query(
        `
          UPDATE print_jobs
          SET
            status = 'PRINTED',
            printed_at = NOW(),
            error_message = NULL,
            updated_at = NOW()
          WHERE id = $1
          RETURNING *
        `,
        [printJobId]
      );

    const job =
      jobResult.rows[0];

    if (!job) {
      throw new Error(
        "Print Job wurde nicht gefunden."
      );
    }

    await client.query(
      `
        UPDATE shipping_labels
        SET
          print_status = 'PRINTED',
          print_count =
            print_count + 1,
          printed_at = NOW(),
          updated_at = NOW()
        WHERE id = $1
      `,
      [
        job.shipping_label_id,
      ]
    );

    await client.query(
      "COMMIT"
    );

    return job;
  } catch (error) {
    await client.query(
      "ROLLBACK"
    );

    throw error;
  } finally {
    client.release();
  }
}


// ==========================================================
// PRINT JOB FEHLER
// ==========================================================

export async function failPrintJob(
  printJobId: string,
  errorMessage: string
) {
  const client =
    await db.connect();

  try {
    await client.query(
      "BEGIN"
    );

    const jobResult =
      await client.query(
        `
          UPDATE print_jobs
          SET
            status = 'FAILED',
            error_message = $2,
            updated_at = NOW()
          WHERE id = $1
          RETURNING *
        `,
        [
          printJobId,
          errorMessage,
        ]
      );

    const job =
      jobResult.rows[0];

    if (job) {
      await client.query(
        `
          UPDATE shipping_labels
          SET
            print_status = 'FAILED',
            error_message = $2,
            updated_at = NOW()
          WHERE id = $1
        `,
        [
          job.shipping_label_id,
          errorMessage,
        ]
      );
    }

    await client.query(
      "COMMIT"
    );

    return job ?? null;
  } catch (error) {
    await client.query(
      "ROLLBACK"
    );

    throw error;
  } finally {
    client.release();
  }
}

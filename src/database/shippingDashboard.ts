import { db } from "./db.js";


// ==========================================================
// TYPES
// ==========================================================

export type DocumentType =
  | "SHIPPING_LABEL"
  | "PACKING_SLIP"
  | "INVOICE"
  | "PICKUP_RECEIPT";


// ==========================================================
// SHIPPING DASHBOARD RECORD
// ==========================================================

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
// VERSANDLABEL PDF
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
// LIEFERSCHEIN PDF
// ==========================================================

export async function getPackingSlipPdf(
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
      pdf_base64:
        | string
        | null;
    }>(
      `
        SELECT
          id,
          shopify_order_name,
          pdf_base64
        FROM packing_slips
        WHERE id = $1
        LIMIT 1
      `,
      [id]
    );

  const row =
    result.rows[0];

  if (
    !row ||
    !row.pdf_base64
  ) {
    return null;
  }

  return {
    id: row.id,

    orderName:
      row.shopify_order_name,

    pdfBase64:
      row.pdf_base64,
  };
}


// ==========================================================
// VERSANDLABEL PRINT JOB
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
          AND document_type = 'SHIPPING_LABEL'
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
      job: existing.rows[0],
    };
  }

  const result =
    await db.query(
      `
        INSERT INTO print_jobs (
          shipping_label_id,
          packing_slip_id,
          document_type,
          printer_name,
          status
        )
        VALUES (
          $1,
          NULL,
          'SHIPPING_LABEL',
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
    job: result.rows[0],
  };
}


// ==========================================================
// LIEFERSCHEIN PRINT JOB
// ==========================================================

export async function createPackingSlipPrintJob(
  packingSlipId: string,
  printerName?: string
) {

  const result =
    await db.query(
      `
        SELECT
          id,
          shopify_order_name,
          status,
          pdf_base64
        FROM packing_slips
        WHERE id = $1
        LIMIT 1
      `,
      [packingSlipId]
    );

  const slip =
    result.rows[0];

  if (!slip) {
    throw new Error(
      "Lieferschein wurde nicht gefunden."
    );
  }

  if (
    slip.status !== "COMPLETED"
  ) {
    throw new Error(
      "Nur vollständig erstellte Lieferscheine können gedruckt werden."
    );
  }

  if (!slip.pdf_base64) {
    throw new Error(
      "Lieferschein enthält kein PDF."
    );
  }

  const existing =
    await db.query(
      `
        SELECT *
        FROM print_jobs
        WHERE packing_slip_id = $1
          AND document_type = 'PACKING_SLIP'
          AND status IN (
            'PENDING',
            'PRINTING'
          )
        LIMIT 1
      `,
      [packingSlipId]
    );

  if (existing.rows[0]) {
    return {
      created: false,
      job: existing.rows[0],
    };
  }

  const insert =
    await db.query(
      `
        INSERT INTO print_jobs (
          shipping_label_id,
          packing_slip_id,
          document_type,
          printer_name,
          status
        )
        VALUES (
          NULL,
          $1,
          'PACKING_SLIP',
          $2,
          'PENDING'
        )
        RETURNING *
      `,
      [
        packingSlipId,
        printerName ?? null,
      ]
    );

  await db.query(
    `
      UPDATE packing_slips
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
      packingSlipId,
      printerName ?? null,
    ]
  );

  return {
    created: true,
    job: insert.rows[0],
  };
}



// ==========================================================
// INVOICE PRINT JOB
// ==========================================================

export async function createInvoicePrintJob(

  invoiceId: string,

  printerName?: string

) {

  const client =
    await db.connect();

  try {

    await client.query(
      "BEGIN"
    );


    /*
     * Pro Rechnung nur ein automatischer Drucklauf.
     *
     * Der Advisory Lock verhindert, dass zwei parallele
     * Webhook-Ausführungen gleichzeitig zwei Printjobs
     * für dieselbe Rechnung erzeugen.
     */
    await client.query(
      `
        SELECT
          pg_advisory_xact_lock(
            hashtext($1::text)
          )
      `,
      [
        `invoice-print:${invoiceId}`,
      ]
    );


    const invoiceResult =
      await client.query(
        `
          SELECT
            id,
            status,
            print_status,
            pdf_base64
          FROM invoices
          WHERE id = $1
          LIMIT 1
        `,
        [
          invoiceId,
        ]
      );

    const invoice =
      invoiceResult.rows[0];

    if (!invoice) {

      throw new Error(
        "Rechnung wurde nicht gefunden."
      );
    }


    if (
      invoice.status !==
      "COMPLETED"
    ) {

      throw new Error(
        "Rechnung ist noch nicht abgeschlossen."
      );
    }


    if (!invoice.pdf_base64) {

      throw new Error(
        "Rechnung enthält kein PDF."
      );
    }


    /*
     * PENDING:
     * bereits in Queue
     *
     * PRINTING:
     * wird gerade gedruckt
     *
     * PRINTED:
     * bereits erfolgreich gedruckt
     *
     * In allen drei Fällen darf ein automatischer
     * Webhook-Retry KEINEN neuen Printjob erzeugen.
     */
    const existing =
      await client.query(
        `
          SELECT *
          FROM print_jobs
          WHERE invoice_id = $1
            AND document_type = 'INVOICE'
            AND status IN (
              'PENDING',
              'PRINTING',
              'PRINTED'
            )
          ORDER BY id DESC
          LIMIT 1
        `,
        [
          invoiceId,
        ]
      );


    if (
      existing.rows[0]
    ) {

      await client.query(
        "COMMIT"
      );

      return {
        created: false,
        job:
          existing.rows[0],
      };
    }


    const insert =
      await client.query(
        `
          INSERT INTO print_jobs (

            shipping_label_id,

            packing_slip_id,

            invoice_id,

            printer_name,

            document_type,

            status

          )

          VALUES (

            NULL,

            NULL,

            $1,

            $2,

            'INVOICE',

            'PENDING'

          )

          RETURNING *
        `,
        [
          invoiceId,
          printerName ?? null,
        ]
      );


    await client.query(
      `
        UPDATE invoices

        SET

          print_status = 'QUEUED',

          printer_name = $2,

          error_message = NULL,

          updated_at = NOW()

        WHERE id = $1
      `,
      [
        invoiceId,
        printerName ?? null,
      ]
    );


    await client.query(
      "COMMIT"
    );


    return {
      created: true,
      job:
        insert.rows[0],
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
// NÄCHSTEN PRINT JOB HOLEN
// ==========================================================

export async function claimNextPrintJob(
  printerName: string,
  documentType:
    | "SHIPPING_LABEL"
    | "PACKING_SLIP"
    | "INVOICE"
) {
  const client = await db.connect();

  try {
    await client.query("BEGIN");

    const result = await client.query(
      `
        SELECT
          pj.id,
          pj.shipping_label_id,
          pj.packing_slip_id,
          pj.invoice_id,
          pj.document_type,
          pj.printer_name,
          pj.status,

          CASE
            WHEN pj.document_type = 'SHIPPING_LABEL'
              THEN sl.shopify_order_name
            WHEN pj.document_type = 'PACKING_SLIP'
              THEN ps.shopify_order_name
            WHEN pj.document_type = 'INVOICE'
              THEN inv.shopify_order_name
            ELSE NULL
          END AS shopify_order_name,

          CASE
            WHEN pj.document_type = 'SHIPPING_LABEL'
              THEN sl.label_pdf_base64
            WHEN pj.document_type = 'PACKING_SLIP'
              THEN ps.pdf_base64
            WHEN pj.document_type = 'INVOICE'
              THEN inv.pdf_base64
            ELSE NULL
          END AS pdf_base64

        FROM print_jobs pj

        LEFT JOIN shipping_labels sl
          ON sl.id = pj.shipping_label_id

        LEFT JOIN packing_slips ps
          ON ps.id = pj.packing_slip_id

        LEFT JOIN invoices inv
          ON inv.id = pj.invoice_id

        WHERE
          pj.status = 'PENDING'

          AND pj.document_type = $2

          AND (
            pj.printer_name IS NULL
            OR pj.printer_name = $1
          )

        ORDER BY
          pj.requested_at ASC

        FOR UPDATE OF pj
        SKIP LOCKED

        LIMIT 1
      `,
      [
        printerName,
        documentType,
      ]
    );

    const job = result.rows[0];

    if (!job) {
      await client.query("COMMIT");
      return null;
    }

    if (!job.pdf_base64) {
      await client.query(
        `
          UPDATE print_jobs
          SET
            status = 'FAILED',
            error_message = $2,
            updated_at = NOW()
          WHERE id = $1
        `,
        [
          job.id,
          `Für ${documentType} wurde kein PDF gefunden.`,
        ]
      );

      await client.query("COMMIT");

      return null;
    }

    await client.query(
      `
        UPDATE print_jobs
        SET
          status = 'PRINTING',
          printer_name = $2,
          attempts = attempts + 1,
          started_at = NOW(),
          updated_at = NOW()
        WHERE id = $1
      `,
      [
        job.id,
        printerName,
      ]
    );

    if (documentType === "SHIPPING_LABEL") {
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
    }

    if (documentType === "PACKING_SLIP") {
      await client.query(
        `
          UPDATE packing_slips
          SET
            print_status = 'PRINTING',
            printer_name = $2,
            updated_at = NOW()
          WHERE id = $1
        `,
        [
          job.packing_slip_id,
          printerName,
        ]
      );
    }

    if (documentType === "INVOICE") {
      await client.query(
        `
          UPDATE invoices
          SET
            print_status = 'PRINTING',
            printer_name = $2,
            updated_at = NOW()
          WHERE id = $1
        `,
        [
          job.invoice_id,
          printerName,
        ]
      );
    }

    await client.query("COMMIT");

    return {
      ...job,
      printer_name: printerName,
      status: "PRINTING",
    };

  } catch (error) {
    await client.query("ROLLBACK");
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

    if (
      job.document_type ===
      "SHIPPING_LABEL"
    ) {

      await client.query(
        `
          UPDATE shipping_labels

          SET

            print_status = 'PRINTED',

            print_count =
              print_count + 1,

            printed_at = NOW(),

            error_message = NULL,

            updated_at = NOW()

          WHERE id = $1
        `,
        [
          job.shipping_label_id,
        ]
      );

    } else if (
      job.document_type ===
      "PACKING_SLIP"
    ) {

      await client.query(
        `
          UPDATE packing_slips

          SET

            print_status = 'PRINTED',

            print_count =
              print_count + 1,

            printed_at = NOW(),

            error_message = NULL,

            updated_at = NOW()

          WHERE id = $1
        `,
        [
          job.packing_slip_id,
        ]
      );

    } else if (
      job.document_type ===
      "INVOICE"
    ) {

      await client.query(
        `
          UPDATE invoices

          SET

            print_status = 'PRINTED',

            print_count =
              print_count + 1,

            printed_at = NOW(),

            error_message = NULL,

            updated_at = NOW()

          WHERE id = $1
        `,
        [
          job.invoice_id,
        ]
      );
    }

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

      if (
        job.document_type ===
        "SHIPPING_LABEL"
      ) {

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

      } else if (
        job.document_type ===
        "PACKING_SLIP"
      ) {

        await client.query(
          `
            UPDATE packing_slips

            SET

              print_status = 'FAILED',

              error_message = $2,

              updated_at = NOW()

            WHERE id = $1
          `,
          [
            job.packing_slip_id,
            errorMessage,
          ]
        );

      } else if (
        job.document_type ===
        "INVOICE"
      ) {

        await client.query(
          `
            UPDATE invoices

            SET

              print_status = 'FAILED',

              error_message = $2,

              updated_at = NOW()

            WHERE id = $1
          `,
          [
            job.invoice_id,
            errorMessage,
          ]
        );
      }
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



// ==========================================================
// RECHNUNG PDF AUS ARCHIV
// ==========================================================

export async function getInvoicePdf(
  id: string
): Promise<{
  id: string;
  invoiceNumber: string;
  orderName: string;
  pdfBase64: string;
} | null> {

  const result =
    await db.query<{
      id: string;
      invoice_number: string;
      shopify_order_name: string;
      pdf_base64: string | null;
    }>(
      `
        SELECT
          id,
          invoice_number,
          shopify_order_name,
          pdf_base64
        FROM invoices
        WHERE id = $1
        LIMIT 1
      `,
      [id]
    );

  const row =
    result.rows[0];

  if (
    !row ||
    !row.pdf_base64
  ) {
    return null;
  }

  return {
    id: row.id,
    invoiceNumber:
      row.invoice_number,
    orderName:
      row.shopify_order_name,
    pdfBase64:
      row.pdf_base64,
  };
}


// ==========================================================
// UNIFIED ORDER DASHBOARD
//
// Führt Versandlabel, Lieferschein und Rechnung anhand der
// Shopify Order ID zu genau einer Bestellung zusammen.
//
// WICHTIG:
// - rein lesend
// - keine Dokumente werden neu erzeugt
// - keine Printjobs
// - keine Swiss-Post-Anfrage
// ==========================================================

export type OrderDashboardRecord = {
  shopify_order_id: string;
  shopify_order_name: string;

  order_created_at: Date | null;
  latest_created_at: Date;

  label_id: string | null;
  label_mode: string | null;
  service: string | null;
  weight_grams: number | null;
  tracking_number: string | null;
  swisspost_ident_code: string | null;
  shipment_status: string | null;
  label_status: string | null;
  label_print_status: string | null;
  label_print_count: number | null;
  label_error_message: string | null;

  packing_slip_id: string | null;
  packing_slip_status: string | null;
  packing_slip_print_status: string | null;
  packing_slip_print_count: number | null;
  packing_slip_error_message: string | null;

  invoice_id: string | null;
  invoice_number: string | null;
  currency: string | null;
  total_amount: string | null;
  invoice_status: string | null;
  invoice_print_status: string | null;
  invoice_print_count: number | null;
  invoice_error_message: string | null;

  is_archived: boolean;
  is_test: boolean;
  archived_at: Date | null;

  dashboard_status:
    | "CURRENT"
    | "COMPLETED"
    | "ERROR"
    | "ARCHIVED";
};


export async function getOrderDashboard(
  limit = 250
): Promise<OrderDashboardRecord[]> {

  const result =
    await db.query<OrderDashboardRecord>(
      `
        WITH order_ids AS (

          SELECT
            shopify_order_id
          FROM shipping_labels

          UNION

          SELECT
            shopify_order_id
          FROM packing_slips

          UNION

          SELECT
            shopify_order_id
          FROM invoices

        ),

        labels AS (
          SELECT DISTINCT ON (
            shopify_order_id
          )
            id,
            shopify_order_id,
            shopify_order_name,
            swisspost_ident_code,
            label_mode,
            service,
            weight_grams,
            tracking_number,
            shipment_status,
            status,
            print_status,
            print_count,
            error_message,
            created_at
          FROM shipping_labels
          ORDER BY
            shopify_order_id,
            created_at DESC,
            id DESC
        ),

        slips AS (
          SELECT DISTINCT ON (
            shopify_order_id
          )
            id,
            shopify_order_id,
            shopify_order_name,
            status,
            print_status,
            print_count,
            error_message,
            created_at
          FROM packing_slips
          ORDER BY
            shopify_order_id,
            created_at DESC,
            id DESC
        ),

        invoice_rows AS (
          SELECT DISTINCT ON (
            shopify_order_id
          )
            id,
            invoice_number,
            shopify_order_id,
            shopify_order_name,
            order_created_at,
            currency,
            total_amount,
            status,
            print_status,
            print_count,
            error_message,
            created_at
          FROM invoices
          ORDER BY
            shopify_order_id,
            created_at DESC,
            id DESC
        )

        SELECT
          ids.shopify_order_id,

          COALESCE(
            i.shopify_order_name,
            s.shopify_order_name,
            p.shopify_order_name
          ) AS shopify_order_name,

          i.order_created_at,

          GREATEST(
            COALESCE(
              s.created_at,
              '-infinity'::timestamptz
            ),
            COALESCE(
              p.created_at,
              '-infinity'::timestamptz
            ),
            COALESCE(
              i.created_at,
              '-infinity'::timestamptz
            )
          ) AS latest_created_at,

          s.id AS label_id,
          s.label_mode,
          s.service,
          s.weight_grams,
          s.tracking_number,
          s.swisspost_ident_code,
          s.shipment_status,
          s.status AS label_status,
          s.print_status AS label_print_status,
          s.print_count AS label_print_count,
          s.error_message AS label_error_message,

          p.id AS packing_slip_id,
          p.status AS packing_slip_status,
          p.print_status AS packing_slip_print_status,
          p.print_count AS packing_slip_print_count,
          p.error_message AS packing_slip_error_message,

          i.id AS invoice_id,
          i.invoice_number,
          i.currency,
          i.total_amount,
          i.status AS invoice_status,
          i.print_status AS invoice_print_status,
          i.print_count AS invoice_print_count,
          i.error_message AS invoice_error_message,

          COALESCE(
            f.is_archived,
            FALSE
          ) AS is_archived,

          COALESCE(
            f.is_test,
            FALSE
          ) AS is_test,

          f.archived_at,

          CASE

            WHEN
              COALESCE(
                f.is_archived,
                FALSE
              ) = TRUE
            THEN 'ARCHIVED'


            WHEN
              s.status = 'FAILED'
              OR s.print_status = 'FAILED'
              OR p.status = 'FAILED'
              OR p.print_status = 'FAILED'
              OR i.status = 'FAILED'
              OR i.print_status = 'FAILED'
            THEN 'ERROR'

            /*
             * Abholung:
             * Der bestehende Pickup-Pfad erzeugt bewusst
             * keinen normalen Lieferschein + Rechnung.
             * Deshalb darf PICKUP nicht dauerhaft als
             * unvollständig erscheinen.
             */
            WHEN
              s.label_mode = 'PICKUP'
              AND s.status = 'COMPLETED'
              AND s.print_status = 'PRINTED'
            THEN 'COMPLETED'

            /*
             * Normaler Versand nach aktueller Pipeline:
             * Label + Lieferschein + Rechnung müssen
             * vorhanden, abgeschlossen und gedruckt sein.
             */
            WHEN
              s.label_mode <> 'PICKUP'
              AND s.status = 'COMPLETED'
              AND s.print_status = 'PRINTED'

              AND p.id IS NOT NULL
              AND p.status = 'COMPLETED'
              AND p.print_status = 'PRINTED'

              AND i.id IS NOT NULL
              AND i.status = 'COMPLETED'
              AND i.print_status = 'PRINTED'
            THEN 'COMPLETED'

            ELSE 'CURRENT'

          END AS dashboard_status

        FROM order_ids ids

        LEFT JOIN labels s
          ON s.shopify_order_id =
             ids.shopify_order_id

        LEFT JOIN slips p
          ON p.shopify_order_id =
             ids.shopify_order_id

        LEFT JOIN invoice_rows i
          ON i.shopify_order_id =
             ids.shopify_order_id

        LEFT JOIN order_dashboard_flags f
          ON f.shopify_order_id =
             ids.shopify_order_id

        ORDER BY
          latest_created_at DESC

        LIMIT $1
      `,
      [
        Math.max(
          1,
          Math.min(
            Number(limit) || 250,
            1000
          )
        ),
      ]
    );

  return result.rows;
}



// ==========================================================
// ORDER DASHBOARD ARCHIV
// ==========================================================

export async function setOrderArchiveStatus(
  shopifyOrderId: string,
  archived: boolean,
  isTest = false
): Promise<void> {

  if (!shopifyOrderId?.trim()) {
    throw new Error(
      "Shopify Order ID fehlt."
    );
  }

  await db.query(
    `
      INSERT INTO order_dashboard_flags (
        shopify_order_id,
        is_archived,
        is_test,
        archived_at,
        updated_at
      )
      VALUES (
        $1,
        $2,
        $3,
        CASE
          WHEN $2 = TRUE
          THEN NOW()
          ELSE NULL
        END,
        NOW()
      )

      ON CONFLICT (
        shopify_order_id
      )

      DO UPDATE SET
        is_archived =
          EXCLUDED.is_archived,

        is_test =
          EXCLUDED.is_test,

        archived_at =
          CASE
            WHEN EXCLUDED.is_archived = TRUE
            THEN COALESCE(
              order_dashboard_flags.archived_at,
              NOW()
            )
            ELSE NULL
          END,

        updated_at =
          NOW()
    `,
    [
      shopifyOrderId.trim(),
      archived,
      isTest,
    ]
  );
}


export async function archiveOrderAsTest(
  shopifyOrderId: string
): Promise<void> {

  await setOrderArchiveStatus(
    shopifyOrderId,
    true,
    true
  );
}


export async function restoreArchivedOrder(
  shopifyOrderId: string
): Promise<void> {

  await setOrderArchiveStatus(
    shopifyOrderId,
    false,
    false
  );
}

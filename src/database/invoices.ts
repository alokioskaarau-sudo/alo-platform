import { db } from "./db.js";

export type InvoiceRecord = {
  id: string;
  invoice_number: string;
  shopify_order_id: string;
  shopify_order_name: string;
  order_created_at: Date | null;
  currency: string;
  subtotal_amount: string | null;
  discount_amount: string | null;
  shipping_amount: string | null;
  tax_amount: string | null;
  total_amount: string | null;
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

export async function findInvoice(
  shopifyOrderId: string
): Promise<InvoiceRecord | null> {
  const result =
    await db.query<InvoiceRecord>(
      `
        SELECT *
        FROM invoices
        WHERE shopify_order_id = $1
        LIMIT 1
      `,
      [shopifyOrderId]
    );

  return result.rows[0] ?? null;
}

export async function reserveInvoice(
  input: {
    shopifyOrderId: string;
    shopifyOrderName: string;
    orderCreatedAt?: Date | null;
    currency: string;
    subtotalAmount?: string | null;
    discountAmount?: string | null;
    shippingAmount?: string | null;
    taxAmount?: string | null;
    totalAmount?: string | null;
  }
): Promise<{
  created: boolean;
  record: InvoiceRecord;
}> {
  const client = await db.connect();

  try {
    await client.query("BEGIN");

    /*
     * Sperrt die Nummernvergabe innerhalb der DB-Transaktion.
     * Dadurch können zwei gleichzeitig bezahlte Bestellungen
     * nicht dieselbe Rechnungsnummer erhalten.
     */
    await client.query(
      `SELECT pg_advisory_xact_lock(4102026)`
    );

    const existing =
      await client.query<InvoiceRecord>(
        `
          SELECT *
          FROM invoices
          WHERE shopify_order_id = $1
          LIMIT 1
        `,
        [input.shopifyOrderId]
      );

    if (existing.rows[0]) {
      await client.query("COMMIT");

      return {
        created: false,
        record: existing.rows[0],
      };
    }

    const year =
      (
        input.orderCreatedAt ??
        new Date()
      ).getUTCFullYear();

    const sequenceResult =
      await client.query<{
        next_number: string;
      }>(
        `
          SELECT
            COALESCE(
              MAX(
                CASE
                  WHEN invoice_number ~ $1
                  THEN
                    substring(
                      invoice_number
                      FROM '([0-9]+)$'
                    )::BIGINT
                  ELSE NULL
                END
              ),
              0
            ) + 1 AS next_number
          FROM invoices
        `,
        [`^ALO-${year}-[0-9]+$`]
      );

    const sequence =
      Number(
        sequenceResult.rows[0]
          ?.next_number ?? 1
      );

    const invoiceNumber =
      `ALO-${year}-${String(sequence).padStart(6, "0")}`;

    const insert =
      await client.query<InvoiceRecord>(
        `
          INSERT INTO invoices (
            invoice_number,
            shopify_order_id,
            shopify_order_name,
            order_created_at,
            currency,
            subtotal_amount,
            discount_amount,
            shipping_amount,
            tax_amount,
            total_amount,
            status
          )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8,
            $9,
            $10,
            'PENDING'
          )
          RETURNING *
        `,
        [
          invoiceNumber,
          input.shopifyOrderId,
          input.shopifyOrderName,
          input.orderCreatedAt ?? null,
          input.currency,
          input.subtotalAmount ?? null,
          input.discountAmount ?? null,
          input.shippingAmount ?? null,
          input.taxAmount ?? null,
          input.totalAmount ?? null,
        ]
      );

    await client.query("COMMIT");

    return {
      created: true,
      record: insert.rows[0],
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function completeInvoice(
  id: string,
  pdfBase64: string
): Promise<InvoiceRecord> {
  const result =
    await db.query<InvoiceRecord>(
      `
        UPDATE invoices
        SET
          pdf_base64 = $2,
          status = 'COMPLETED',
          error_message = NULL,
          updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `,
      [id, pdfBase64]
    );

  if (!result.rows[0]) {
    throw new Error(
      "Rechnungs-Datensatz wurde nicht gefunden."
    );
  }

  return result.rows[0];
}

export async function failInvoice(
  id: string,
  errorMessage: string
): Promise<void> {
  await db.query(
    `
      UPDATE invoices
      SET
        status = 'FAILED',
        error_message = $2,
        updated_at = NOW()
      WHERE id = $1
    `,
    [id, errorMessage]
  );
}

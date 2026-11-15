
import { db } from "./db.js";
import type { PoolClient } from "pg";

export type OrderDocumentEvidenceV399 = {
  document_type: string;
  label_mode: string | null;
  document_count: number;
  complete_documents: number;
  total_jobs: number;
  queued_jobs: number;
  printing_jobs: number;
  printed_jobs: number;
  failed_jobs: number;
  other_jobs: number;
};

export async function getOrderDocumentEvidenceV399(
  orderId: string,
  client?: PoolClient
): Promise<OrderDocumentEvidenceV399[]> {
  if (!/^gid:\/\/shopify\/Order\/[1-9][0-9]*$/.test(orderId)) {
    throw new Error("INVALID_SHOPIFY_ORDER_ID");
  }

  const executor = client ?? db;

  const result = await executor.query<OrderDocumentEvidenceV399>(
    `
    WITH documents AS (
      SELECT
        'SHIPPING_LABEL'::text AS document_type,
        label_mode::text AS label_mode,
        id,
        status,
        label_pdf_base64 AS pdf
      FROM shipping_labels
      WHERE shopify_order_id=$1

      UNION ALL

      SELECT
        'PACKING_SLIP',
        NULL::text,
        id,
        status,
        pdf_base64
      FROM packing_slips
      WHERE shopify_order_id=$1

      UNION ALL

      SELECT
        'INVOICE',
        NULL::text,
        id,
        status,
        pdf_base64
      FROM invoices
      WHERE shopify_order_id=$1
    ),
    joined AS (
      SELECT
        d.document_type,
        d.label_mode,
        d.id AS document_id,
        d.status AS document_status,
        d.pdf,
        p.id AS job_id,
        p.status AS job_status
      FROM documents d
      LEFT JOIN print_jobs p
        ON p.document_type=d.document_type
       AND (
         (
           d.document_type='SHIPPING_LABEL'
           AND p.shipping_label_id=d.id
         )
         OR (
           d.document_type='PACKING_SLIP'
           AND p.packing_slip_id=d.id
         )
         OR (
           d.document_type='INVOICE'
           AND p.invoice_id=d.id
         )
       )
    )
    SELECT
      document_type,
      label_mode,
      COUNT(DISTINCT document_id)::int AS document_count,
      COUNT(DISTINCT document_id) FILTER (
        WHERE document_status='COMPLETED'
          AND pdf IS NOT NULL
          AND length(pdf)>0
      )::int AS complete_documents,
      COUNT(job_id)::int AS total_jobs,
      COUNT(job_id) FILTER (
        WHERE job_status='PENDING'
      )::int AS queued_jobs,
      COUNT(job_id) FILTER (
        WHERE job_status='PRINTING'
      )::int AS printing_jobs,
      COUNT(job_id) FILTER (
        WHERE job_status='PRINTED'
      )::int AS printed_jobs,
      COUNT(job_id) FILTER (
        WHERE job_status IN ('FAILED','ERROR')
      )::int AS failed_jobs,
      COUNT(job_id) FILTER (
        WHERE job_status NOT IN (
          'PENDING','PRINTING','PRINTED','FAILED','ERROR'
        )
      )::int AS other_jobs
    FROM joined
    GROUP BY document_type,label_mode
    ORDER BY document_type,label_mode NULLS FIRST
    `,
    [orderId]
  );

  return result.rows;
}

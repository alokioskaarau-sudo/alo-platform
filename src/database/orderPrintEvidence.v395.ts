
import { db } from "./db.js";
import type { PoolClient } from "pg";

export type OrderPrintEvidenceV395 = {
  label_mode: string;
  label_count: number;
  complete_labels: number;
  queued_jobs: number;
  printing_jobs: number;
  printed_jobs: number;
  failed_jobs: number;
  total_jobs: number;
  recovery_status: string;
};

/**
 * Diagnostik, keine Druck- oder Retry-Freigabe.
 * Status PRINTED ist ein Datenbanknachweis,
 * kein unabhängiger Beweis für physische Ausgabe.
 */
export async function getOrderPrintEvidenceV395(
  orderId: string,
  client?: PoolClient
): Promise<OrderPrintEvidenceV395[]> {
  if (!/^gid:\/\/shopify\/Order\/[1-9][0-9]*$/.test(orderId)) {
    throw new Error("INVALID_SHOPIFY_ORDER_ID");
  }

  const executor = client ?? db;

  const result = await executor.query<OrderPrintEvidenceV395>(
    `
    WITH labels AS (
      SELECT id, label_mode, status, label_pdf_base64
      FROM shipping_labels
      WHERE shopify_order_id=$1
    ),
    grouped AS (
      SELECT
        l.label_mode,
        COUNT(DISTINCT l.id)::int AS label_count,
        COUNT(DISTINCT l.id) FILTER (
          WHERE l.status='COMPLETED'
            AND l.label_pdf_base64 IS NOT NULL
            AND length(l.label_pdf_base64)>0
        )::int AS complete_labels,
        COUNT(p.id) FILTER (
          WHERE p.status='PENDING'
        )::int AS queued_jobs,
        COUNT(p.id) FILTER (
          WHERE p.status='PRINTING'
        )::int AS printing_jobs,
        COUNT(p.id) FILTER (
          WHERE p.status='PRINTED'
        )::int AS printed_jobs,
        COUNT(p.id) FILTER (
          WHERE p.status IN ('FAILED','ERROR')
        )::int AS failed_jobs,
        COUNT(p.id)::int AS total_jobs
      FROM labels l
      LEFT JOIN print_jobs p
        ON p.shipping_label_id=l.id
       AND p.document_type='SHIPPING_LABEL'
      GROUP BY l.label_mode
    )
    SELECT *,
      CASE
        WHEN label_count>1
          THEN 'MULTIPLE_LABELS_REVIEW'
        WHEN complete_labels=0
          THEN 'LABEL_INCOMPLETE'
        WHEN total_jobs>1
          THEN 'MULTIPLE_PRINT_JOBS_REVIEW'
        WHEN failed_jobs>0
          THEN 'PRINT_FAILED_REVIEW'
        WHEN printed_jobs>0
          THEN 'PRINT_RECORDED'
        WHEN printing_jobs>0
          THEN 'PRINT_IN_PROGRESS'
        WHEN queued_jobs>0
          THEN 'PRINT_QUEUED'
        ELSE 'PRINT_JOB_MISSING'
      END AS recovery_status
    FROM grouped
    ORDER BY label_mode
    `,
    [orderId]
  );

  return result.rows;
}

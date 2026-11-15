
import { db } from "./db.js";

export type OrderRecoverySnapshotV388 = {
  order_id: string;
  order_channel: string | null;
  webhook_count: number;
  pending_count: number;
  processing_count: number;
  completed_count: number;
  error_count: number;
  packing_slips: number;
  complete_packing_slips: number;
  invoices: number;
  complete_invoices: number;
  packing_print_jobs: number;
  fulfillment_exists: boolean;
  delivery_exists: boolean;
  push_events: number;
  recovery_status: string;
};

/**
 * V388: Nur Lesezugriffe. Keine Bestellungen starten.
 * Die Rückgabe ist Diagnose, keine Freigabe zum Retry.
 */
export async function listOrderRecoverySnapshotsV388(
  limit = 50,
  client?: import("pg").PoolClient,
  orderId?: string
): Promise<OrderRecoverySnapshotV388[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new Error("INVALID_RECOVERY_LIMIT");
  }

  const executor = client ?? db;
  const result = await executor.query<OrderRecoverySnapshotV388>(
    `
    WITH webhook_summary AS (
      SELECT
        shopify_order_id AS order_id,
        COUNT(*)::int AS webhook_count,
        COUNT(*) FILTER (
          WHERE status='PENDING'
        )::int AS pending_count,
        COUNT(*) FILTER (
          WHERE status='PROCESSING'
        )::int AS processing_count,
        COUNT(*) FILTER (
          WHERE status='COMPLETED'
        )::int AS completed_count,
        COUNT(*) FILTER (
          WHERE status IN ('FAILED','NEEDS_REVIEW')
        )::int AS error_count,
        MIN(received_at) AS first_received
      FROM shopify_webhook_events
      WHERE topic='orders/paid'
        AND shopify_order_id IS NOT NULL
      GROUP BY shopify_order_id
    ),
    slips AS (
      SELECT
        shopify_order_id AS order_id,
        COUNT(DISTINCT ps.id)::int AS total,
        COUNT(DISTINCT ps.id) FILTER (
          WHERE ps.pdf_base64 IS NOT NULL
            AND length(ps.pdf_base64)>0
        )::int AS complete,
        COUNT(pj.id)::int AS print_jobs
      FROM packing_slips ps
      LEFT JOIN print_jobs pj
        ON pj.packing_slip_id=ps.id
       AND pj.document_type='PACKING_SLIP'
      GROUP BY shopify_order_id
    ),
    invoice_summary AS (
      SELECT
        shopify_order_id AS order_id,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (
          WHERE pdf_base64 IS NOT NULL
            AND length(pdf_base64)>0
        )::int AS complete
      FROM invoices
      GROUP BY shopify_order_id
    ),
    pushes AS (
      SELECT
        shopify_order_id AS order_id,
        COUNT(*)::int AS total
      FROM staff_push_events
      GROUP BY shopify_order_id
    )
    SELECT
      w.order_id,
      a.fulfillment_type AS order_channel,
      w.webhook_count,
      w.pending_count,
      w.processing_count,
      w.completed_count,
      w.error_count,
      COALESCE(s.total,0)::int AS packing_slips,
      COALESCE(s.complete,0)::int AS complete_packing_slips,
      COALESCE(i.total,0)::int AS invoices,
      COALESCE(i.complete,0)::int AS complete_invoices,
      COALESCE(s.print_jobs,0)::int AS packing_print_jobs,
      (f.shopify_order_id IS NOT NULL) AS fulfillment_exists,
      (d.shopify_order_id IS NOT NULL) AS delivery_exists,
      COALESCE(p.total,0)::int AS push_events,
      CASE
        WHEN COALESCE(s.total,0)>1
          OR COALESCE(i.total,0)>1
          OR COALESCE(s.print_jobs,0)>1
          THEN 'DUPLICATE_ARTIFACTS_REVIEW'
        WHEN w.error_count>0
          THEN 'FAILED_RECONCILIATION'
        WHEN w.processing_count>0
          THEN 'PROCESSING_RECONCILIATION'
        WHEN w.completed_count>0
          AND (
            a.fulfillment_type IS NULL
            OR a.fulfillment_type NOT IN (
              'ALO_NOW', 'PICKUP', 'SHIPPING'
            )
          )
          THEN 'CHANNEL_REVIEW_REQUIRED'
        WHEN w.completed_count>0
          AND a.fulfillment_type='ALO_NOW'
          AND (
            COALESCE(s.complete,0)=0
            OR COALESCE(i.complete,0)=0
            OR f.shopify_order_id IS NULL
            OR d.shopify_order_id IS NULL
          )
          THEN 'COMPLETED_ARTIFACTS_REVIEW'
        WHEN w.completed_count>0
          AND a.fulfillment_type='ALO_NOW'
          THEN 'COMPLETED_EVIDENCE_REVIEW'
        WHEN w.completed_count>0
          THEN 'CHANNEL_SPECIFIC_REVIEW'
        WHEN w.pending_count>0
          THEN 'PENDING_RECONCILIATION'
        ELSE 'MANUAL_RECONCILIATION'
      END AS recovery_status
    FROM webhook_summary w
    LEFT JOIN slips s ON s.order_id=w.order_id
    LEFT JOIN invoice_summary i ON i.order_id=w.order_id
    LEFT JOIN order_alerts a
      ON a.shopify_order_id=w.order_id
    LEFT JOIN order_fulfillment_workflow f
      ON f.shopify_order_id=w.order_id
    LEFT JOIN alo_now_deliveries d
      ON d.shopify_order_id=w.order_id
    LEFT JOIN pushes p ON p.order_id=w.order_id
    WHERE ($2::text IS NULL OR w.order_id=$2)
    ORDER BY w.first_received
    LIMIT $1
    `,
    [limit, orderId ?? null]
  );

  return result.rows;
}


/**
 * V390: Read-only Einzelbestellungs-Recovery.
 *
 * Keine Statusänderung, kein automatischer Retry.
 * Rückgabe null bedeutet: keine orders/paid-Evidenz gefunden.
 */
export async function getOrderRecoverySnapshotV390(
  orderId: string,
  client?: import("pg").PoolClient
): Promise<OrderRecoverySnapshotV388 | null> {
  if (
    !/^gid:\/\/shopify\/Order\/[1-9][0-9]*$/.test(orderId)
  ) {
    throw new Error("INVALID_SHOPIFY_ORDER_ID");
  }

  const snapshots = await listOrderRecoverySnapshotsV388(
    1,
    client,
    orderId
  );

  return snapshots[0] ?? null;
}

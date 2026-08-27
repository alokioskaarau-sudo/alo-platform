import { db } from "./db.js";

export async function initializeDatabase() {
  // ==========================================================
  // SHIPPING LABELS
  // ==========================================================

  await db.query(`
    CREATE TABLE IF NOT EXISTS shipping_labels (
      id BIGSERIAL PRIMARY KEY,

      shopify_order_id TEXT NOT NULL,
      shopify_order_name TEXT NOT NULL,

      swisspost_ident_code TEXT,

      label_mode TEXT NOT NULL DEFAULT 'SPECIMEN',
      service TEXT NOT NULL DEFAULT 'ECO',

      weight_grams INTEGER,
      address_quality TEXT,

      status TEXT NOT NULL DEFAULT 'RESERVED',

      label_pdf_base64 TEXT,
      error_message TEXT,

      shopify_fulfillment_order_id TEXT,
      shopify_fulfillment_id TEXT,

      tracking_number TEXT,

      shipment_status TEXT NOT NULL DEFAULT 'LABEL_PENDING',

      print_status TEXT NOT NULL DEFAULT 'NOT_PRINTED',
      print_count INTEGER NOT NULL DEFAULT 0,
      printer_name TEXT,
      printed_at TIMESTAMPTZ,

      fulfilled_at TIMESTAMPTZ,

      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);


  // ==========================================================
  // MIGRATIONS FÜR BEREITS EXISTIERENDE DATENBANK
  // ==========================================================

  await db.query(`
    ALTER TABLE shipping_labels
    ADD COLUMN IF NOT EXISTS label_pdf_base64 TEXT;
  `);

  await db.query(`
    ALTER TABLE shipping_labels
    ADD COLUMN IF NOT EXISTS error_message TEXT;
  `);

  await db.query(`
    ALTER TABLE shipping_labels
    ADD COLUMN IF NOT EXISTS label_mode TEXT
    NOT NULL DEFAULT 'SPECIMEN';
  `);

  await db.query(`
    ALTER TABLE shipping_labels
    ADD COLUMN IF NOT EXISTS service TEXT
    NOT NULL DEFAULT 'ECO';
  `);

  await db.query(`
    ALTER TABLE shipping_labels
    ADD COLUMN IF NOT EXISTS weight_grams INTEGER;
  `);

  await db.query(`
    ALTER TABLE shipping_labels
    ADD COLUMN IF NOT EXISTS address_quality TEXT;
  `);

  await db.query(`
    ALTER TABLE shipping_labels
    ADD COLUMN IF NOT EXISTS status TEXT
    NOT NULL DEFAULT 'RESERVED';
  `);

  await db.query(`
    ALTER TABLE shipping_labels
    ADD COLUMN IF NOT EXISTS
    shopify_fulfillment_order_id TEXT;
  `);

  await db.query(`
    ALTER TABLE shipping_labels
    ADD COLUMN IF NOT EXISTS
    shopify_fulfillment_id TEXT;
  `);

  await db.query(`
    ALTER TABLE shipping_labels
    ADD COLUMN IF NOT EXISTS tracking_number TEXT;
  `);

  await db.query(`
    ALTER TABLE shipping_labels
    ADD COLUMN IF NOT EXISTS shipment_status TEXT
    NOT NULL DEFAULT 'LABEL_PENDING';
  `);

  await db.query(`
    ALTER TABLE shipping_labels
    ADD COLUMN IF NOT EXISTS print_status TEXT
    NOT NULL DEFAULT 'NOT_PRINTED';
  `);

  await db.query(`
    ALTER TABLE shipping_labels
    ADD COLUMN IF NOT EXISTS print_count INTEGER
    NOT NULL DEFAULT 0;
  `);

  await db.query(`
    ALTER TABLE shipping_labels
    ADD COLUMN IF NOT EXISTS printer_name TEXT;
  `);

  await db.query(`
    ALTER TABLE shipping_labels
    ADD COLUMN IF NOT EXISTS printed_at TIMESTAMPTZ;
  `);

  await db.query(`
    ALTER TABLE shipping_labels
    ADD COLUMN IF NOT EXISTS fulfilled_at TIMESTAMPTZ;
  `);

  await db.query(`
    ALTER TABLE shipping_labels
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ
    NOT NULL DEFAULT NOW();
  `);


  // ==========================================================
  // INDIZES
  // ==========================================================

  await db.query(`
    DROP INDEX IF EXISTS
    shipping_labels_order_mode_unique;
  `);

  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS
      shipping_labels_order_mode_unique
    ON shipping_labels (
      shopify_order_id,
      label_mode
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS
      shipping_labels_ident_code_idx
    ON shipping_labels (
      swisspost_ident_code
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS
      shipping_labels_tracking_number_idx
    ON shipping_labels (
      tracking_number
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS
      shipping_labels_shipment_status_idx
    ON shipping_labels (
      shipment_status
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS
      shipping_labels_print_status_idx
    ON shipping_labels (
      print_status
    );
  `);


  // ==========================================================
  // PRINT JOBS
  // ==========================================================

  await db.query(`
    CREATE TABLE IF NOT EXISTS print_jobs (
      id BIGSERIAL PRIMARY KEY,

      shipping_label_id BIGINT NOT NULL
        REFERENCES shipping_labels(id)
        ON DELETE CASCADE,

      printer_name TEXT,

      status TEXT NOT NULL DEFAULT 'PENDING',

      attempts INTEGER NOT NULL DEFAULT 0,

      error_message TEXT,

      requested_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW(),

      started_at TIMESTAMPTZ,

      printed_at TIMESTAMPTZ,

      updated_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS
      print_jobs_status_idx
    ON print_jobs (
      status
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS
      print_jobs_shipping_label_idx
    ON print_jobs (
      shipping_label_id
    );
  `);


  console.log(
    "PostgreSQL: Shipping + Print Queue bereit."
  );
}

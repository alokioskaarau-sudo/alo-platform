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
  // SHIPPING LABEL INDIZES
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
  // PACKING SLIPS / LIEFERSCHEINE
  // ==========================================================

  await db.query(`
    CREATE TABLE IF NOT EXISTS packing_slips (

      id BIGSERIAL PRIMARY KEY,

      shopify_order_id TEXT NOT NULL,

      shopify_order_name TEXT NOT NULL,

      pdf_base64 TEXT,

      status TEXT NOT NULL DEFAULT 'PENDING',

      print_status TEXT NOT NULL DEFAULT 'NOT_PRINTED',

      print_count INTEGER NOT NULL DEFAULT 0,

      printer_name TEXT,

      printed_at TIMESTAMPTZ,

      error_message TEXT,

      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()

    );
  `);

  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS
      packing_slips_order_unique
    ON packing_slips (
      shopify_order_id
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS
      packing_slips_print_status_idx
    ON packing_slips (
      print_status
    );
  `);

  // ==========================================================
  // INVOICES / RECHNUNGSARCHIV
  // ==========================================================

  await db.query(`
    CREATE TABLE IF NOT EXISTS invoices (
      id BIGSERIAL PRIMARY KEY,
      invoice_number TEXT NOT NULL,
      shopify_order_id TEXT NOT NULL,
      shopify_order_name TEXT NOT NULL,
      order_created_at TIMESTAMPTZ,
      currency TEXT NOT NULL DEFAULT 'CHF',
      subtotal_amount NUMERIC(14,2),
      discount_amount NUMERIC(14,2),
      shipping_amount NUMERIC(14,2),
      tax_amount NUMERIC(14,2),
      total_amount NUMERIC(14,2),
      pdf_base64 TEXT,
      status TEXT NOT NULL DEFAULT 'PENDING',
      print_status TEXT NOT NULL DEFAULT 'NOT_PRINTED',
      print_count INTEGER NOT NULL DEFAULT 0,
      printer_name TEXT,
      printed_at TIMESTAMPTZ,
      error_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS
      invoices_invoice_number_unique
    ON invoices (
      invoice_number
    );
  `);

  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS
      invoices_order_unique
    ON invoices (
      shopify_order_id
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS
      invoices_created_at_idx
    ON invoices (
      created_at
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS
      invoices_print_status_idx
    ON invoices (
      print_status
    );
  `);

  // ==========================================================
  // PRINT JOBS
  // ==========================================================

  await db.query(`
    CREATE TABLE IF NOT EXISTS print_jobs (

      id BIGSERIAL PRIMARY KEY,

      shipping_label_id BIGINT
        REFERENCES shipping_labels(id)
        ON DELETE CASCADE,

      packing_slip_id BIGINT
        REFERENCES packing_slips(id)
        ON DELETE CASCADE,

      invoice_id BIGINT
        REFERENCES invoices(id)
        ON DELETE CASCADE,

      printer_name TEXT,

      document_type TEXT
        NOT NULL DEFAULT 'SHIPPING_LABEL',

      status TEXT
        NOT NULL DEFAULT 'PENDING',

      attempts INTEGER
        NOT NULL DEFAULT 0,

      error_message TEXT,

      requested_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW(),

      started_at TIMESTAMPTZ,

      printed_at TIMESTAMPTZ,

      updated_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW()
    );
  `);

  // ==========================================================
  // MIGRATION FÜR BESTEHENDE PRINT JOBS
  // ==========================================================

  await db.query(`
    ALTER TABLE print_jobs
    ALTER COLUMN shipping_label_id DROP NOT NULL;
  `);

  await db.query(`
    ALTER TABLE print_jobs
    ADD COLUMN IF NOT EXISTS document_type TEXT
    NOT NULL DEFAULT 'SHIPPING_LABEL';
  `);

  await db.query(`
    ALTER TABLE print_jobs
    ADD COLUMN IF NOT EXISTS packing_slip_id BIGINT
    REFERENCES packing_slips(id)
    ON DELETE CASCADE;
  `);

  await db.query(`
    ALTER TABLE print_jobs
    ADD COLUMN IF NOT EXISTS invoice_id BIGINT
    REFERENCES invoices(id)
    ON DELETE CASCADE;
  `);

  // ==========================================================
  // PRINT JOB INDIZES
  // ==========================================================

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

  await db.query(`
    CREATE INDEX IF NOT EXISTS
      print_jobs_packing_slip_idx
    ON print_jobs (
      packing_slip_id
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS
      print_jobs_invoice_idx
    ON print_jobs (
      invoice_id
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS
      print_jobs_document_type_idx
    ON print_jobs (
      document_type
    );
  `);

  // ==========================================================
  // PRINTERS
  // ==========================================================

  await db.query(`
    CREATE TABLE IF NOT EXISTS printers (
      id BIGSERIAL PRIMARY KEY,

      name TEXT NOT NULL UNIQUE,

      display_name TEXT,

      location TEXT,

      platform TEXT,

      status TEXT
        NOT NULL
        DEFAULT 'OFFLINE',

      is_default BOOLEAN
        NOT NULL
        DEFAULT FALSE,

      agent_version TEXT,

      device_name TEXT,

      driver_name TEXT,

      port_name TEXT,

      paper_size TEXT,

      capabilities JSONB
        NOT NULL
        DEFAULT '{}'::jsonb,

      last_error TEXT,

      last_seen_at TIMESTAMPTZ,

      created_at TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW(),

      updated_at TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW()
    );
  `);

  // ==========================================================
  // PRINTER MIGRATIONS
  // ==========================================================

  await db.query(`
    ALTER TABLE printers
    ADD COLUMN IF NOT EXISTS display_name TEXT;
  `);

  await db.query(`
    ALTER TABLE printers
    ADD COLUMN IF NOT EXISTS location TEXT;
  `);

  await db.query(`
    ALTER TABLE printers
    ADD COLUMN IF NOT EXISTS platform TEXT;
  `);

  await db.query(`
    ALTER TABLE printers
    ADD COLUMN IF NOT EXISTS status TEXT
    NOT NULL DEFAULT 'OFFLINE';
  `);

  await db.query(`
    ALTER TABLE printers
    ADD COLUMN IF NOT EXISTS is_default BOOLEAN
    NOT NULL DEFAULT FALSE;
  `);

  await db.query(`
    ALTER TABLE printers
    ADD COLUMN IF NOT EXISTS agent_version TEXT;
  `);

  await db.query(`
    ALTER TABLE printers
    ADD COLUMN IF NOT EXISTS device_name TEXT;
  `);

  await db.query(`
    ALTER TABLE printers
    ADD COLUMN IF NOT EXISTS driver_name TEXT;
  `);

  await db.query(`
    ALTER TABLE printers
    ADD COLUMN IF NOT EXISTS port_name TEXT;
  `);

  await db.query(`
    ALTER TABLE printers
    ADD COLUMN IF NOT EXISTS paper_size TEXT;
  `);

  await db.query(`
    ALTER TABLE printers
    ADD COLUMN IF NOT EXISTS capabilities JSONB
    NOT NULL DEFAULT '{}'::jsonb;
  `);

  await db.query(`
    ALTER TABLE printers
    ADD COLUMN IF NOT EXISTS last_error TEXT;
  `);

  await db.query(`
    ALTER TABLE printers
    ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
  `);

  await db.query(`
    ALTER TABLE printers
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ
    NOT NULL DEFAULT NOW();
  `);

  await db.query(`
    ALTER TABLE printers
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ
    NOT NULL DEFAULT NOW();
  `);

  // ==========================================================
  // PRINTER INDIZES
  // ==========================================================

  await db.query(`
    CREATE INDEX IF NOT EXISTS
      printers_status_idx
    ON printers (
      status
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS
      printers_default_idx
    ON printers (
      is_default
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS
      printers_location_idx
    ON printers (
      location
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS
      printers_last_seen_idx
    ON printers (
      last_seen_at
    );
  `);

  // ==========================================================
  // ORDER DISCOUNT CODES / LIEFERSCHEIN-RABATTE
  // ==========================================================

  await db.query(`
    CREATE TABLE IF NOT EXISTS order_discount_codes (
      id BIGSERIAL PRIMARY KEY,

      shopify_order_id TEXT NOT NULL,
      shopify_order_name TEXT NOT NULL,

      code TEXT NOT NULL,
      shopify_discount_id TEXT,

      percentage NUMERIC(5,4)
        NOT NULL DEFAULT 0.1500,

      status TEXT
        NOT NULL DEFAULT 'PENDING',

      error_message TEXT,

      created_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW(),

      updated_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS
      order_discount_codes_order_unique
    ON order_discount_codes (
      shopify_order_id
    );
  `);

  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS
      order_discount_codes_code_unique
    ON order_discount_codes (
      code
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS
      order_discount_codes_status_idx
    ON order_discount_codes (
      status
    );
  `);

  // ==========================================================
  // SHOPIFY WEBHOOK EVENTS
  // ==========================================================

  await db.query(`
    CREATE TABLE IF NOT EXISTS shopify_webhook_events (
      id BIGSERIAL PRIMARY KEY,

      webhook_id TEXT NOT NULL UNIQUE,

      topic TEXT NOT NULL,

      shop_domain TEXT,

      shopify_order_id TEXT NOT NULL,

      shopify_order_name TEXT,

      status TEXT
        NOT NULL
        DEFAULT 'PENDING',

      attempts INTEGER
        NOT NULL
        DEFAULT 0,

      error_message TEXT,

      received_at TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW(),

      processing_started_at TIMESTAMPTZ,

      processed_at TIMESTAMPTZ,

      updated_at TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS
      shopify_webhook_events_status_idx
    ON shopify_webhook_events (
      status
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS
      shopify_webhook_events_order_idx
    ON shopify_webhook_events (
      shopify_order_id
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS
      shopify_webhook_events_received_idx
    ON shopify_webhook_events (
      received_at
    );
  `);

  // ==========================================================
  // FERTIG
  // ==========================================================

  console.log(
    "PostgreSQL: Shipping + Print Queue + Printers + Webhooks bereit."
  );
}

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
  // ORDER DASHBOARD FLAGS / ARCHIV
  //
  // Dashboard-Metadaten werden bewusst getrennt von
  // Rechnungen, Lieferscheinen und Versandlabels gespeichert.
  // Dadurch bleiben ausgestellte Dokumente unverändert.
  // ==========================================================

  await db.query(`
    CREATE TABLE IF NOT EXISTS order_dashboard_flags (
      shopify_order_id TEXT PRIMARY KEY,
      is_archived BOOLEAN NOT NULL DEFAULT FALSE,
      is_test BOOLEAN NOT NULL DEFAULT FALSE,
      archived_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS
      order_dashboard_flags_archived_idx
    ON order_dashboard_flags (
      is_archived
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS
      order_dashboard_flags_test_idx
    ON order_dashboard_flags (
      is_test
    );
  `);

  // ==========================================================
  // ORDER PACK ITEMS
  //
  // Persistenter Packfortschritt pro Shopify Line Item.
  // Die Shopify Line-Item-ID ist die technische Identität.
  // ==========================================================

  await db.query(`
    CREATE TABLE IF NOT EXISTS order_pack_items (
      shopify_order_id TEXT NOT NULL,
      shopify_line_item_id TEXT NOT NULL,

      title TEXT NOT NULL,
      variant_title TEXT,
      sku TEXT,

      expected_quantity INTEGER
        NOT NULL
        CHECK (expected_quantity >= 0),

      packed_quantity INTEGER
        NOT NULL
        DEFAULT 0
        CHECK (packed_quantity >= 0),

      unavailable_quantity INTEGER
        NOT NULL
        DEFAULT 0
        CHECK (unavailable_quantity >= 0),

      unavailable_reason TEXT,

      unavailable_by_staff_user_id TEXT,

      unavailable_at TIMESTAMPTZ,

      shopify_inventory_item_id TEXT,

      inventory_zero_sync_status TEXT
        CHECK (
          inventory_zero_sync_status IS NULL
          OR inventory_zero_sync_status IN (
            'PENDING',
            'SYNCED',
            'FAILED'
          )
        ),

      inventory_zero_synced_at TIMESTAMPTZ,

      inventory_zero_error TEXT,

      last_packed_by_staff_user_id TEXT,
      last_packed_at TIMESTAMPTZ,

      created_at TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW(),

      updated_at TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW(),

      PRIMARY KEY (
        shopify_order_id,
        shopify_line_item_id
      ),

      CHECK (
        packed_quantity <= expected_quantity
      )
    );
  `);

  await db.query(`
    ALTER TABLE order_pack_items
      ADD COLUMN IF NOT EXISTS unavailable_quantity INTEGER
        NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS unavailable_reason TEXT,
      ADD COLUMN IF NOT EXISTS unavailable_by_staff_user_id TEXT,
      ADD COLUMN IF NOT EXISTS unavailable_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS shopify_inventory_item_id TEXT,
      ADD COLUMN IF NOT EXISTS inventory_zero_sync_status TEXT,
      ADD COLUMN IF NOT EXISTS inventory_zero_synced_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS inventory_zero_error TEXT;
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS
      order_pack_items_order_idx
    ON order_pack_items (
      shopify_order_id
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS
      order_pack_items_incomplete_idx
    ON order_pack_items (
      shopify_order_id,
      packed_quantity,
      expected_quantity
    );
  `);


  // ==========================================================
  // ORDER FULFILLMENT WORKFLOW
  //
  // Operativer Packstatus fuer ALO STAFF.
  // Bewusst getrennt vom technischen dashboard_status.
  // ==========================================================

  await db.query(`
    CREATE TABLE IF NOT EXISTS order_fulfillment_workflow (
      shopify_order_id TEXT PRIMARY KEY,

      pack_status TEXT
        NOT NULL
        DEFAULT 'NEW'
        CHECK (
          pack_status IN (
            'NEW',
            'PACKING',
            'PACKED',
            'READY_TO_SHIP',
            'COMPLETED'
          )
        ),

      claimed_by_staff_user_id TEXT,
      claimed_at TIMESTAMPTZ,

      packing_started_at TIMESTAMPTZ,
      packed_at TIMESTAMPTZ,
      ready_to_ship_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,

      version INTEGER NOT NULL DEFAULT 1,

      created_at TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW(),

      updated_at TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS
      order_fulfillment_workflow_status_idx
    ON order_fulfillment_workflow (
      pack_status
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS
      order_fulfillment_workflow_claimed_by_idx
    ON order_fulfillment_workflow (
      claimed_by_staff_user_id
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS
      order_fulfillment_workflow_updated_idx
    ON order_fulfillment_workflow (
      updated_at DESC
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
      shopify_order_id TEXT,
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
    ALTER TABLE shopify_webhook_events
    ALTER COLUMN shopify_order_id DROP NOT NULL
  `);

  await db.query(`
    ALTER TABLE shopify_webhook_events
    ADD COLUMN IF NOT EXISTS shopify_resource_id TEXT
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS
      shopify_webhook_events_resource_idx
    ON shopify_webhook_events (
      shopify_resource_id
    )
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

  // ORDER ALERTS
  // ==========================================================

  await db.query(`
    CREATE TABLE IF NOT EXISTS order_alerts (
      id BIGSERIAL PRIMARY KEY,

      shopify_order_id TEXT NOT NULL UNIQUE,

      shopify_order_name TEXT NOT NULL,

      total_amount NUMERIC(12, 2)
        NOT NULL DEFAULT 0,

      currency_code TEXT
        NOT NULL DEFAULT 'CHF',

      fulfillment_type TEXT
        NOT NULL DEFAULT 'ORDER',

      items JSONB
        NOT NULL DEFAULT '[]'::jsonb,

      status TEXT
        NOT NULL DEFAULT 'PENDING',

      claimed_at TIMESTAMPTZ,

      completed_at TIMESTAMPTZ,

      created_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW(),

      updated_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS
      order_alerts_status_idx
    ON order_alerts (
      status
    );
  `);

  // ==========================================================
  // ALO STAFF ACCOUNTS
  // ==========================================================
  await db.query(`
    CREATE TABLE IF NOT EXISTS staff_users (
      id BIGSERIAL PRIMARY KEY,
      username TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'STAFF',
      password_hash TEXT,
      pin_hash TEXT,
      default_workspace TEXT NOT NULL DEFAULT 'ONLINE',
      allowed_workspaces JSONB NOT NULL DEFAULT '[]'::jsonb,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      token_version INTEGER NOT NULL DEFAULT 1,
      last_login_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      CONSTRAINT staff_users_role_check
        CHECK (
          role IN (
            'ADMIN',
            'MANAGER',
            'STAFF',
            'PRAKTIKANT'
          )
        ),

      CONSTRAINT staff_users_default_workspace_check
        CHECK (
          default_workspace IN (
            'AARAU',
            'OLTEN',
            'ONLINE'
          )
        )
    );
  `);

  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS
      staff_users_username_unique
    ON staff_users (
      LOWER(username)
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS
      staff_users_active_idx
    ON staff_users (
      active
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS staff_sessions (
      id BIGSERIAL PRIMARY KEY,
      staff_user_id BIGINT NOT NULL
        REFERENCES staff_users(id)
        ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      device_name TEXT,
      device_platform TEXT,
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS
      staff_sessions_user_idx
    ON staff_sessions (
      staff_user_id
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS
      staff_sessions_token_active_idx
    ON staff_sessions (
      token_hash,
      expires_at
    )
    WHERE revoked_at IS NULL;
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS staff_enrollment_tokens (
      id BIGSERIAL PRIMARY KEY,
      staff_user_id BIGINT NOT NULL
        REFERENCES staff_users(id)
        ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      purpose TEXT NOT NULL DEFAULT 'FIRST_PIN',
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      created_by_staff_user_id BIGINT
        REFERENCES staff_users(id)
        ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT staff_enrollment_tokens_purpose_check
        CHECK (
          purpose IN (
            'FIRST_PIN'
          )
        )
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS
      staff_enrollment_tokens_user_idx
    ON staff_enrollment_tokens (
      staff_user_id,
      created_at DESC
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS
      staff_enrollment_tokens_active_idx
    ON staff_enrollment_tokens (
      token_hash,
      expires_at
    )
    WHERE used_at IS NULL;
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS staff_activity (
      id BIGSERIAL PRIMARY KEY,
      staff_user_id BIGINT
        REFERENCES staff_users(id)
        ON DELETE SET NULL,
      workspace TEXT,
      action TEXT NOT NULL,
      entity_type TEXT,
      entity_id TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      CONSTRAINT staff_activity_workspace_check
        CHECK (
          workspace IS NULL OR
          workspace IN (
            'AARAU',
            'OLTEN',
            'ONLINE'
          )
        )
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS
      staff_activity_user_created_idx
    ON staff_activity (
      staff_user_id,
      created_at DESC
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS staff_push_tokens (
      id BIGSERIAL PRIMARY KEY,
      staff_user_id BIGINT NOT NULL
        REFERENCES staff_users(id)
        ON DELETE CASCADE,
      staff_session_id BIGINT
        REFERENCES staff_sessions(id)
        ON DELETE SET NULL,
      expo_push_token TEXT NOT NULL UNIQUE,
      platform TEXT NOT NULL,
      device_name TEXT,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      last_registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      disabled_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT staff_push_tokens_platform_check
        CHECK (
          platform IN (
            'ios',
            'android'
          )
        )
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS
      staff_push_tokens_active_idx
    ON staff_push_tokens (
      active
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS
      staff_push_tokens_user_idx
    ON staff_push_tokens (
      staff_user_id,
      active
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS staff_push_events (
      id BIGSERIAL PRIMARY KEY,
      event_key TEXT NOT NULL UNIQUE,
      event_type TEXT NOT NULL,
      shopify_order_id TEXT,
      status TEXT NOT NULL DEFAULT 'PENDING',
      sent_at TIMESTAMPTZ,
      error_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT staff_push_events_status_check
        CHECK (
          status IN (
            'PENDING',
            'SENT',
            'FAILED'
          )
        )
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS
      staff_push_events_order_idx
    ON staff_push_events (
      shopify_order_id,
      created_at DESC
    );
  `);

  // ==========================================================
  // ALO PRODUCT MASTER
  // ==========================================================

  await db.query(`
    CREATE TABLE IF NOT EXISTS products (
      id BIGSERIAL PRIMARY KEY,
      barcode TEXT UNIQUE,
      title TEXT NOT NULL,
      brand TEXT,
      product_name TEXT,
      flavor TEXT,
      unit_size TEXT,
      category TEXT,
      subcategory TEXT,
      country TEXT,
      short_description TEXT,
      description_html TEXT,
      ingredients TEXT,
      allergens TEXT,
      nutrition TEXT,
      nutrition_per_100 JSONB NOT NULL DEFAULT '{}'::jsonb,
      dietary JSONB NOT NULL DEFAULT '{}'::jsonb,
      tags JSONB NOT NULL DEFAULT '[]'::jsonb,
      search_keywords JSONB NOT NULL DEFAULT '[]'::jsonb,
      seo_title TEXT,
      seo_description TEXT,
      vendor TEXT,
      product_type TEXT,
      confidence DOUBLE PRECISION,
      field_confidence JSONB NOT NULL DEFAULT '{}'::jsonb,
      warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
      review_status TEXT NOT NULL DEFAULT 'DRAFT',
      reviewed_by TEXT,
      reviewed_at TIMESTAMPTZ,
      shopify_status TEXT NOT NULL DEFAULT 'NOT_SYNCED',
      shopify_product_id TEXT,
      shopify_variant_id TEXT,
      shopify_inventory_item_id TEXT,
      source_type TEXT,
      source_data JSONB NOT NULL DEFAULT '{}'::jsonb,
      ai_draft JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS
      products_shopify_product_id_unique
    ON products (shopify_product_id)
    WHERE shopify_product_id IS NOT NULL
  `);

  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS
      products_shopify_variant_id_unique
    ON products (shopify_variant_id)
    WHERE shopify_variant_id IS NOT NULL
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS
      products_title_idx
    ON products (
      title
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS
      products_brand_idx
    ON products (
      brand
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS
      products_shopify_status_idx
    ON products (
      shopify_status
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS product_versions (
      id BIGSERIAL PRIMARY KEY,
      product_id BIGINT NOT NULL
        REFERENCES products(id)
        ON DELETE CASCADE,
      snapshot JSONB NOT NULL,
      changed_by TEXT,
      change_source TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS
      product_versions_product_idx
    ON product_versions (
      product_id,
      created_at DESC
    );
  `);

  // ==========================================================
  // FERTIG
  // ==========================================================

  console.log(
    "PostgreSQL: Shipping + Print Queue + Printers + Webhooks bereit."
  );
}

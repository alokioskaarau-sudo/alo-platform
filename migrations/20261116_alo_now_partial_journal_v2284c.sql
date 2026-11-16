-- ALO NOW V2284C: candidate schema reconstructed from V1589/V1592/V1645.
-- NOT automatically applied. Requires production compatibility review.
-- This migration only creates missing partial-fulfillment tables.
CREATE TABLE alo_now_partial_selections_v1586 (
    shopify_order_id TEXT PRIMARY KEY,
    driver_user_id BIGINT NOT NULL CHECK (driver_user_id > 0),
    selection_hash TEXT NOT NULL CHECK (selection_hash ~ '^[a-f0-9]{64}$'),
    expected_fulfillments JSONB NOT NULL CHECK (jsonb_typeof(expected_fulfillments) = 'array'),
    selected_lines JSONB NOT NULL CHECK (jsonb_typeof(selected_lines) = 'array'),
    withheld_lines JSONB NOT NULL CHECK (jsonb_typeof(withheld_lines) = 'array'),
    state TEXT NOT NULL DEFAULT 'PREPARED' CHECK (state IN ('PREPARED', 'IN_PROGRESS')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE alo_now_fulfillment_journal_v1586 (
    shopify_order_id TEXT NOT NULL REFERENCES alo_now_partial_selections_v1586(shopify_order_id),
    fulfillment_order_id TEXT NOT NULL,
    selection_hash TEXT NOT NULL CHECK (selection_hash ~ '^[a-f0-9]{64}$'),
    payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
    fulfillment_lines JSONB NOT NULL CHECK (jsonb_typeof(fulfillment_lines) = 'array'),
    state TEXT NOT NULL DEFAULT 'PREPARED' CHECK (state IN ('PREPARED', 'DISPATCHING', 'CONFIRMED', 'RECONCILE_REQUIRED')),
    dispatch_started_at TIMESTAMPTZ,
    shopify_fulfillment_id TEXT UNIQUE,
    confirmed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (shopify_order_id, fulfillment_order_id)
);
CREATE INDEX alo_now_fulfillment_journal_v1586_state_idx
ON alo_now_fulfillment_journal_v1586 (state, updated_at);

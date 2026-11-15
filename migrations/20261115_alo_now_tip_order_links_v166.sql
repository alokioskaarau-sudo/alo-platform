-- ALO NOW V166
-- One separate tip payment order per original delivery.
-- NOT automatically applied to production.
-- Review checkout, refunds and provider verification first.

CREATE TABLE IF NOT EXISTS alo_now_tip_order_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  request_id UUID NOT NULL UNIQUE
    REFERENCES alo_now_order_requests(id),

  original_shopify_order_id TEXT NOT NULL UNIQUE,
  tip_shopify_order_id TEXT NOT NULL UNIQUE,

  expected_amount_rappen BIGINT NOT NULL
    CHECK (
      expected_amount_rappen > 0
      AND expected_amount_rappen <= 50000
    ),

  currency TEXT NOT NULL DEFAULT 'CHF'
    CHECK (currency = 'CHF'),

  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN (
      'PENDING',
      'VERIFIED',
      'CANCELLED'
    )),

  verified_capture_reference TEXT UNIQUE,
  verified_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT alo_tip_distinct_orders_v166
    CHECK (
      original_shopify_order_id <>
      tip_shopify_order_id
    ),

  CONSTRAINT alo_tip_verified_evidence_v166
    CHECK (
      status <> 'VERIFIED'
      OR (
        verified_capture_reference IS NOT NULL
        AND verified_at IS NOT NULL
      )
    )
);

CREATE INDEX IF NOT EXISTS
  alo_now_tip_order_links_status_v166_idx
ON alo_now_tip_order_links (status, created_at);

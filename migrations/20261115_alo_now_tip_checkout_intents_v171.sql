-- ALO NOW V171
--
-- One checkout creation attempt per original request.
-- Never automatically retry uncertain Shopify writes.
-- This migration is not automatically applied.

CREATE TABLE alo_now_tip_checkout_intents_v171 (
  request_id UUID PRIMARY KEY
    REFERENCES alo_now_order_requests(id),

  checkout_reference UUID NOT NULL UNIQUE,

  original_shopify_order_id TEXT NOT NULL UNIQUE,

  amount_rappen BIGINT NOT NULL
    CHECK (
      amount_rappen >= 100
      AND amount_rappen <= 50000
    ),

  currency TEXT NOT NULL DEFAULT 'CHF'
    CHECK (currency='CHF'),

  taxable BOOLEAN NOT NULL,

  status TEXT NOT NULL DEFAULT 'RESERVED'
    CHECK (status IN (
      'RESERVED',
      'CREATE_UNCERTAIN',
      'DRAFT_CREATED',
      'CANCELLED'
    )),

  draft_order_id TEXT UNIQUE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT tip_draft_state_v171 CHECK (
    (status='DRAFT_CREATED' AND draft_order_id IS NOT NULL)
    OR
    (status<>'DRAFT_CREATED' AND draft_order_id IS NULL)
  )
);

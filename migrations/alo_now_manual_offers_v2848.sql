-- ALO NOW V2848
-- Nicht automatisch ausführen.
CREATE TABLE IF NOT EXISTS alo_now_manual_offers (
  id UUID PRIMARY KEY,
  request_id UUID NOT NULL
    REFERENCES alo_now_order_requests(id),
  version INTEGER NOT NULL CHECK (version > 0),
  status TEXT NOT NULL DEFAULT 'OFFERED'
    CHECK (status IN (
      'OFFERED', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'SUPERSEDED'
    )),
  subtotal_chf NUMERIC(12,2) NOT NULL CHECK (subtotal_chf >= 0),
  delivery_fee_chf NUMERIC(12,2) NOT NULL CHECK (delivery_fee_chf >= 0),
  extra_fee_chf NUMERIC(12,2) NOT NULL CHECK (extra_fee_chf >= 0),
  extra_reason TEXT,
  total_chf NUMERIC(12,2) NOT NULL CHECK (
    total_chf = subtotal_chf + delivery_fee_chf + extra_fee_chf
  ),
  created_by_staff_user_id BIGINT NOT NULL REFERENCES staff_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  UNIQUE (request_id, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS
  alo_now_manual_offers_one_active_v2848
ON alo_now_manual_offers(request_id)
WHERE status IN ('OFFERED','ACCEPTED');

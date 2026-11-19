-- ALO NOW V2890: explicit merchant capacity promises, no orders or payments.
-- Apply deliberately to production after reviewing the build and schema.
BEGIN;
CREATE TABLE IF NOT EXISTS public.alo_now_merchant_acceptances (
  request_id UUID PRIMARY KEY REFERENCES public.alo_now_order_requests(id) ON DELETE CASCADE,
  fulfillment_method TEXT NOT NULL CHECK (fulfillment_method IN ('INTERNAL_DELIVERY','ASSIGNED_DRIVER')),
  assigned_driver_id TEXT NULL,
  accepted_by TEXT NOT NULL CHECK (btrim(accepted_by) <> ''),
  capacity_confirmed_at TIMESTAMPTZ NOT NULL,
  capacity_confirmed_until TIMESTAMPTZ NOT NULL,
  CHECK (capacity_confirmed_until > capacity_confirmed_at),
  CHECK (fulfillment_method <> 'INTERNAL_DELIVERY' OR assigned_driver_id IS NULL)
);
COMMIT;

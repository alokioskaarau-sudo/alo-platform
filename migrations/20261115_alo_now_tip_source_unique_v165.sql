-- ALO NOW V165
-- Protect each captured online tip payment reference globally.
--
-- Review and test in staging before production.
-- This migration is NOT automatically executed.
--
-- Existing per-order uniqueness remains unchanged:
-- at most one ONLINE_TIP_EARNED event per delivery order.
--
-- This index additionally prevents a capture reference from
-- being credited to two different orders.

CREATE UNIQUE INDEX IF NOT EXISTS
  alo_now_tip_source_unique_v165
ON public.alo_now_driver_finance_events
  (source_reference)
WHERE event_type = 'ONLINE_TIP_EARNED';

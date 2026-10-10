-- Source automation ledger traces (SHIPPED / DELAYED / DELIVERED).
-- Does not change unique send key or Thank You behavior.

ALTER TABLE customer_service_sends
  ADD COLUMN IF NOT EXISTS source_event_id BIGINT,
  ADD COLUMN IF NOT EXISTS source_mailbox_message_id BIGINT,
  ADD COLUMN IF NOT EXISTS source_event_type TEXT;

CREATE INDEX IF NOT EXISTS idx_cs_sends_source_event
  ON customer_service_sends (source_event_id)
  WHERE source_event_id IS NOT NULL;

-- Additive Keepa collector bootstrap watermark coverage. Does not delete outbox rows.

ALTER TABLE keepa_asin_sync_outbox DROP CONSTRAINT IF EXISTS chk_keepa_sync_outbox_status;
ALTER TABLE keepa_asin_sync_outbox
  ADD CONSTRAINT chk_keepa_sync_outbox_status
  CHECK (status IN ('PENDING', 'DELIVERED', 'FAILED', 'COVERED_BY_SNAPSHOT'));

ALTER TABLE keepa_asin_sync_outbox ADD COLUMN IF NOT EXISTS covered_reason TEXT;
ALTER TABLE keepa_asin_sync_outbox ADD COLUMN IF NOT EXISTS bootstrap_watermark TIMESTAMPTZ;

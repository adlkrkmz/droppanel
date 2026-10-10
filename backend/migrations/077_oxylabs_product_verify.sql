-- Oxylabs Amazon Product PRIMARY/CONFIRM kinds + canary success counter.
-- Additive. Does not rewrite existing ROUTINE/CONFIRM/KEEPA_VERIFY jobs.

ALTER TABLE amazon_scan_jobs DROP CONSTRAINT IF EXISTS chk_amazon_scan_jobs_kind;
ALTER TABLE amazon_scan_jobs ADD CONSTRAINT chk_amazon_scan_jobs_kind
  CHECK (kind IN (
    'ROUTINE',
    'CONFIRM',
    'KEEPA_VERIFY_PRIMARY',
    'KEEPA_VERIFY_CONFIRM',
    'OXYLABS_PRODUCT_PRIMARY',
    'OXYLABS_PRODUCT_CONFIRM'
  ));

ALTER TABLE amazon_scan_jobs
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'AMAZON_BROWSER';

ALTER TABLE amazon_scan_jobs DROP CONSTRAINT IF EXISTS chk_amazon_scan_jobs_provider;
ALTER TABLE amazon_scan_jobs ADD CONSTRAINT chk_amazon_scan_jobs_provider
  CHECK (provider IN ('AMAZON_BROWSER', 'OXYLABS_PRODUCT'));

CREATE TABLE IF NOT EXISTS oxylabs_verify_canary_state (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  success_result_count INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO oxylabs_verify_canary_state (id, success_result_count)
VALUES (1, 0)
ON CONFLICT (id) DO NOTHING;

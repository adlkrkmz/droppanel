-- Terminal non-action status for Oxylabs PRODUCT_INCONCLUSIVE (no RETRYABLE feeder loop).
ALTER TABLE keepa_verify_candidates DROP CONSTRAINT IF EXISTS chk_keepa_verify_status;
ALTER TABLE keepa_verify_candidates ADD CONSTRAINT chk_keepa_verify_status CHECK (status IN (
  'PENDING','RETRYABLE','SUPERSEDED','NO_BUSINESS_CHANGE','MATCHED','CONFLICT','COOLDOWN','INCONCLUSIVE'
));

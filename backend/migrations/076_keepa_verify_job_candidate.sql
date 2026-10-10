-- Link Keepa verify scan jobs to keepa_verify_candidates. Additive.

ALTER TABLE amazon_scan_jobs
  ADD COLUMN IF NOT EXISTS keepa_candidate_id BIGINT NULL REFERENCES keepa_verify_candidates(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_amazon_scan_jobs_keepa_candidate
  ON amazon_scan_jobs (keepa_candidate_id)
  WHERE keepa_candidate_id IS NOT NULL;

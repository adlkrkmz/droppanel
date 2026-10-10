-- Last normalized Keepa observation + evidence evaluation per ASIN.
-- Additive. Does not store raw Keepa JSON or mutate catalog/eBay columns.

CREATE TABLE IF NOT EXISTS keepa_asin_last_observations (
  asin                           TEXT PRIMARY KEY,
  observed_at                    TIMESTAMPTZ NOT NULL,
  price_evidence                 JSONB NOT NULL,
  availability                   TEXT NULL,
  prime_fba_evidence             JSONB NOT NULL DEFAULT '{}'::jsonb,
  seller_counts                  JSONB NOT NULL DEFAULT '{}'::jsonb,
  trusted_reference_fingerprint  TEXT NULL,
  evaluation_code                TEXT NOT NULL,
  candidate_id                   BIGINT NULL REFERENCES keepa_verify_candidates(id) ON DELETE SET NULL,
  observation_fingerprint        TEXT NOT NULL,
  candidate_fingerprint          TEXT NULL,
  updated_at                     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_keepa_obs_asin CHECK (asin ~ '^[A-Z0-9]{10}$')
);

CREATE INDEX IF NOT EXISTS idx_keepa_asin_last_observations_observed
  ON keepa_asin_last_observations (observed_at DESC);

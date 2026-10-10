-- Keepa change-sensor sync outbox + VERIFY candidates.
-- Additive. Does not drop scan jobs/outbox or Keepa foundation tables.

CREATE TABLE IF NOT EXISTS keepa_asin_sync_state (
  asin              TEXT PRIMARY KEY,
  source_version    BIGINT NOT NULL DEFAULT 0,
  payload_fingerprint TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'ACTIVE',
  active_consumer_count INTEGER NOT NULL DEFAULT 0,
  priority          TEXT NOT NULL DEFAULT 'STANDARD',
  cadence_hours     INTEGER NOT NULL DEFAULT 24,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_keepa_asin_sync_state_asin CHECK (asin ~ '^[A-Z0-9]{10}$'),
  CONSTRAINT chk_keepa_asin_sync_state_status CHECK (status IN ('ACTIVE','PAUSED_QTY_ZERO','REMOVED')),
  CONSTRAINT chk_keepa_asin_sync_state_priority CHECK (priority IN ('SOLD','STANDARD'))
);

CREATE TABLE IF NOT EXISTS keepa_asin_sync_outbox (
  event_id          UUID PRIMARY KEY,
  asin              TEXT NOT NULL,
  event_type        TEXT NOT NULL,
  source_version    BIGINT NOT NULL,
  payload           JSONB NOT NULL,
  payload_fingerprint TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'PENDING',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at      TIMESTAMPTZ NULL,
  CONSTRAINT chk_keepa_sync_outbox_asin CHECK (asin ~ '^[A-Z0-9]{10}$'),
  CONSTRAINT chk_keepa_sync_outbox_type CHECK (event_type IN (
    'ASIN_UPSERT','CONSUMER_ATTACHED','CONSUMER_DETACHED','ASIN_REMOVED',
    'QTY_ZERO_PAUSED','QTY_POSITIVE_RESUMED','SOLD_PRIORITY_CHANGED'
  )),
  CONSTRAINT chk_keepa_sync_outbox_status CHECK (status IN ('PENDING','DELIVERED','FAILED'))
);

CREATE INDEX IF NOT EXISTS idx_keepa_asin_sync_outbox_pending
  ON keepa_asin_sync_outbox (created_at ASC, event_id ASC)
  WHERE status = 'PENDING';

CREATE INDEX IF NOT EXISTS idx_keepa_asin_sync_outbox_asin_version
  ON keepa_asin_sync_outbox (asin, source_version DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_keepa_asin_sync_outbox_idem
  ON keepa_asin_sync_outbox (asin, event_type, payload_fingerprint);

CREATE TABLE IF NOT EXISTS keepa_verify_candidates (
  id                    BIGSERIAL PRIMARY KEY,
  asin                  TEXT NOT NULL,
  fingerprint           TEXT NOT NULL,
  snapshot              JSONB NOT NULL,
  status                TEXT NOT NULL DEFAULT 'PENDING',
  previous_fingerprint  TEXT NULL,
  browser_decision      TEXT NULL,
  cooldown_until        TIMESTAMPTZ NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_keepa_verify_asin CHECK (asin ~ '^[A-Z0-9]{10}$'),
  CONSTRAINT chk_keepa_verify_status CHECK (status IN (
    'PENDING','RETRYABLE','SUPERSEDED','NO_BUSINESS_CHANGE','MATCHED','CONFLICT','COOLDOWN'
  ))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_keepa_verify_asin_fingerprint
  ON keepa_verify_candidates (asin, fingerprint);

CREATE INDEX IF NOT EXISTS idx_keepa_verify_candidates_asin
  ON keepa_verify_candidates (asin, created_at DESC);

ALTER TABLE amazon_scan_jobs DROP CONSTRAINT IF EXISTS chk_amazon_scan_jobs_kind;
ALTER TABLE amazon_scan_jobs ADD CONSTRAINT chk_amazon_scan_jobs_kind
  CHECK (kind IN ('ROUTINE','CONFIRM','KEEPA_VERIFY_PRIMARY','KEEPA_VERIFY_CONFIRM'));

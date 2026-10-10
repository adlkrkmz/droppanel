-- Unique public Amazon scan jobs (marketplace + ZIP + session), apply outbox, cadence.
-- Additive. Does not drop Keepa/global_asin_consumers. Planner is flag-gated in app code.

CREATE TABLE IF NOT EXISTS amazon_scan_cadence (
  global_asin_id   BIGINT PRIMARY KEY REFERENCES global_amazon_asins(id) ON DELETE CASCADE,
  scan_key         TEXT NOT NULL,
  asin             TEXT NOT NULL,
  marketplace      TEXT NOT NULL DEFAULT 'US',
  delivery_zip     TEXT NOT NULL DEFAULT '10001',
  session_class    TEXT NOT NULL DEFAULT 'PUBLIC_UNAUTH',
  priority         SMALLINT NOT NULL DEFAULT 2,
  last_success_at  TIMESTAMPTZ NULL,
  last_checked_at  TIMESTAMPTZ NULL,
  next_check_at    TIMESTAMPTZ NULL,
  failure_count    INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_amazon_scan_cadence_asin CHECK (asin ~ '^[A-Z0-9]{10}$'),
  CONSTRAINT uq_amazon_scan_cadence_key UNIQUE (scan_key)
);

CREATE INDEX IF NOT EXISTS idx_amazon_scan_cadence_due
  ON amazon_scan_cadence (next_check_at ASC NULLS FIRST, priority ASC);

CREATE TABLE IF NOT EXISTS amazon_scan_jobs (
  id                    BIGSERIAL PRIMARY KEY,
  scan_key              TEXT NOT NULL,
  global_asin_id        BIGINT NOT NULL REFERENCES global_amazon_asins(id) ON DELETE CASCADE,
  asin                  TEXT NOT NULL,
  marketplace           TEXT NOT NULL DEFAULT 'US',
  delivery_zip          TEXT NOT NULL DEFAULT '10001',
  session_class         TEXT NOT NULL DEFAULT 'PUBLIC_UNAUTH',
  kind                  TEXT NOT NULL DEFAULT 'ROUTINE',
  priority              SMALLINT NOT NULL DEFAULT 2,
  status                TEXT NOT NULL DEFAULT 'PENDING',
  worker_id             TEXT NULL,
  lease_token           TEXT NULL,
  lease_expires_at      TIMESTAMPTZ NULL,
  claimed_at            TIMESTAMPTZ NULL,
  started_at            TIMESTAMPTZ NULL,
  completed_at          TIMESTAMPTZ NULL,
  observed_at           TIMESTAMPTZ NULL,
  attempt_count         INTEGER NOT NULL DEFAULT 0,
  available_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  parent_job_id         BIGINT NULL REFERENCES amazon_scan_jobs(id) ON DELETE SET NULL,
  result_payload        JSONB NULL,
  failure_code          TEXT NULL,
  failure_message       TEXT NULL,
  require_fresh_nav     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_amazon_scan_jobs_asin CHECK (asin ~ '^[A-Z0-9]{10}$'),
  CONSTRAINT chk_amazon_scan_jobs_kind CHECK (kind IN ('ROUTINE', 'CONFIRM')),
  CONSTRAINT chk_amazon_scan_jobs_status CHECK (status IN (
    'PENDING', 'CLAIMED', 'RUNNING', 'COMPLETED', 'FAILED',
    'WAITING_FOR_WORKER', 'RETRYABLE', 'CANCELLED'
  ))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_amazon_scan_jobs_active
  ON amazon_scan_jobs (scan_key, kind)
  WHERE status IN ('PENDING', 'CLAIMED', 'RUNNING', 'WAITING_FOR_WORKER', 'RETRYABLE');

CREATE INDEX IF NOT EXISTS idx_amazon_scan_jobs_claim
  ON amazon_scan_jobs (kind, priority, available_at, id)
  WHERE status IN ('PENDING', 'RETRYABLE', 'WAITING_FOR_WORKER');

CREATE TABLE IF NOT EXISTS amazon_scan_apply_outbox (
  id              BIGSERIAL PRIMARY KEY,
  job_id          BIGINT NOT NULL REFERENCES amazon_scan_jobs(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'PENDING',
  payload         JSONB NOT NULL,
  attempt_count   INTEGER NOT NULL DEFAULT 0,
  available_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_until    TIMESTAMPTZ NULL,
  last_error      TEXT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_amazon_scan_outbox_status CHECK (status IN ('PENDING', 'DONE', 'FAILED'))
);

CREATE INDEX IF NOT EXISTS idx_amazon_scan_outbox_due
  ON amazon_scan_apply_outbox (available_at, id)
  WHERE status = 'PENDING';

CREATE UNIQUE INDEX IF NOT EXISTS uq_amazon_scan_apply_outbox_job
  ON amazon_scan_apply_outbox (job_id);

CREATE TABLE IF NOT EXISTS amazon_scan_worker_heartbeat (
  worker_id         TEXT PRIMARY KEY,
  status            TEXT NOT NULL DEFAULT 'OFFLINE',
  last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  browser_running   BOOLEAN NOT NULL DEFAULT FALSE,
  current_job_id    BIGINT NULL,
  last_error        TEXT NULL,
  pause_reason      TEXT NULL,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

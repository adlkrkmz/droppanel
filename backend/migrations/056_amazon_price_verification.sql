-- FAZ 3A: Amazon price verification queue + extension worker registry.
-- Additive only. Does not alter capture queue, Stock Guard, or eBay tables.

CREATE TABLE IF NOT EXISTS extension_workers (
  id                              BIGSERIAL PRIMARY KEY,
  worker_id                       TEXT NOT NULL,
  user_id                         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id                    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  device_id                       TEXT NOT NULL,
  extension_version               TEXT NULL,
  last_heartbeat_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_successful_verification_at TIMESTAMPTZ NULL,
  status                          TEXT NOT NULL DEFAULT 'ONLINE',
  amazon_available                BOOLEAN NULL,
  active_task_count               INTEGER NOT NULL DEFAULT 0,
  current_task_id                 BIGINT NULL,
  recent_failure_count            INTEGER NOT NULL DEFAULT 0,
  recent_captcha_count            INTEGER NOT NULL DEFAULT 0,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_extension_workers_device UNIQUE (workspace_id, user_id, device_id),
  CONSTRAINT uq_extension_workers_worker_id UNIQUE (worker_id),
  CONSTRAINT chk_extension_workers_status CHECK (status IN ('ONLINE', 'OFFLINE', 'AMAZON_BLOCKED'))
);

CREATE INDEX IF NOT EXISTS idx_extension_workers_heartbeat
  ON extension_workers (workspace_id, user_id, last_heartbeat_at DESC);

CREATE TABLE IF NOT EXISTS amazon_price_verification_tasks (
  id                         BIGSERIAL PRIMARY KEY,
  global_asin_id             BIGINT NOT NULL REFERENCES global_amazon_asins(id) ON DELETE CASCADE,
  workspace_id               UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  preferred_user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  catalog_state_id           BIGINT NOT NULL REFERENCES store_catalog_state(id) ON DELETE CASCADE,
  asin                       TEXT NOT NULL,
  amazon_url                 TEXT NOT NULL,
  reason                     TEXT NOT NULL,
  priority                   SMALLINT NOT NULL DEFAULT 2,
  status                     TEXT NOT NULL DEFAULT 'PENDING',
  worker_id                  TEXT NULL,
  attempt_count              INTEGER NOT NULL DEFAULT 0,
  available_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at                 TIMESTAMPTZ NULL,
  lease_expires_at           TIMESTAMPTZ NULL,
  started_at                 TIMESTAMPTZ NULL,
  completed_at               TIMESTAMPTZ NULL,
  result_price               NUMERIC(12,2) NULL,
  result_currency            TEXT NULL,
  result_condition           TEXT NULL,
  result_is_prime            BOOLEAN NULL,
  result_is_fba              BOOLEAN NULL,
  result_ships_from_amazon   BOOLEAN NULL,
  result_purchasable         TEXT NULL,
  result_source_url          TEXT NULL,
  result_metadata            JSONB NULL,
  failure_code               TEXT NULL,
  failure_message            TEXT NULL,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_amazon_verification_asin CHECK (asin ~ '^[A-Z0-9]{10}$'),
  CONSTRAINT chk_amazon_verification_status CHECK (status IN (
    'PENDING', 'CLAIMED', 'RUNNING', 'COMPLETED', 'FAILED',
    'WAITING_FOR_WORKER', 'RETRYABLE', 'CANCELLED'
  )),
  CONSTRAINT chk_amazon_verification_reason CHECK (reason IN (
    'PRICE_AMBIGUOUS',
    'KEEPA_PRODUCT_UNRESOLVED',
    'KEEPA_UNRESOLVED',
    'ADMIN_TEST'
  )),
  CONSTRAINT chk_amazon_verification_purchasable CHECK (
    result_purchasable IS NULL OR result_purchasable IN ('TRUE', 'FALSE', 'UNKNOWN')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_amazon_verification_active
  ON amazon_price_verification_tasks (workspace_id, global_asin_id, catalog_state_id)
  WHERE status IN ('PENDING', 'CLAIMED', 'RUNNING', 'WAITING_FOR_WORKER', 'RETRYABLE');

CREATE INDEX IF NOT EXISTS idx_amazon_verification_claim
  ON amazon_price_verification_tasks (workspace_id, preferred_user_id, status, available_at, lease_expires_at)
  WHERE status IN ('PENDING', 'CLAIMED', 'RUNNING', 'WAITING_FOR_WORKER', 'RETRYABLE');

CREATE INDEX IF NOT EXISTS idx_amazon_verification_created
  ON amazon_price_verification_tasks (created_at DESC);

ALTER TABLE extension_workers
  DROP CONSTRAINT IF EXISTS fk_extension_workers_current_task;

ALTER TABLE extension_workers
  ADD CONSTRAINT fk_extension_workers_current_task
  FOREIGN KEY (current_task_id) REFERENCES amazon_price_verification_tasks(id) ON DELETE SET NULL;

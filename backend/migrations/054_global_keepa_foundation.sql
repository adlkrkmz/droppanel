-- Global Keepa SaaS monitoring foundation (Phase 1, non-destructive).
-- Additive only: no existing table/column drops or semantic changes.
-- Does NOT backfill listing data (use scripts/global-keepa-backfill.ts separately).
-- Does NOT wire production Stock Guard / eBay action paths.

-- A) Platform-global Amazon ASIN identity (not workspace-scoped asin_registry)
CREATE TABLE IF NOT EXISTS global_amazon_asins (
  id              BIGSERIAL PRIMARY KEY,
  keepa_domain    INTEGER NOT NULL,
  asin            TEXT NOT NULL,
  last_checked_at TIMESTAMPTZ NULL,
  next_check_at   TIMESTAMPTZ NULL,
  priority        SMALLINT NULL,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_global_amazon_asins_domain_asin UNIQUE (keepa_domain, asin),
  CONSTRAINT chk_global_amazon_asins_asin CHECK (asin ~ '^[A-Z0-9]{10}$'),
  CONSTRAINT chk_global_amazon_asins_priority CHECK (priority IS NULL OR priority IN (0, 1, 2))
);

CREATE INDEX IF NOT EXISTS idx_global_amazon_asins_asin
  ON global_amazon_asins (asin);

CREATE INDEX IF NOT EXISTS idx_global_amazon_asins_next_check
  ON global_amazon_asins (next_check_at)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_global_amazon_asins_last_checked
  ON global_amazon_asins (last_checked_at);

CREATE INDEX IF NOT EXISTS idx_global_amazon_asins_priority_next
  ON global_amazon_asins (priority, next_check_at)
  WHERE is_active = TRUE;

-- B) Tenant listing consumers of a global ASIN
CREATE TABLE IF NOT EXISTS global_asin_consumers (
  id                BIGSERIAL PRIMARY KEY,
  global_asin_id    BIGINT NOT NULL REFERENCES global_amazon_asins(id) ON DELETE CASCADE,
  workspace_id      UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  store_id          INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  catalog_state_id  BIGINT NOT NULL REFERENCES store_catalog_state(id) ON DELETE CASCADE,
  listing_priority  SMALLINT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_global_asin_consumers_catalog UNIQUE (catalog_state_id),
  CONSTRAINT chk_global_asin_consumers_priority CHECK (
    listing_priority IS NULL OR listing_priority IN (0, 1, 2)
  )
);

CREATE INDEX IF NOT EXISTS idx_global_asin_consumers_global_asin
  ON global_asin_consumers (global_asin_id);

CREATE INDEX IF NOT EXISTS idx_global_asin_consumers_workspace_store
  ON global_asin_consumers (workspace_id, store_id);

CREATE INDEX IF NOT EXISTS idx_global_asin_consumers_workspace_catalog
  ON global_asin_consumers (workspace_id, catalog_state_id);

CREATE INDEX IF NOT EXISTS idx_global_asin_consumers_store
  ON global_asin_consumers (store_id);

-- C) Latest Keepa 1-token snapshot (one row per global ASIN)
CREATE TABLE IF NOT EXISTS global_keepa_snapshots (
  global_asin_id              BIGINT PRIMARY KEY REFERENCES global_amazon_asins(id) ON DELETE CASCADE,
  new_price                   NUMERIC(12,2) NULL,
  new_fba_count               INTEGER NULL,
  new_fbm_count               INTEGER NULL,
  previous_new_price          NUMERIC(12,2) NULL,
  previous_new_fba_count      INTEGER NULL,
  previous_new_fbm_count      INTEGER NULL,
  keepa_last_update           TIMESTAMPTZ NULL,
  keepa_last_price_change     TIMESTAMPTZ NULL,
  keepa_last_update_minutes   INTEGER NULL,
  keepa_last_price_change_minutes INTEGER NULL,
  checked_at                  TIMESTAMPTZ NULL,
  previous_checked_at         TIMESTAMPTZ NULL,
  status                      TEXT NOT NULL,
  price_confidence            TEXT NOT NULL,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_global_keepa_snapshots_status CHECK (status IN (
    'KEEPA_OK',
    'FBA_PRESENT',
    'FBA_MISSING',
    'PRICE_CHANGED',
    'PRICE_UNCHANGED',
    'PRICE_AMBIGUOUS',
    'CHECK_FAILED',
    'STALE_DATA',
    'PRODUCT_NOT_RETURNED'
  )),
  CONSTRAINT chk_global_keepa_snapshots_confidence CHECK (price_confidence IN (
    'CONFIRMED_FBA',
    'AMBIGUOUS',
    'NONE',
    'FAILED'
  ))
);

CREATE INDEX IF NOT EXISTS idx_global_keepa_snapshots_status
  ON global_keepa_snapshots (status);

CREATE INDEX IF NOT EXISTS idx_global_keepa_snapshots_checked_at
  ON global_keepa_snapshots (checked_at);

-- D) Platform-global Keepa token bucket (single row). Distinct from workspace keepa_token_state.
CREATE TABLE IF NOT EXISTS keepa_platform_token_state (
  id                           SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  tokens_left                  INTEGER NULL,
  refill_rate                  INTEGER NULL,
  refill_in                    INTEGER NULL,
  last_tokens_consumed         INTEGER NULL,
  rolling_tokens_consumed_1h   INTEGER NULL,
  rolling_tokens_consumed_24h  INTEGER NULL,
  last_api_response_at         TIMESTAMPTZ NULL,
  tokens_updated_at            TIMESTAMPTZ NULL,
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO keepa_platform_token_state (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

BEGIN;

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

--------------------------------------------------
-- ENUMS
--------------------------------------------------

CREATE TYPE global_asin_status AS ENUM (
'active',
'blacklisted',
'invalid',
'archived'
);

CREATE TYPE pool_status AS ENUM (
'ready',
'processing',
'skipped',
'completed'
);

CREATE TYPE pipeline_stage AS ENUM (
'imported',
'validated',
'scraped',
'ai_generated',
'scheduled',
'listing',
'listed',
'rejected'
);

CREATE TYPE scrape_status AS ENUM (
'pending',
'success',
'failed'
);

CREATE TYPE ai_status AS ENUM (
'pending',
'success',
'failed'
);

CREATE TYPE listing_execution_status AS ENUM (
'pending',
'success',
'failed'
);

CREATE TYPE catalog_current_status AS ENUM (
'live',
'ended',
'error',
'pending'
);

CREATE TYPE listing_history_status AS ENUM (
'created',
'live',
'ended',
'failed'
);

CREATE TYPE job_status AS ENUM (
'pending',
'running',
'completed',
'failed'
);

CREATE TYPE scheduler_mode AS ENUM (
'fixed',
'random'
);

CREATE TYPE lock_reason AS ENUM (
'listing',
'scraping',
'cooldown',
'manual'
);

CREATE TYPE blacklist_match_type AS ENUM (
'exact',
'contains',
'regex'
);

CREATE TYPE store_health AS ENUM (
'healthy',
'warning',
'restricted',
'suspended'
);

CREATE TYPE sync_health AS ENUM (
'ok',
'lagging',
'failed'
);

--------------------------------------------------
-- WORKSPACES
--------------------------------------------------

CREATE TABLE workspaces (
id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
name TEXT NOT NULL,
created_at TIMESTAMP DEFAULT NOW(),
updated_at TIMESTAMP DEFAULT NOW()
);

--------------------------------------------------
-- STORES
--------------------------------------------------

CREATE TABLE stores (
id SERIAL PRIMARY KEY,
workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,

name TEXT NOT NULL,
store_code TEXT NOT NULL,
marketplace TEXT DEFAULT 'ebay',
status TEXT DEFAULT 'active',

max_active_listings INTEGER DEFAULT 10000,
target_active_listings INTEGER DEFAULT 5000,
daily_listing_limit INTEGER DEFAULT 250,

health_status store_health DEFAULT 'healthy',
sync_health sync_health DEFAULT 'ok',

last_sync_at TIMESTAMP,

error_count INTEGER DEFAULT 0,
last_error TEXT,

created_at TIMESTAMP DEFAULT NOW(),
updated_at TIMESTAMP DEFAULT NOW(),

UNIQUE (workspace_id, store_code)
);

CREATE INDEX idx_stores_workspace
ON stores(workspace_id);

CREATE INDEX idx_stores_status
ON stores(workspace_id, status);

--------------------------------------------------
-- ASIN REGISTRY
--------------------------------------------------

CREATE TABLE asin_registry (
id BIGSERIAL PRIMARY KEY,
workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
asin TEXT NOT NULL,
brand TEXT,
title TEXT,
global_status global_asin_status DEFAULT 'active',
first_seen_at TIMESTAMP DEFAULT NOW(),
created_at TIMESTAMP DEFAULT NOW(),
updated_at TIMESTAMP DEFAULT NOW(),
UNIQUE(workspace_id, asin)
);

CREATE INDEX idx_asin_registry_workspace_asin
ON asin_registry(workspace_id, asin);

CREATE INDEX idx_asin_registry_status
ON asin_registry(workspace_id, global_status);

--------------------------------------------------
-- IMPORT BATCHES
--------------------------------------------------

CREATE TABLE import_batches (
id BIGSERIAL PRIMARY KEY,
workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
source_type TEXT,
source_name TEXT,
uploaded_by TEXT,
total_rows INTEGER,
valid_rows INTEGER,
ready_count INTEGER,
duplicate_pool_count INTEGER,
already_live_count INTEGER,
blacklist_count INTEGER,
cooldown_count INTEGER,
invalid_count INTEGER,
scrape_failed_count INTEGER,
created_at TIMESTAMP DEFAULT NOW(),
updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_import_batches_workspace
ON import_batches(workspace_id, created_at DESC);

--------------------------------------------------
-- SCHEDULER PROFILES
--------------------------------------------------

CREATE TABLE scheduler_profiles (
id SERIAL PRIMARY KEY,
workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
name TEXT,
mode scheduler_mode DEFAULT 'fixed',
fixed_interval_seconds INTEGER,
random_min_seconds INTEGER,
random_max_seconds INTEGER,
is_active BOOLEAN DEFAULT TRUE,
created_at TIMESTAMP DEFAULT NOW(),
updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_scheduler_profiles_workspace_active
ON scheduler_profiles(workspace_id, is_active);

--------------------------------------------------
-- ASIN POOL
--------------------------------------------------

CREATE TABLE asin_pool (
id BIGSERIAL PRIMARY KEY,
workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
asin_registry_id BIGINT REFERENCES asin_registry(id) ON DELETE CASCADE,
import_batch_id BIGINT REFERENCES import_batches(id) ON DELETE SET NULL,
status pool_status DEFAULT 'ready',
assigned_store_id INTEGER REFERENCES stores(id) ON DELETE SET NULL,
scheduler_profile_id INTEGER REFERENCES scheduler_profiles(id) ON DELETE SET NULL,
priority INTEGER DEFAULT 0,
skip_reason TEXT,
scrape_status scrape_status DEFAULT 'pending',
ai_status ai_status DEFAULT 'pending',
listing_status listing_execution_status DEFAULT 'pending',
pipeline_stage pipeline_stage DEFAULT 'imported',
created_at TIMESTAMP DEFAULT NOW(),
updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_pool_workspace_stage_priority
ON asin_pool(workspace_id, pipeline_stage, priority DESC, id ASC);

CREATE INDEX idx_pool_workspace_status
ON asin_pool(workspace_id, status);

CREATE INDEX idx_pool_asin_registry
ON asin_pool(asin_registry_id);

CREATE INDEX idx_pool_assigned_store
ON asin_pool(assigned_store_id);

--------------------------------------------------
-- STORE CATALOG STATE
--------------------------------------------------

CREATE TABLE store_catalog_state (
id BIGSERIAL PRIMARY KEY,
workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE,
asin_registry_id BIGINT REFERENCES asin_registry(id) ON DELETE CASCADE,
internal_sku TEXT NOT NULL,
ebay_item_id TEXT,
ebay_offer_id TEXT,
current_status catalog_current_status DEFAULT 'pending',
listed_at TIMESTAMP,
last_seen_live_at TIMESTAMP,
last_seen_ended_at TIMESTAMP,
last_sync_at TIMESTAMP,
source_of_truth TEXT DEFAULT 'ebay_sync',
created_at TIMESTAMP DEFAULT NOW(),
updated_at TIMESTAMP DEFAULT NOW(),
UNIQUE(store_id, asin_registry_id),
UNIQUE(workspace_id, internal_sku)
);

CREATE INDEX idx_catalog_workspace_store_status
ON store_catalog_state(workspace_id, store_id, current_status);

CREATE INDEX idx_catalog_asin_status
ON store_catalog_state(asin_registry_id, current_status);

CREATE INDEX idx_catalog_last_sync
ON store_catalog_state(workspace_id, last_sync_at DESC);

--------------------------------------------------
-- LISTING HISTORY
--------------------------------------------------

CREATE TABLE listing_history (
id BIGSERIAL PRIMARY KEY,
workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
store_id INTEGER REFERENCES stores(id) ON DELETE SET NULL,
asin_registry_id BIGINT REFERENCES asin_registry(id) ON DELETE SET NULL,
internal_sku TEXT,
ebay_item_id TEXT,
ebay_offer_id TEXT,
amazon_url_snapshot TEXT,
title_snapshot TEXT,
price_snapshot NUMERIC,
status listing_history_status,
listed_at TIMESTAMP,
ended_at TIMESTAMP,
listing_job_ref BIGINT,
created_at TIMESTAMP DEFAULT NOW(),
updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_listing_history_workspace_store
ON listing_history(workspace_id, store_id, created_at DESC);

CREATE INDEX idx_listing_history_asin
ON listing_history(asin_registry_id, created_at DESC);

CREATE INDEX idx_listing_history_job_ref
ON listing_history(listing_job_ref);

--------------------------------------------------
-- DELETION HISTORY
--------------------------------------------------

CREATE TABLE deletion_history (
id BIGSERIAL PRIMARY KEY,
workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
store_id INTEGER REFERENCES stores(id) ON DELETE SET NULL,
asin_registry_id BIGINT REFERENCES asin_registry(id) ON DELETE SET NULL,
internal_sku TEXT,
deletion_reason TEXT,
cooldown_until TIMESTAMP,
deleted_by TEXT,
notes TEXT,
deleted_at TIMESTAMP DEFAULT NOW(),
created_at TIMESTAMP DEFAULT NOW(),
updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_deletion_history_asin_deleted
ON deletion_history(asin_registry_id, deleted_at DESC);

CREATE INDEX idx_deletion_history_cooldown
ON deletion_history(workspace_id, cooldown_until);

--------------------------------------------------
-- JOBS
--------------------------------------------------

CREATE TABLE jobs (
id BIGSERIAL PRIMARY KEY,
workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
job_type TEXT,
payload_json JSONB,
related_entity_type TEXT,
related_entity_id BIGINT,
status job_status DEFAULT 'pending',
error_message TEXT,
created_at TIMESTAMP DEFAULT NOW(),
updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_jobs_workspace_status_created
ON jobs(workspace_id, status, created_at DESC);

CREATE INDEX idx_jobs_related_entity
ON jobs(workspace_id, related_entity_type, related_entity_id);

--------------------------------------------------
-- BRAND BLACKLIST
--------------------------------------------------

CREATE TABLE brand_blacklist (
id SERIAL PRIMARY KEY,
workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
brand_name TEXT,
normalized_brand_name TEXT,
is_active BOOLEAN DEFAULT TRUE,
created_at TIMESTAMP DEFAULT NOW(),
updated_at TIMESTAMP DEFAULT NOW(),
UNIQUE(workspace_id, normalized_brand_name)
);

CREATE INDEX idx_brand_blacklist_workspace_active
ON brand_blacklist(workspace_id, is_active);

--------------------------------------------------
-- KEYWORD BLACKLIST
--------------------------------------------------

CREATE TABLE keyword_blacklist (
id SERIAL PRIMARY KEY,
workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
keyword TEXT,
match_type blacklist_match_type DEFAULT 'contains',
is_active BOOLEAN DEFAULT TRUE,
created_at TIMESTAMP DEFAULT NOW(),
updated_at TIMESTAMP DEFAULT NOW(),
UNIQUE(workspace_id, keyword, match_type)
);

CREATE INDEX idx_keyword_blacklist_workspace_active
ON keyword_blacklist(workspace_id, is_active);

--------------------------------------------------
-- ASIN LOCKS
--------------------------------------------------

CREATE TABLE asin_locks (
id BIGSERIAL PRIMARY KEY,
workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
asin_registry_id BIGINT REFERENCES asin_registry(id) ON DELETE CASCADE,
locked_by_store_id INTEGER REFERENCES stores(id) ON DELETE SET NULL,
lock_reason lock_reason,
locked_at TIMESTAMP DEFAULT NOW(),
expires_at TIMESTAMP,
created_at TIMESTAMP DEFAULT NOW(),
UNIQUE(workspace_id, asin_registry_id)
);

CREATE INDEX idx_asin_locks_workspace_expiry
ON asin_locks(workspace_id, expires_at);

--------------------------------------------------
-- AMAZON PRODUCT CACHE
--------------------------------------------------

CREATE TABLE amazon_product_cache (
asin_registry_id BIGINT PRIMARY KEY REFERENCES asin_registry(id) ON DELETE CASCADE,
title TEXT,
brand TEXT,
price NUMERIC,
images JSONB,
attributes JSONB,
updated_at TIMESTAMP DEFAULT NOW()
);

--------------------------------------------------
-- AI LISTING CACHE
--------------------------------------------------

CREATE TABLE ai_listing_cache (
id BIGSERIAL PRIMARY KEY,
workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
asin_registry_id BIGINT REFERENCES asin_registry(id) ON DELETE CASCADE,
title TEXT,
description TEXT,
bullets JSONB,
generated_at TIMESTAMP DEFAULT NOW(),
created_at TIMESTAMP DEFAULT NOW(),
updated_at TIMESTAMP DEFAULT NOW(),
UNIQUE(workspace_id, asin_registry_id)
);

CREATE INDEX idx_ai_listing_cache_workspace_asin
ON ai_listing_cache(workspace_id, asin_registry_id);

COMMIT;

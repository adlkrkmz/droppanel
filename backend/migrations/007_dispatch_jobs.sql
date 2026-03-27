BEGIN;

-- Dispatch run status
CREATE TYPE dispatch_run_status AS ENUM (
  'pending', 'running', 'completed', 'failed', 'cancelled'
);

-- Dispatch job status
CREATE TYPE dispatch_job_status AS ENUM (
  'pending',
  'claimed',
  'extract_running', 'extract_done',
  'ai_running', 'ai_done',
  'listing_running', 'listing_done',
  'failed',
  'retry_waiting',
  'cancelled'
);

-- Dispatch job failed stage
CREATE TYPE dispatch_failed_stage AS ENUM (
  'extract', 'ai', 'listing', 'claim', 'unknown'
);

-- Üst tablo: bir kullanıcı run'ı
CREATE TABLE dispatch_runs (
  id BIGSERIAL PRIMARY KEY,
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE,
  store_code TEXT NOT NULL,
  delay_seconds INTEGER DEFAULT 30,
  quantity INTEGER DEFAULT 1,
  status dispatch_run_status DEFAULT 'pending',
  total_jobs INTEGER DEFAULT 0,
  completed_jobs INTEGER DEFAULT 0,
  failed_jobs INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_dispatch_runs_workspace_status
ON dispatch_runs(workspace_id, status, created_at DESC);

-- Alt tablo: her ASIN için bir job
CREATE TABLE dispatch_jobs (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT REFERENCES dispatch_runs(id) ON DELETE CASCADE,
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE,
  store_code TEXT NOT NULL,
  asin TEXT NOT NULL,
  pool_id BIGINT REFERENCES asin_pool(id) ON DELETE CASCADE,
  status dispatch_job_status DEFAULT 'pending',
  quantity INTEGER DEFAULT 1,
  delay_seconds INTEGER DEFAULT 30,
  attempt_count INTEGER DEFAULT 0,
  max_attempts INTEGER DEFAULT 3,
  last_error TEXT,
  failed_stage dispatch_failed_stage,
  worker_id TEXT,
  claimed_at TIMESTAMP,
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  next_retry_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_dispatch_jobs_run
ON dispatch_jobs(run_id, status);

CREATE INDEX idx_dispatch_jobs_workspace_status
ON dispatch_jobs(workspace_id, status, created_at ASC);

CREATE INDEX idx_dispatch_jobs_store_active
ON dispatch_jobs(store_id, status);

COMMIT;

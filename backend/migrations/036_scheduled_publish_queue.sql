-- Scheduled publish queue: commands + jobs (plan only, no runner in this migration)

CREATE TABLE IF NOT EXISTS scheduled_publish_commands (
  id                  BIGSERIAL PRIMARY KEY,
  workspace_id        UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  store_id            INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  store_code          TEXT NOT NULL,
  title               TEXT NULL,
  selection_mode      TEXT NOT NULL DEFAULT 'ready_next',
  requested_count     INTEGER NOT NULL,
  eligible_count      INTEGER NOT NULL DEFAULT 0,
  skipped_count       INTEGER NOT NULL DEFAULT 0,
  created_job_count   INTEGER NOT NULL DEFAULT 0,
  start_at            TIMESTAMPTZ NOT NULL,
  interval_seconds    INTEGER NOT NULL,
  quantity            INTEGER NOT NULL DEFAULT 1,
  title_mode          TEXT NOT NULL DEFAULT 'titlebot',
  status              TEXT NOT NULL DEFAULT 'scheduled',
  created_by          TEXT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paused_at           TIMESTAMPTZ NULL,
  cancelled_at        TIMESTAMPTZ NULL,
  completed_at        TIMESTAMPTZ NULL,
  last_error          TEXT NULL,
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS scheduled_publish_jobs (
  id              BIGSERIAL PRIMARY KEY,
  workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  command_id      BIGINT NOT NULL REFERENCES scheduled_publish_commands(id) ON DELETE CASCADE,
  store_id        INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  store_code      TEXT NOT NULL,
  pool_id         BIGINT NOT NULL,
  asin            TEXT NULL,
  scheduled_at    TIMESTAMPTZ NOT NULL,
  status          TEXT NOT NULL DEFAULT 'scheduled',
  attempt_count   INTEGER NOT NULL DEFAULT 0,
  published_at    TIMESTAMPTZ NULL,
  failed_at       TIMESTAMPTZ NULL,
  cancelled_at    TIMESTAMPTZ NULL,
  error_message   TEXT NULL,
  result          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sched_pub_cmd_workspace_store_status_start
  ON scheduled_publish_commands (workspace_id, store_id, status, start_at);

CREATE INDEX IF NOT EXISTS idx_sched_pub_cmd_workspace_created
  ON scheduled_publish_commands (workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sched_pub_job_workspace_cmd_status_at
  ON scheduled_publish_jobs (workspace_id, command_id, status, scheduled_at);

CREATE INDEX IF NOT EXISTS idx_sched_pub_job_workspace_store_status_at
  ON scheduled_publish_jobs (workspace_id, store_id, status, scheduled_at);

CREATE INDEX IF NOT EXISTS idx_sched_pub_job_pool_id
  ON scheduled_publish_jobs (pool_id);

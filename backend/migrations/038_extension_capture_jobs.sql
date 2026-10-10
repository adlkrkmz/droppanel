-- Extension capture jobs: persistent bulk capture queue (extension = capture client only)

CREATE TABLE IF NOT EXISTS extension_capture_commands (
  id                  BIGSERIAL PRIMARY KEY,
  workspace_id        UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  store_code          TEXT NOT NULL,
  operation_type      TEXT NOT NULL,
  title_mode          TEXT NOT NULL DEFAULT 'titlebot',
  quantity            INTEGER NOT NULL DEFAULT 1,
  delay_sec           INTEGER NOT NULL DEFAULT 30,
  status              TEXT NOT NULL DEFAULT 'queued',
  total_count         INTEGER NOT NULL DEFAULT 0,
  captured_count      INTEGER NOT NULL DEFAULT 0,
  failed_count        INTEGER NOT NULL DEFAULT 0,
  published_count     INTEGER NOT NULL DEFAULT 0,
  added_count         INTEGER NOT NULL DEFAULT 0,
  skipped_count       INTEGER NOT NULL DEFAULT 0,
  publish_command_id  BIGINT NULL REFERENCES scheduled_publish_commands(id) ON DELETE SET NULL,
  publish_job_seq     INTEGER NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at        TIMESTAMPTZ NULL,
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS extension_capture_items (
  id                      BIGSERIAL PRIMARY KEY,
  command_id              BIGINT NOT NULL REFERENCES extension_capture_commands(id) ON DELETE CASCADE,
  workspace_id            UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  asin                    TEXT NOT NULL,
  amazon_url              TEXT NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'capture_pending',
  capture_payload         JSONB NULL,
  pool_id                 BIGINT NULL,
  scheduled_publish_job_id BIGINT NULL REFERENCES scheduled_publish_jobs(id) ON DELETE SET NULL,
  error_message           TEXT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  captured_at             TIMESTAMPTZ NULL,
  completed_at            TIMESTAMPTZ NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ext_capture_items_command_asin
  ON extension_capture_items (command_id, asin);

CREATE INDEX IF NOT EXISTS idx_ext_capture_cmd_workspace_status
  ON extension_capture_commands (workspace_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_ext_capture_items_command_status
  ON extension_capture_items (command_id, status);

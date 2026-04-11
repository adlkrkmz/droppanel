-- Kalıcı panel bildirimleri (son 24 saat; eskiler cleanup ile silinir)
CREATE TABLE IF NOT EXISTS notifications (
  id            BIGSERIAL PRIMARY KEY,
  workspace_id  UUID NOT NULL,
  type          TEXT NOT NULL DEFAULT 'info',
  title         TEXT NOT NULL,
  message       TEXT NOT NULL DEFAULT '',
  "read"        BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_workspace_created ON notifications (workspace_id, created_at DESC);

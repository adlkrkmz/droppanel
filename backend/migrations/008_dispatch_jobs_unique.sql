BEGIN;
CREATE UNIQUE INDEX IF NOT EXISTS uq_dispatch_jobs_workspace_asin_active
ON dispatch_jobs (workspace_id, asin)
WHERE status IN ('pending', 'claimed', 'extract_running', 'extract_done',
                 'ai_running', 'ai_done', 'listing_running', 'retry_waiting');
COMMIT;

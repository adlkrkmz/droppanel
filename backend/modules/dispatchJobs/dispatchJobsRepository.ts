import { db, query } from "../../db/client"

type DispatchRunRow = {
  id: number
  workspace_id: string
  store_id: number
  store_code: string
  delay_seconds: number
  quantity: number
  status: "pending" | "running" | "completed" | "failed" | "cancelled"
  total_jobs: number
  completed_jobs: number
  failed_jobs: number
  created_at: string
  started_at: string | null
  completed_at: string | null
  updated_at: string
}

type DispatchJobRow = {
  id: number
  run_id: number
  workspace_id: string
  store_id: number
  store_code: string
  asin: string
  pool_id: number | null
  status:
    | "pending"
    | "claimed"
    | "extract_running"
    | "extract_done"
    | "ai_running"
    | "ai_done"
    | "listing_running"
    | "listing_done"
    | "failed"
    | "retry_waiting"
    | "cancelled"
  quantity: number
  delay_seconds: number
  attempt_count: number
  max_attempts: number
  last_error: string | null
  failed_stage: "extract" | "ai" | "listing" | "claim" | "unknown" | null
  worker_id: string | null
  claimed_at: string | null
  started_at: string | null
  completed_at: string | null
  next_retry_at: string | null
  created_at: string
  updated_at: string
}

export async function createDispatchRun(
  workspaceId: string,
  storeId: number,
  storeCode: string,
  delaySeconds: number,
  quantity: number,
  totalJobs: number
): Promise<DispatchRunRow> {
  const result = await query<DispatchRunRow>(
    `INSERT INTO dispatch_runs (
       workspace_id, store_id, store_code, delay_seconds, quantity, total_jobs, status, created_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', NOW(), NOW())
     RETURNING
       id, workspace_id, store_id, store_code, delay_seconds, quantity, status,
       total_jobs, completed_jobs, failed_jobs,
       created_at::text, started_at::text, completed_at::text, updated_at::text`,
    [workspaceId, storeId, storeCode, delaySeconds, quantity, totalJobs]
  )

  const row = result.rows[0]
  if (!row) throw new Error("createDispatchRun failed: no row returned")
  return row
}

export async function createDispatchJobsBulk(
  runId: number,
  workspaceId: string,
  storeId: number,
  storeCode: string,
  jobs: Array<{ asin: string; poolId: number | null; quantity: number; delaySeconds: number }>
): Promise<number> {
  if (jobs.length === 0) return 0

  const asins = jobs.map(j => j.asin)
  const poolIds = jobs.map(j => j.poolId)
  const quantities = jobs.map(j => j.quantity)
  const delays = jobs.map(j => j.delaySeconds)

  const result = await query(
    `INSERT INTO dispatch_jobs (
       run_id, workspace_id, store_id, store_code, asin, pool_id, quantity, delay_seconds, status, created_at, updated_at
     )
     SELECT
       $1::bigint,
       $2::uuid,
       $3::int,
       $4::text,
       u.asin,
       u.pool_id,
       u.quantity,
       u.delay_seconds,
       'pending'::dispatch_job_status,
       NOW(),
       NOW()
     FROM UNNEST($5::text[], $6::bigint[], $7::int[], $8::int[]) AS u(asin, pool_id, quantity, delay_seconds)
     ON CONFLICT DO NOTHING`,
    [runId, workspaceId, storeId, storeCode, asins, poolIds, quantities, delays]
  )

  return result.rowCount ?? 0
}

export async function claimNextJob(
  workspaceId: string,
  storeCode: string | null,
  workerId: string
): Promise<DispatchJobRow | null> {
  const client = await db.connect()
  try {
    await client.query("BEGIN")

    // 1. Store lock kontrolü
    const lockCheck = await client.query(
      `SELECT 1
       FROM dispatch_jobs
       WHERE workspace_id = $1
         AND ($2::text IS NULL OR store_code = $2)
         AND status IN ('claimed','extract_running','ai_running','listing_running')
       LIMIT 1`,
      [workspaceId, storeCode]
    )

    if (lockCheck.rows.length > 0) {
      await client.query("COMMIT")
      return null
    }

    // 2. Pending job seç (rastgele) ve satırı kilitle
    const candidate = await client.query<{ id: number }>(
      `SELECT id
       FROM dispatch_jobs
       WHERE workspace_id = $1
         AND ($2::text IS NULL OR store_code = $2)
         AND status = 'pending'
         AND (next_retry_at IS NULL OR next_retry_at <= NOW())
       ORDER BY RANDOM()
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
      [workspaceId, storeCode]
    )

    const jobId = candidate.rows[0]?.id
    if (!jobId) {
      await client.query("COMMIT")
      return null
    }

    // 3. Claim et
    const result = await client.query<DispatchJobRow>(
      `UPDATE dispatch_jobs
       SET status = 'claimed',
           worker_id = $2,
           claimed_at = NOW(),
           updated_at = NOW()
       WHERE id = $1
       RETURNING
         id, run_id, workspace_id, store_id, store_code, asin, pool_id, status,
         quantity, delay_seconds, attempt_count, max_attempts, last_error, failed_stage,
         worker_id, claimed_at::text, started_at::text, completed_at::text,
         next_retry_at::text, created_at::text, updated_at::text`,
      [jobId, workerId]
    )

    await client.query("COMMIT")
    return result.rows[0] ?? null
  } catch (err) {
    await client.query("ROLLBACK")
    throw err
  } finally {
    client.release()
  }
}

export async function reportJobProgress(
  jobId: number,
  status: DispatchJobRow["status"],
  error?: string,
  failedStage?: NonNullable<DispatchJobRow["failed_stage"]>
): Promise<DispatchJobRow | null> {
  const result = await query<DispatchJobRow>(
    `UPDATE dispatch_jobs j
     SET
       status = CASE
         WHEN $2::dispatch_job_status = 'failed'
           AND (j.attempt_count + 1) < j.max_attempts
         THEN 'retry_waiting'::dispatch_job_status
         ELSE $2::dispatch_job_status
       END,
       last_error = CASE
         WHEN $2::dispatch_job_status = 'failed' THEN COALESCE($3::text, j.last_error)
         ELSE $3::text
       END,
       failed_stage = CASE
         WHEN $2::dispatch_job_status = 'failed' THEN COALESCE($4::dispatch_failed_stage, j.failed_stage)
         ELSE $4::dispatch_failed_stage
       END,
       attempt_count = CASE
         WHEN $2::dispatch_job_status = 'failed' THEN j.attempt_count + 1
         ELSE j.attempt_count
       END,
       next_retry_at = CASE
         WHEN $2::dispatch_job_status = 'failed' AND (j.attempt_count + 1) < j.max_attempts
         THEN NOW() + interval '2 minutes'
         ELSE NULL
       END,
       completed_at = CASE
         WHEN $2::dispatch_job_status = 'listing_done' THEN NOW()
         ELSE j.completed_at
       END,
       updated_at = NOW()
     WHERE j.id = $1
     RETURNING
       j.id, j.run_id, j.workspace_id, j.store_id, j.store_code, j.asin, j.pool_id, j.status,
       j.quantity, j.delay_seconds, j.attempt_count, j.max_attempts, j.last_error, j.failed_stage,
       j.worker_id, j.claimed_at::text, j.started_at::text, j.completed_at::text, j.next_retry_at::text,
       j.created_at::text, j.updated_at::text`,
    [jobId, status, error ?? null, failedStage ?? null]
  )

  return result.rows[0] ?? null
}

export async function updateRunCounters(runId: number): Promise<DispatchRunRow | null> {
  const result = await query<DispatchRunRow>(
    `WITH stats AS (
       SELECT
         COUNT(*) FILTER (WHERE status = 'listing_done') AS completed_jobs,
         COUNT(*) FILTER (WHERE status = 'failed' AND attempt_count >= max_attempts) AS failed_jobs,
         COUNT(*) FILTER (
          WHERE status NOT IN ('listing_done', 'failed', 'cancelled')
          OR (status = 'failed' AND attempt_count < max_attempts)
        ) AS active_jobs,
         COUNT(*) AS total_jobs
       FROM dispatch_jobs
       WHERE run_id = $1
     )
     UPDATE dispatch_runs r
     SET
       completed_jobs = stats.completed_jobs::int,
       failed_jobs = stats.failed_jobs::int,
       status = CASE
         WHEN stats.active_jobs = 0 THEN 'completed'::dispatch_run_status
         WHEN r.status = 'pending' THEN 'running'::dispatch_run_status
         ELSE r.status
       END,
       started_at = CASE
         WHEN r.started_at IS NULL THEN NOW()
         ELSE r.started_at
       END,
       completed_at = CASE
         WHEN stats.active_jobs = 0 THEN NOW()
         ELSE r.completed_at
       END,
       updated_at = NOW()
     FROM stats
     WHERE r.id = $1
     RETURNING
       r.id, r.workspace_id, r.store_id, r.store_code, r.delay_seconds, r.quantity, r.status,
       r.total_jobs, r.completed_jobs, r.failed_jobs,
       r.created_at::text, r.started_at::text, r.completed_at::text, r.updated_at::text`,
    [runId]
  )

  return result.rows[0] ?? null
}

export async function getRunStatus(workspaceId: string, runId: number): Promise<{
  run: DispatchRunRow | null
  summary: {
    pending: number
    claimed: number
    extract_running: number
    extract_done: number
    ai_running: number
    ai_done: number
    listing_running: number
    listing_done: number
    failed: number
    retry_waiting: number
    cancelled: number
    total: number
  }
  jobs: DispatchJobRow[]
}> {
  const runRes = await query<DispatchRunRow>(
    `SELECT
       id, workspace_id, store_id, store_code, delay_seconds, quantity, status,
       total_jobs, completed_jobs, failed_jobs,
       created_at::text, started_at::text, completed_at::text, updated_at::text
     FROM dispatch_runs
     WHERE workspace_id = $1 AND id = $2
     LIMIT 1`,
    [workspaceId, runId]
  )

  const summaryRes = await query<{
    pending: string
    claimed: string
    extract_running: string
    extract_done: string
    ai_running: string
    ai_done: string
    listing_running: string
    listing_done: string
    failed: string
    retry_waiting: string
    cancelled: string
    total: string
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'pending') AS pending,
       COUNT(*) FILTER (WHERE status = 'claimed') AS claimed,
       COUNT(*) FILTER (WHERE status = 'extract_running') AS extract_running,
       COUNT(*) FILTER (WHERE status = 'extract_done') AS extract_done,
       COUNT(*) FILTER (WHERE status = 'ai_running') AS ai_running,
       COUNT(*) FILTER (WHERE status = 'ai_done') AS ai_done,
       COUNT(*) FILTER (WHERE status = 'listing_running') AS listing_running,
       COUNT(*) FILTER (WHERE status = 'listing_done') AS listing_done,
       COUNT(*) FILTER (WHERE status = 'failed') AS failed,
       COUNT(*) FILTER (WHERE status = 'retry_waiting') AS retry_waiting,
       COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled,
       COUNT(*) AS total
     FROM dispatch_jobs
     WHERE workspace_id = $1 AND run_id = $2`,
    [workspaceId, runId]
  )

  const jobsRes = await query<DispatchJobRow>(
    `SELECT
       id, run_id, workspace_id, store_id, store_code, asin, pool_id, status,
       quantity, delay_seconds, attempt_count, max_attempts, last_error, failed_stage,
       worker_id, claimed_at::text, started_at::text, completed_at::text, next_retry_at::text,
       created_at::text, updated_at::text
     FROM dispatch_jobs
     WHERE workspace_id = $1 AND run_id = $2
     ORDER BY created_at ASC, id ASC`,
    [workspaceId, runId]
  )

  const summaryRow = summaryRes.rows[0]
  const toInt = (v: string | undefined): number => parseInt(v ?? "0", 10)

  return {
    run: runRes.rows[0] ?? null,
    summary: {
      pending: toInt(summaryRow?.pending),
      claimed: toInt(summaryRow?.claimed),
      extract_running: toInt(summaryRow?.extract_running),
      extract_done: toInt(summaryRow?.extract_done),
      ai_running: toInt(summaryRow?.ai_running),
      ai_done: toInt(summaryRow?.ai_done),
      listing_running: toInt(summaryRow?.listing_running),
      listing_done: toInt(summaryRow?.listing_done),
      failed: toInt(summaryRow?.failed),
      retry_waiting: toInt(summaryRow?.retry_waiting),
      cancelled: toInt(summaryRow?.cancelled),
      total: toInt(summaryRow?.total),
    },
    jobs: jobsRes.rows,
  }
}

export async function getActiveRuns(workspaceId: string): Promise<DispatchRunRow[]> {
  const result = await query<DispatchRunRow>(
    `SELECT
       id, workspace_id, store_id, store_code, delay_seconds, quantity, status,
       total_jobs, completed_jobs, failed_jobs,
       created_at::text, started_at::text, completed_at::text, updated_at::text
     FROM dispatch_runs
     WHERE workspace_id = $1
       AND status IN ('pending', 'running')
       AND created_at > NOW() - interval '24 hours'
     ORDER BY created_at DESC`,
    [workspaceId]
  )

  return result.rows
}

export async function cleanupStaleClaimedJobs(workerId: string): Promise<{ cleaned: number }> {
  const result = await query(
    `UPDATE dispatch_jobs
     SET
       status = 'pending',
       claimed_at = NULL,
       worker_id = NULL,
       updated_at = NOW()
     WHERE worker_id = $1
       AND status = 'claimed'
       AND claimed_at < NOW() - interval '3 minutes'`,
    [workerId]
  )

  return { cleaned: result.rowCount ?? 0 }
}

import { query } from "../../db/client"
import {
  createDispatchJobsBulk,
  createDispatchRun,
  claimNextJob,
  reportJobProgress,
  updateRunCounters,
  getRunStatus as getRunStatusRepo,
  getActiveRuns as getActiveRunsRepo,
} from "./dispatchJobsRepository"
import type {
  ClaimNextJobResult,
  CreateRunRequest,
  DispatchJob,
  DispatchRun,
  RunStatusResult,
  ReportJobRequest,
} from "./dispatchJobsTypes"

type CreateRunRow = Awaited<ReturnType<typeof createDispatchRun>>
type JobRow = Awaited<ReturnType<typeof reportJobProgress>>
type ClaimRow = Awaited<ReturnType<typeof claimNextJob>>
type RunRow = Awaited<ReturnType<typeof updateRunCounters>>

function mapRun(row: CreateRunRow): DispatchRun {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    storeId: row.store_id,
    storeCode: row.store_code,
    delaySeconds: row.delay_seconds,
    quantity: row.quantity,
    status: row.status,
    totalJobs: row.total_jobs,
    completedJobs: row.completed_jobs,
    failedJobs: row.failed_jobs,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  }
}

function mapJob(row: NonNullable<ClaimRow>): DispatchJob {
  return {
    id: row.id,
    runId: row.run_id,
    workspaceId: row.workspace_id,
    storeId: row.store_id,
    storeCode: row.store_code,
    asin: row.asin,
    poolId: row.pool_id,
    status: row.status,
    quantity: row.quantity,
    delaySeconds: row.delay_seconds,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    lastError: row.last_error,
    failedStage: row.failed_stage,
    workerId: row.worker_id,
    claimedAt: row.claimed_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    nextRetryAt: row.next_retry_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function createRunWithJobs(
  workspaceId: string,
  storeCode: string,
  poolIds: number[],
  quantity: number,
  delaySeconds: number
): Promise<DispatchRun> {
  if (quantity < 1) throw new Error("quantity must be >= 1")
  if (delaySeconds < 0) throw new Error("delaySeconds must be >= 0")
  if (!Array.isArray(poolIds) || poolIds.length === 0) throw new Error("poolIds must be non-empty")

  const storeResult = await query<{ id: number }>(
    `SELECT id FROM stores
     WHERE workspace_id = $1 AND store_code = $2 AND status = 'active'
     LIMIT 1`,
    [workspaceId, storeCode]
  )
  const storeId = storeResult.rows[0]?.id
  if (!storeId) throw new Error(`Active store not found: storeCode="${storeCode}"`)

  const poolResult = await query<{ asin: string; pool_id: number | null }>(
    `SELECT ar.asin, ap.id AS pool_id
     FROM asin_pool ap
     INNER JOIN asin_registry ar ON ar.id = ap.asin_registry_id
     WHERE ap.workspace_id = $1
       AND ap.id = ANY($2::bigint[])`,
    [workspaceId, poolIds]
  )

  const jobs = poolResult.rows.map(r => ({
    asin: r.asin,
    poolId: r.pool_id,
    quantity,
    delaySeconds,
  }))

  const run = await createDispatchRun(workspaceId, storeId, storeCode, delaySeconds, quantity, jobs.length)
  await createDispatchJobsBulk(run.id, workspaceId, storeId, storeCode, jobs)

  const startedRun = await query<CreateRunRow>(
    `UPDATE dispatch_runs
     SET status = 'running',
         started_at = NOW(),
         updated_at = NOW()
     WHERE id = $1
     RETURNING
       id, workspace_id, store_id, store_code, delay_seconds, quantity, status,
       total_jobs, completed_jobs, failed_jobs,
       created_at::text, started_at::text, completed_at::text, updated_at::text`,
    [run.id]
  )

  const updated = startedRun.rows[0]
  if (!updated) throw new Error("Failed to update dispatch_runs to running")
  return mapRun(updated)
}

export async function claimNext(
  workspaceId: string,
  storeCode: string | null,
  workerId: string
): Promise<ClaimNextJobResult> {
  console.log("[claimNext] entered, params:", workspaceId, storeCode, workerId)
  const claimed = await claimNextJob(workspaceId, storeCode, workerId)
  if (!claimed) return { job: null }
  return { job: mapJob(claimed) }
}

export async function reportProgress(
  jobId: number,
  workerId: string,
  status: ReportJobRequest["status"],
  error?: ReportJobRequest["error"],
  failedStage?: ReportJobRequest["failedStage"]
): Promise<{ job: DispatchJob | null; run: DispatchRun | null }> {
  if (!workerId || workerId.trim() === "") throw new Error("workerId is required")

  const jobRow = await reportJobProgress(jobId, status, error, failedStage)
  if (!jobRow) return { job: null, run: null }

  const runRow = await updateRunCounters(jobRow.run_id)
  return {
    job: mapJob(jobRow),
    run: runRow ? mapRun(runRow) : null,
  }
}

export async function getRunStatus(
  workspaceId: string,
  runId: number
): Promise<RunStatusResult> {
  const res = await getRunStatusRepo(workspaceId, runId)
  return {
    run: res.run ? mapRun(res.run as unknown as CreateRunRow) : null,
    summary: res.summary,
    jobs: res.jobs.map(r => mapJob(r as unknown as NonNullable<ClaimRow>)),
  }
}

export async function getActiveRuns(workspaceId: string): Promise<DispatchRun[]> {
  const runs = await getActiveRunsRepo(workspaceId)
  return runs.map(r => mapRun(r as unknown as CreateRunRow))
}


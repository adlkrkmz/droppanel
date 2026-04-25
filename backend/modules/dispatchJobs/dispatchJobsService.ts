import { query } from "../../db/client"
import { addNotification } from "../notifications/notificationService"
import {
  alertQueueStuck,
  alertScraperFailSpike,
  alertDispatchJobPermanentFailure,
} from "../notifications/telegramService"
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

type FailureClassification = {
  permanent: boolean
  effectiveMaxAttempts: number
  skipPoolOnTerminalFail: boolean
  notifyTelegram: boolean
}

function isJobTimeoutError(
  error: string | undefined,
  failureKind?: ReportJobRequest["failureKind"]
): boolean {
  if (failureKind === "job_timeout") return true
  const e = (error ?? "").trim()
  return e.includes("Timeout (60s)") || /job\s*timeout/i.test(e)
}

function isHttpClientPermanentError(error: string | undefined): boolean {
  const e = error ?? ""
  return (
    /\bAPI\s+400\b/.test(e) ||
    /\bAPI\s+404\b/.test(e) ||
    /\bHTTP\s*400\b/i.test(e) ||
    /\bHTTP\s*404\b/i.test(e) ||
    e.includes("Product not found in amazon_product_cache")
  )
}

function isKnownPermanentProductOrListingError(error: string | undefined): boolean {
  const e = error ?? ""
  if (isHttpClientPermanentError(error)) return true
  return (
    e.includes("publishOffer failed") ||
    e.includes("Pesticides") ||
    e.includes("too many item specifics") ||
    e.includes("Item Width") ||
    e.includes("Item Length") ||
    e.includes("Item Height") ||
    e.includes("Unbranded products") ||
    e.includes("policy")
  )
}

/** CAPTURE / Amazon scrape — en fazla 2 deneme (3. kural). */
function isCaptureOrAmazonScrapeError(
  error: string | undefined,
  failedStage?: ReportJobRequest["failedStage"]
): boolean {
  const low = (error ?? "").toLowerCase()
  const stageHit = failedStage === "extract"
  if (stageHit) {
    if (low.includes("capture") || low.includes("yanıtsız") || low.includes("yanitsiz")) return true
    if (low.includes("scrape")) return true
    if (low.includes("chrome.runtime")) return true
  }
  return low.includes("capture") || low.includes("yanıtsız") || low.includes("yanitsiz")
}

/**
 * Kalıcı: job timeout (retry yok), HTTP 4xx / ürün-listing kalıcı metinleri.
 * CAPTURE+scrape: max 2 deneme; aşımda skip+Telegram.
 * Diğer: max_attempts kadar retry_waiting (claim ile tekrar alınır).
 */
function classifyDispatchFailure(input: {
  error?: string
  failedStage?: ReportJobRequest["failedStage"]
  failureKind?: ReportJobRequest["failureKind"]
  maxAttempts: number
  attemptCount: number
}): FailureClassification {
  const { error, failedStage, failureKind, maxAttempts, attemptCount } = input
  const nextAfterFail = attemptCount + 1

  if (isJobTimeoutError(error, failureKind)) {
    return {
      permanent: true,
      effectiveMaxAttempts: maxAttempts,
      skipPoolOnTerminalFail: false,
      notifyTelegram: false,
    }
  }

  {
    const e = error ?? ""
    if (e.includes("25019") || e.toLowerCase().includes("high-risk") || e.toLowerCase().includes("high risk")) {
      return {
        permanent: true,
        effectiveMaxAttempts: maxAttempts,
        skipPoolOnTerminalFail: true,
        notifyTelegram: true,
      }
    }
  }

  if (isKnownPermanentProductOrListingError(error)) {
    return {
      permanent: true,
      effectiveMaxAttempts: maxAttempts,
      skipPoolOnTerminalFail: true,
      notifyTelegram: true,
    }
  }

  if (isCaptureOrAmazonScrapeError(error, failedStage)) {
    const effectiveMax = Math.min(2, Math.max(1, maxAttempts))
    const willRetry = nextAfterFail < effectiveMax
    return {
      permanent: false,
      effectiveMaxAttempts: effectiveMax,
      skipPoolOnTerminalFail: !willRetry,
      notifyTelegram: !willRetry,
    }
  }

  return {
    permanent: false,
    effectiveMaxAttempts: Math.max(1, maxAttempts),
    skipPoolOnTerminalFail: false,
    notifyTelegram: false,
  }
}

let lastQueueAlertTime = 0
let lastScraperAlertTime = 0

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
    jobType: (row.job_type ?? "scrape_and_list") as DispatchJob["jobType"],
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

  const storeResult = await query<{ id: number; name: string }>(
    `SELECT id, name FROM stores
     WHERE workspace_id = $1 AND store_code = $2 AND status = 'active'
     LIMIT 1`,
    [workspaceId, storeCode]
  )
  const storeRow = storeResult.rows[0]
  if (!storeRow?.id) throw new Error("Active store not found")
  const storeId = storeRow.id
  const storeDisplayName = storeRow.name?.trim() || "Store"

  const poolResult = await query<{ asin: string; pool_id: number | null; pipeline_stage: string }>(
    `SELECT ar.asin, ap.id AS pool_id, ap.pipeline_stage
     FROM asin_pool ap
     INNER JOIN asin_registry ar ON ar.id = ap.asin_registry_id
     WHERE ap.workspace_id = $1
       AND ap.id = ANY($2::bigint[])`,
    [workspaceId, poolIds]
  )

  function resolveJobType(stage: string): string {
    if (stage === "ai_generated") return "list_only"
    if (stage === "scraped")      return "ai_and_list"
    return "scrape_and_list"
  }

  const jobs = poolResult.rows.map(r => ({
    asin: r.asin,
    poolId: r.pool_id,
    quantity,
    delaySeconds,
    jobType: resolveJobType(r.pipeline_stage ?? ""),
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
  try {
    await addNotification(
      workspaceId,
      "info",
      "Dispatch Run Başlatıldı",
      `${jobs.length} ürün kuyruğa alındı — ${storeDisplayName}`
    )
  } catch {
    /* bildirim ana akışı bozmasın */
  }
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
  failedStage?: ReportJobRequest["failedStage"],
  failureKind?: ReportJobRequest["failureKind"]
): Promise<{ job: DispatchJob | null; run: DispatchRun | null }> {
  if (!workerId || workerId.trim() === "") throw new Error("workerId is required")

  if (status !== "failed") {
    const jobRow = await reportJobProgress(jobId, status, error, failedStage, false, null)
    if (!jobRow) return { job: null, run: null }
    const runRow = await updateRunCounters(jobRow.run_id)
    return { job: mapJob(jobRow), run: runRow ? mapRun(runRow) : null }
  }

  const pre = await query<{
    attempt_count: number
    max_attempts: number
    pool_id: number | null
    asin: string
    store_code: string
  }>(
    `SELECT attempt_count, max_attempts, pool_id, asin, store_code
     FROM dispatch_jobs WHERE id = $1 LIMIT 1`,
    [jobId]
  )
  const snapshot = pre.rows[0]

  const classification = snapshot
    ? classifyDispatchFailure({
        error,
        failedStage,
        failureKind,
        maxAttempts: snapshot.max_attempts,
        attemptCount: snapshot.attempt_count,
      })
    : {
        permanent: false,
        effectiveMaxAttempts: 3,
        skipPoolOnTerminalFail: false,
        notifyTelegram: false,
      }

  if (classification.permanent) {
    console.warn(`[dispatchJobs] Non-retryable failure for job ${jobId}: ${error ?? ""}`)
  }

  const effectiveArg = classification.permanent ? null : classification.effectiveMaxAttempts

  const jobRow = await reportJobProgress(
    jobId,
    status,
    error,
    failedStage,
    classification.permanent,
    effectiveArg
  )
  if (!jobRow) return { job: null, run: null }

  const terminalFailed = jobRow.status === "failed"
  if (terminalFailed && classification.skipPoolOnTerminalFail && jobRow.pool_id != null) {
    const poolId = jobRow.pool_id
    try {
      await query(`UPDATE dispatch_jobs SET pool_id = NULL WHERE pool_id = $1`, [poolId])
      await query(`DELETE FROM asin_pool WHERE id = $1`, [poolId])
    } catch (e: unknown) {
      console.warn(`[dispatchJobs] Failed to delete asin_pool id=${poolId}:`, e)
    }
  }

  if (terminalFailed && classification.notifyTelegram) {
    const msg = jobRow.last_error ?? error ?? ""
    void alertDispatchJobPermanentFailure(jobRow.asin, jobRow.store_code, msg).catch((e: unknown) => {
      console.warn("[dispatchJobs] Telegram alert failed:", e)
    })
  }

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

export async function checkQueueHealth(): Promise<void> {
  try {
    const result = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM dispatch_jobs
       WHERE status = 'pending'
         AND created_at < NOW() - INTERVAL '10 minutes'`,
      []
    )
    const stuckCount = parseInt(result.rows[0]?.count ?? "0", 10)

    if (stuckCount > 0) {
      const now = Date.now()
      // Aynı alert'i 30 dakikada bir gönder
      if (now - lastQueueAlertTime > 30 * 60 * 1000) {
        lastQueueAlertTime = now
        await alertQueueStuck(stuckCount, 10)
      }
    }
  } catch (e) {
    console.error("[QueueHealth] Check failed:", e)
  }
}

export async function checkScraperHealth(): Promise<void> {
  try {
    const result = await query<{ fail_count: string; total_count: string }>(
      `SELECT
        COUNT(*) FILTER (WHERE status = 'failed')::text AS fail_count,
        COUNT(*)::text AS total_count
       FROM dispatch_jobs
       WHERE created_at > NOW() - INTERVAL '30 minutes'
         AND job_type = 'scrape_and_list'`,
      []
    )

    const failCount = parseInt(result.rows[0]?.fail_count ?? "0", 10)
    const totalCount = parseInt(result.rows[0]?.total_count ?? "0", 10)

    if (totalCount >= 5 && failCount / totalCount >= 0.7) {
      const now = Date.now()
      if (now - lastScraperAlertTime > 30 * 60 * 1000) {
        lastScraperAlertTime = now
        await alertScraperFailSpike(failCount, totalCount)
      }
    }
  } catch (e) {
    console.error("[ScraperHealth] Check failed:", e)
  }
}

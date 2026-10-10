import { query } from "../../db/client"
import { connectedStoreSubquery } from "./stockGuardActiveStores"
import {
  countWaitingCatalogRows,
  findDueStockGuardForStore,
} from "./stockGuardDueFinder"
import type { ScanJobStatus } from "./stockGuardTypes"

const CONNECTED_STORES_SQL = connectedStoreSubquery()

export type ScanJobRow = {
  id: number
  workspaceId: string
  storeId: number
  status: ScanJobStatus
  estimatedTokens: number | null
  scheduledFor: string
}

export async function hasRunningJob(workspaceId: string): Promise<boolean> {
  try {
    const res = await query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM stock_guard_scan_jobs
       WHERE workspace_id = $1::uuid
         AND status = 'running'
         AND store_id IN (${CONNECTED_STORES_SQL})`,
      [workspaceId]
    )
    return parseInt(res.rows[0]?.c ?? "0", 10) > 0
  } catch {
    return false
  }
}

export async function hasActiveJobForStore(
  workspaceId: string,
  storeId: number
): Promise<boolean> {
  try {
    const res = await query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM stock_guard_scan_jobs
       WHERE workspace_id = $1::uuid AND store_id = $2::bigint
         AND status IN ('queued', 'running', 'skipped_waiting_tokens')`,
      [workspaceId, storeId]
    )
    return parseInt(res.rows[0]?.c ?? "0", 10) > 0
  } catch {
    return false
  }
}

export async function createScanJob(input: {
  workspaceId: string
  storeId: number
  estimatedTokens: number
  scheduledFor?: Date
  priority?: number
}): Promise<number> {
  const res = await query<{ id: number }>(
    `INSERT INTO stock_guard_scan_jobs (
       workspace_id, store_id, job_type, status, priority,
       estimated_tokens, scheduled_for, created_at, updated_at
     ) VALUES ($1::uuid, $2::bigint, 'source_scan', 'queued', $3::integer, $4::integer, $5::timestamptz, NOW(), NOW())
     RETURNING id`,
    [
      input.workspaceId,
      input.storeId,
      input.priority ?? 100,
      input.estimatedTokens,
      input.scheduledFor ?? new Date(),
    ]
  )
  return Number(res.rows[0]!.id)
}

export async function pickNextRunnableJob(workspaceId: string): Promise<ScanJobRow | null> {
  try {
    const res = await query<{
      id: number
      workspace_id: string
      store_id: number
      status: string
      estimated_tokens: number | null
      scheduled_for: string
    }>(
      `SELECT id, workspace_id, store_id, status, estimated_tokens, scheduled_for::text
       FROM stock_guard_scan_jobs
       WHERE workspace_id = $1::uuid
         AND status IN ('queued', 'skipped_waiting_tokens')
         AND scheduled_for <= NOW()
         AND store_id IN (${CONNECTED_STORES_SQL})
       ORDER BY scheduled_for ASC, priority ASC, id ASC
       LIMIT 1`,
      [workspaceId]
    )
    const row = res.rows[0]
    if (!row) return null
    return {
      id: Number(row.id),
      workspaceId: row.workspace_id,
      storeId: Number(row.store_id),
      status: row.status as ScanJobStatus,
      estimatedTokens: row.estimated_tokens,
      scheduledFor: row.scheduled_for,
    }
  } catch {
    return null
  }
}

export async function markJobRunning(jobId: number, workspaceId: string): Promise<boolean> {
  const res = await query(
    `UPDATE stock_guard_scan_jobs
     SET status = 'running', started_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND workspace_id = $2::uuid AND status IN ('queued', 'skipped_waiting_tokens')`,
    [jobId, workspaceId]
  )
  return (res.rowCount ?? 0) > 0
}

export async function markJobCompleted(
  jobId: number,
  workspaceId: string,
  scanned: number,
  risks: number
): Promise<void> {
  await query(
    `UPDATE stock_guard_scan_jobs
     SET status = 'completed',
         scanned_count = $3,
         risk_count = $4,
         error_message = NULL,
         completed_at = NOW(),
         updated_at = NOW()
     WHERE id = $1 AND workspace_id = $2::uuid`,
    [jobId, workspaceId, scanned, risks]
  )
}

export async function markJobFailed(
  jobId: number,
  workspaceId: string,
  message: string
): Promise<void> {
  await query(
    `UPDATE stock_guard_scan_jobs
     SET status = 'failed',
         error_message = $3::text,
         completed_at = NOW(),
         updated_at = NOW()
     WHERE id = $1::bigint AND workspace_id = $2::uuid`,
    [jobId, workspaceId, message.slice(0, 500)]
  )
}

/** Debug: re-queue a failed job for connected store only (no DELETE). */
export async function requeueFailedJob(
  jobId: number,
  workspaceId: string
): Promise<boolean> {
  const res = await query(
    `UPDATE stock_guard_scan_jobs j
     SET status = 'queued',
         scheduled_for = NOW(),
         started_at = NULL,
         completed_at = NULL,
         error_message = NULL,
         updated_at = NOW()
     WHERE j.id = $1::bigint
       AND j.workspace_id = $2::uuid
       AND j.status = 'failed'
       AND j.store_id IN (${CONNECTED_STORES_SQL})`,
    [jobId, workspaceId]
  )
  return (res.rowCount ?? 0) > 0
}

export async function rescheduleJobForTokens(
  jobId: number,
  workspaceId: string,
  delayMinutes: number,
  errorMessage?: string
): Promise<void> {
  await query(
    `UPDATE stock_guard_scan_jobs
     SET status = 'skipped_waiting_tokens',
         scheduled_for = NOW() + make_interval(mins => $3::int),
         error_message = $4::text,
         updated_at = NOW()
     WHERE id = $1 AND workspace_id = $2::uuid`,
    [
      jobId,
      workspaceId,
      delayMinutes,
      (errorMessage ?? "Waiting for Keepa tokens").slice(0, 500),
    ]
  )
}

export async function getNextJobScheduledAt(
  workspaceId: string,
  storeId: number
): Promise<string | null> {
  try {
    const res = await query<{ scheduled_for: string | null }>(
      `SELECT MIN(scheduled_for)::text AS scheduled_for
       FROM stock_guard_scan_jobs
       WHERE workspace_id = $1::uuid AND store_id = $2::bigint
         AND status IN ('queued', 'skipped_waiting_tokens', 'running')`,
      [workspaceId, storeId]
    )
    return res.rows[0]?.scheduled_for ?? null
  } catch {
    return null
  }
}

export type StoreCatalogScheduleSummary = {
  dueNowCount: number
  waitingCount: number
  earliestDueAt: string | null
  earliestWaitingAt: string | null
}

export async function getStoreCatalogScheduleSummary(
  workspaceId: string,
  storeId: number
): Promise<StoreCatalogScheduleSummary> {
  const empty: StoreCatalogScheduleSummary = {
    dueNowCount: 0,
    waitingCount: 0,
    earliestDueAt: null,
    earliestWaitingAt: null,
  }
  try {
    const { summary } = await findDueStockGuardForStore({
      workspaceId,
      storeId,
      limit: 10_000,
    })
    const waiting = await countWaitingCatalogRows(workspaceId, storeId)
    return {
      dueNowCount: summary.eligibleAsins,
      waitingCount: waiting.waitingCount,
      earliestDueAt: summary.earliestDueAt,
      earliestWaitingAt: waiting.earliestWaitingAt,
    }
  } catch {
    return empty
  }
}

/** Next scan hint for UI: job queue, due-now catalog, or next waiting check. */
export async function getStoreNextScheduledScanAt(input: {
  workspaceId: string
  storeId: number
  stockGuardEnabled: boolean
}): Promise<{ nextScheduledAt: string | null; dueNowCount: number }> {
  const catalog = await getStoreCatalogScheduleSummary(
    input.workspaceId,
    input.storeId
  )
  const jobAt = await getNextJobScheduledAt(input.workspaceId, input.storeId)

  if (!input.stockGuardEnabled) {
    return { nextScheduledAt: catalog.earliestWaitingAt, dueNowCount: 0 }
  }

  if (catalog.dueNowCount > 0) {
    const dueAt = catalog.earliestDueAt
    const dueIso = dueAt ? new Date(dueAt).toISOString() : new Date().toISOString()
    if (jobAt) {
      const jobMs = new Date(jobAt).getTime()
      const dueMs = new Date(dueIso).getTime()
      return {
        nextScheduledAt:
          jobMs <= dueMs ? new Date(jobAt).toISOString() : dueIso,
        dueNowCount: catalog.dueNowCount,
      }
    }
    return { nextScheduledAt: dueIso, dueNowCount: catalog.dueNowCount }
  }

  const candidates: string[] = []
  if (jobAt) candidates.push(jobAt)
  if (catalog.earliestWaitingAt) candidates.push(catalog.earliestWaitingAt)
  if (candidates.length === 0) {
    return { nextScheduledAt: null, dueNowCount: 0 }
  }
  candidates.sort((a, b) => new Date(a).getTime() - new Date(b).getTime())
  return {
    nextScheduledAt: new Date(candidates[0]!).toISOString(),
    dueNowCount: 0,
  }
}

/** @deprecated Use getStoreNextScheduledScanAt */
export async function getNextScheduledAt(
  workspaceId: string,
  storeId: number
): Promise<string | null> {
  const r = await getStoreNextScheduledScanAt({
    workspaceId,
    storeId,
    stockGuardEnabled: true,
  })
  return r.nextScheduledAt
}

export async function countStoreJobsByStatus(
  workspaceId: string,
  storeId: number
): Promise<{ pendingJobs: number; runningJobs: number; skippedWaitingTokens: number }> {
  const out = { pendingJobs: 0, runningJobs: 0, skippedWaitingTokens: 0 }
  try {
    const res = await query<{ status: string; c: string }>(
      `SELECT status, COUNT(*)::text AS c FROM stock_guard_scan_jobs
       WHERE workspace_id = $1::uuid AND store_id = $2::bigint
         AND (
           status IN ('queued', 'running')
           OR (status = 'skipped_waiting_tokens' AND scheduled_for > NOW())
         )
       GROUP BY status`,
      [workspaceId, storeId]
    )
    for (const row of res.rows) {
      const n = parseInt(row.c, 10) || 0
      if (row.status === "running") out.runningJobs = n
      else if (row.status === "skipped_waiting_tokens") out.skippedWaitingTokens = n
      else out.pendingJobs += n
    }
  } catch {
    /* migration */
  }
  return out
}

export async function countJobsByStatus(workspaceId: string): Promise<Record<string, number>> {
  try {
    const res = await query<{ status: string; c: string }>(
      `SELECT status, COUNT(*)::text AS c
       FROM stock_guard_scan_jobs
       WHERE workspace_id = $1::uuid
         AND created_at > NOW() - INTERVAL '7 days'
         AND store_id IN (${CONNECTED_STORES_SQL})
         AND status NOT IN ('completed', 'failed')
         AND (
           status <> 'skipped_waiting_tokens'
           OR scheduled_for > NOW()
         )
       GROUP BY status`,
      [workspaceId]
    )
    const out: Record<string, number> = {}
    for (const r of res.rows) out[r.status] = parseInt(r.c, 10) || 0
    return out
  } catch {
    return {}
  }
}

export async function getLastCompletedAt(
  workspaceId: string,
  storeId: number
): Promise<string | null> {
  try {
    const res = await query<{ completed_at: string | null }>(
      `SELECT completed_at::text FROM stock_guard_scan_jobs
       WHERE workspace_id = $1::uuid AND store_id = $2::bigint AND status = 'completed'
       ORDER BY completed_at DESC NULLS LAST LIMIT 1`,
      [workspaceId, storeId]
    )
    return res.rows[0]?.completed_at ?? null
  } catch {
    return null
  }
}

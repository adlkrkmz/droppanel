// ----------------------------------------------------------------
// appStockGuardStatusService.ts — user-scoped Stock Guard status (Phase 5F)
// Read-only aggregates; no writes, scans, or scheduler triggers.
// ----------------------------------------------------------------

import { query } from "../../db/client"
import { STOCK_ALERTS_VISIBLE_SQL } from "../stockAlerts/stockAlertListQuery"
import { getLastCompletedAt } from "../stockGuard/stockGuardJobRepository"
import { STOCK_GUARD_SCAN_ELIGIBLE_QTY } from "../stockGuard/stockGuardScanEligibility"
import { loadGlobalKeepaFoundationConfig } from "../globalKeepa/globalKeepaConfig"
import { loadAmazonVerificationConfig } from "../amazonVerification/amazonVerificationConfig"
import { ensureStockGuardSettings } from "../stockGuard/stockGuardSettingsRepository"
import type { OwnedStore } from "./appOwnership"
import type { AppStockGuardStatus, AppStockGuardStatusResponse } from "./appTypes"

function sanitizeErrorMessage(raw: string | null | undefined): string | null {
  const msg = raw?.trim()
  if (!msg) return null
  const safe = msg.replace(/[\r\n\t]+/g, " ").slice(0, 200)
  if (/token|secret|oauth|password|authorization/i.test(safe)) {
    return "Scan failed"
  }
  return safe
}

async function getLatestScanJob(
  workspaceId: string,
  storeId:     number
): Promise<{
  lastScanAt:    string | null
  lastRunStatus: string | null
}> {
  try {
    const res = await query<{
      status: string
      started_at: string | null
      completed_at: string | null
      created_at: string | null
    }>(
      `SELECT status,
              started_at::text AS started_at,
              completed_at::text AS completed_at,
              created_at::text AS created_at
       FROM stock_guard_scan_jobs
       WHERE workspace_id = $1::uuid AND store_id = $2::bigint
       ORDER BY COALESCE(completed_at, started_at, created_at) DESC NULLS LAST
       LIMIT 1`,
      [workspaceId, storeId]
    )
    const row = res.rows[0]
    if (!row) {
      return { lastScanAt: null, lastRunStatus: null }
    }
    return {
      lastScanAt:    row.started_at ?? row.created_at ?? null,
      lastRunStatus: row.status?.trim() || null,
    }
  } catch {
    return { lastScanAt: null, lastRunStatus: null }
  }
}

async function getLastFailedJobError(
  workspaceId: string,
  storeId:     number
): Promise<string | null> {
  try {
    const res = await query<{ error_message: string | null }>(
      `SELECT error_message
       FROM stock_guard_scan_jobs
       WHERE workspace_id = $1::uuid
         AND store_id = $2::bigint
         AND status = 'failed'
       ORDER BY COALESCE(completed_at, started_at, created_at) DESC NULLS LAST
       LIMIT 1`,
      [workspaceId, storeId]
    )
    return sanitizeErrorMessage(res.rows[0]?.error_message)
  } catch {
    return null
  }
}

async function getAlertCounts(
  workspaceId: string,
  storeId:     number
): Promise<{
  pendingAlertsCount:    number
  processingAlertsCount: number
  failedAlertsCount:     number
  actionedAlertsCount:   number
  ignoredAlertsCount:    number
}> {
  const empty = {
    pendingAlertsCount:    0,
    processingAlertsCount: 0,
    failedAlertsCount:     0,
    actionedAlertsCount:   0,
    ignoredAlertsCount:    0,
  }
  try {
    const res = await query<{
      pending: string
      processing: string
      failed: string
      actioned: string
      ignored: string
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE sri.review_status = 'pending')::text AS pending,
         COUNT(*) FILTER (WHERE sri.review_status = 'processing')::text AS processing,
         COUNT(*) FILTER (WHERE sri.review_status = 'failed')::text AS failed,
         COUNT(*) FILTER (WHERE sri.review_status = 'actioned')::text AS actioned,
         COUNT(*) FILTER (WHERE sri.review_status = 'ignored')::text AS ignored
       FROM stock_review_items sri
       WHERE sri.workspace_id = $1::uuid
         AND sri.store_id = $2::bigint
         AND ${STOCK_ALERTS_VISIBLE_SQL}`,
      [workspaceId, storeId]
    )
    const row = res.rows[0]
    if (!row) return empty
    return {
      pendingAlertsCount:    parseInt(row.pending, 10) || 0,
      processingAlertsCount: parseInt(row.processing, 10) || 0,
      failedAlertsCount:     parseInt(row.failed, 10) || 0,
      actionedAlertsCount:   parseInt(row.actioned, 10) || 0,
      ignoredAlertsCount:    parseInt(row.ignored, 10) || 0,
    }
  } catch {
    return empty
  }
}

async function getProtectedListingsCount(
  workspaceId: string,
  storeId:     number
): Promise<number | null> {
  try {
    const res = await query<{ c: string }>(
      `SELECT COUNT(*)::text AS c
       FROM store_catalog_state scs
       WHERE scs.workspace_id = $1::uuid
         AND scs.store_id = $2::bigint
         AND scs.panel_hidden_at IS NULL
         AND scs.current_status = 'live'
         AND COALESCE(scs.stock_guard_enabled, true) = true
         AND ${STOCK_GUARD_SCAN_ELIGIBLE_QTY}`,
      [workspaceId, storeId]
    )
    return parseInt(res.rows[0]?.c ?? "0", 10) || 0
  } catch {
    return null
  }
}

async function getZeroQuantityListingsCount(
  workspaceId: string,
  storeId:     number
): Promise<number | null> {
  try {
    const res = await query<{ c: string }>(
      `SELECT COUNT(*)::text AS c
       FROM store_catalog_state scs
       WHERE scs.workspace_id = $1::uuid
         AND scs.store_id = $2::bigint
         AND scs.panel_hidden_at IS NULL
         AND COALESCE(scs.ebay_quantity, 0) = 0`,
      [workspaceId, storeId]
    )
    return parseInt(res.rows[0]?.c ?? "0", 10) || 0
  } catch {
    return null
  }
}

async function getStorePipelineHealth(
  workspaceId: string,
  storeId: number
): Promise<{
  lastKeepaScanAt: string | null
  activeAsins: number | null
  dueAsins: number | null
  pendingVerification: number
  waitingForWorker: number
  onlineWorkers: number
  lastVerifiedAt: string | null
  lastProtectionAt: string | null
}> {
  const empty = {
    lastKeepaScanAt: null as string | null,
    activeAsins: null as number | null,
    dueAsins: null as number | null,
    pendingVerification: 0,
    waitingForWorker: 0,
    onlineWorkers: 0,
    lastVerifiedAt: null as string | null,
    lastProtectionAt: null as string | null,
  }
  try {
    const [asins, verify, workers, verified, protection] = await Promise.all([
      query<{ active: string; last_check: string | null }>(
        `SELECT COUNT(*)::text AS active,
                MAX(g.last_checked_at)::text AS last_check
         FROM global_asin_consumers c
         JOIN global_amazon_asins g ON g.id = c.global_asin_id
         JOIN store_catalog_state scs ON scs.id = c.catalog_state_id
         WHERE c.workspace_id = $1::uuid AND c.store_id = $2::bigint
           AND scs.panel_hidden_at IS NULL
           AND (scs.current_status IS NULL OR scs.current_status = 'live')`,
        [workspaceId, storeId]
      ),
      query<{ pending: string; waiting: string }>(
        `SELECT
           SUM(CASE WHEN status IN ('PENDING','RETRYABLE') THEN 1 ELSE 0 END)::text AS pending,
           SUM(CASE WHEN status = 'WAITING_FOR_WORKER' THEN 1 ELSE 0 END)::text AS waiting
         FROM amazon_price_verification_tasks
         WHERE workspace_id = $1::uuid`,
        [workspaceId]
      ),
      query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM extension_workers
         WHERE workspace_id = $1::uuid
           AND last_heartbeat_at >= NOW() - ($2::int * INTERVAL '1 second')`,
        [workspaceId, loadAmazonVerificationConfig().workerOfflineAfterSeconds]
      ),
      query<{ t: string | null }>(
        `SELECT MAX(last_verified_at)::text AS t
         FROM store_catalog_state
         WHERE workspace_id = $1::uuid AND store_id = $2::bigint`,
        [workspaceId, storeId]
      ),
      query<{ t: string | null }>(
        `SELECT MAX(bot_zeroed_at)::text AS t
         FROM store_catalog_state
         WHERE workspace_id = $1::uuid AND store_id = $2::bigint`,
        [workspaceId, storeId]
      ),
    ])
    return {
      lastKeepaScanAt: asins.rows[0]?.last_check ?? null,
      activeAsins: parseInt(asins.rows[0]?.active ?? "0", 10) || 0,
      dueAsins: null,
      pendingVerification: parseInt(verify.rows[0]?.pending ?? "0", 10) || 0,
      waitingForWorker: parseInt(verify.rows[0]?.waiting ?? "0", 10) || 0,
      onlineWorkers: parseInt(workers.rows[0]?.c ?? "0", 10) || 0,
      lastVerifiedAt: verified.rows[0]?.t ?? null,
      lastProtectionAt: protection.rows[0]?.t ?? null,
    }
  } catch {
    return empty
  }
}

export async function getAppStockGuardStatus(
  workspaceId: string,
  store:       OwnedStore
): Promise<AppStockGuardStatusResponse> {
  const settingsRow = await ensureStockGuardSettings(workspaceId, store.id)
  const cfg = loadGlobalKeepaFoundationConfig()

  const [
    latestJob,
    lastCompletedScanAt,
    lastError,
    alertCounts,
    protectedListingsCount,
    zeroQuantityListingsCount,
    keepa,
  ] = await Promise.all([
    getLatestScanJob(workspaceId, store.id),
    getLastCompletedAt(workspaceId, store.id),
    getLastFailedJobError(workspaceId, store.id),
    getAlertCounts(workspaceId, store.id),
    getProtectedListingsCount(workspaceId, store.id),
    getZeroQuantityListingsCount(workspaceId, store.id),
    getStorePipelineHealth(workspaceId, store.id),
  ])

  const status: AppStockGuardStatus = {
    enabled:                     settingsRow.enabled,
    mode:                        settingsRow.mode,
    lastScanAt:                  latestJob.lastScanAt,
    lastCompletedScanAt,
    lastRunStatus:               latestJob.lastRunStatus,
    lastError,
    ...alertCounts,
    protectedListingsCount,
    zeroQuantityListingsCount,
    keepaRadar: cfg.plannerEnabled && cfg.monitorEnabled ? "Running" : "Off",
    lastKeepaScanAt: keepa.lastKeepaScanAt,
    activeAsins: keepa.activeAsins,
    dueAsins: keepa.dueAsins,
    pendingVerificationTasks: keepa.pendingVerification,
    waitingForWorkerTasks: keepa.waitingForWorker,
    onlineExtensionWorkers: keepa.onlineWorkers,
    lastVerifiedSourceAt: keepa.lastVerifiedAt,
    lastProtectionActionAt: keepa.lastProtectionAt,
  }

  return {
    ok:        true,
    storeCode: store.storeCode,
    status,
  }
}

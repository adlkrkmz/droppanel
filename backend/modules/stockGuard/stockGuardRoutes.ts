import { loadKeepaConfig } from "../keepa/keepaClient"
import type { AdminRequest, AdminResponse } from "../admin/adminTypes"
import { cancelGhostStoreJobs } from "./stockGuardActiveStores"
import {
  countPendingStockAlerts,
  runStockGuardMaintenance,
} from "./stockGuardCleanupService"
import { getKeepaTokenSnapshot, getStaleRecoveredLastRun } from "./keepaTokenGuardService"
import {
  countJobsByStatus,
  countStoreJobsByStatus,
  getLastCompletedAt,
  getStoreNextScheduledScanAt,
  requeueFailedJob,
} from "./stockGuardJobRepository"
import {
  schedulerTick,
  runNextScanJob,
  type SchedulerTickResult,
} from "./stockGuardSchedulerService"
import {
  ensureStockGuardSettings,
  getStockGuardSettingsByStoreCode,
  updateStockGuardSettings,
  listActiveStoresWithSettings,
} from "./stockGuardSettingsRepository"
import { fetchAllClicks30dSyncStatuses } from "../storeSync/storeSyncScheduleService"
import type { StockGuardMode, StockGuardStatusResponse } from "./stockGuardTypes"

function getWorkspaceId(): string {
  const id = process.env.WORKSPACE_ID
  if (!id) throw new Error("WORKSPACE_ID is not defined")
  return id
}

function bad(msg: string): AdminResponse<{ ok: false; error: string }> {
  return { status: 400, body: { ok: false, error: msg } }
}

export async function handleGetStockGuardStatus(): Promise<AdminResponse<StockGuardStatusResponse>> {
  const workspaceId = getWorkspaceId()
  const cfg = loadKeepaConfig()
  await runStockGuardMaintenance(workspaceId)
  await cancelGhostStoreJobs(workspaceId)
  const tokens = await getKeepaTokenSnapshot(workspaceId)
  const jobCounts = await countJobsByStatus(workspaceId)

  const stores = await listActiveStoresWithSettings(workspaceId)
  const clicksByStore = new Map(
    (await fetchAllClicks30dSyncStatuses(workspaceId)).map(c => [c.storeCode, c])
  )
  const storeRows: StockGuardStatusResponse["stores"] = []

  for (const s of stores) {
    const settings = s.settings ?? (await ensureStockGuardSettings(workspaceId, s.storeId))
    const jobStats = await countStoreJobsByStatus(workspaceId, s.storeId)

    const clicks = clicksByStore.get(s.storeCode)
    const schedule = await getStoreNextScheduledScanAt({
      workspaceId,
      storeId: s.storeId,
      stockGuardEnabled: settings.enabled,
    })

    storeRows.push({
      storeCode: s.storeCode,
      storeId: s.storeId,
      enabled: settings.enabled,
      mode: settings.mode,
      pendingJobs: jobStats.pendingJobs,
      runningJobs: jobStats.runningJobs,
      skippedWaitingTokens: jobStats.skippedWaitingTokens,
      nextScheduledAt: schedule.nextScheduledAt,
      dueNowCount: schedule.dueNowCount,
      lastCompletedAt: await getLastCompletedAt(workspaceId, s.storeId),
      pendingAlerts: await countPendingStockAlerts(workspaceId, s.storeId),
      analyticsScopeActive: clicks?.analyticsScopeActive ?? false,
      clicks30dLastSyncAt: clicks?.clicks30dLastSyncAt ?? null,
      clicks30dNextSyncAt: clicks?.clicks30dNextSyncAt ?? null,
      clicks30dSyncStatus: clicks?.clicks30dSyncStatus ?? null,
      clicks30dSyncError: clicks?.clicks30dSyncError ?? null,
      lastCheckedCount: clicks?.lastCheckedCount ?? null,
      lastUpdatedCount: clicks?.lastUpdatedCount ?? null,
    })
  }

  const clicks30dAutoSync = [...clicksByStore.values()]

  return {
    status: 200,
    body: {
      ok: true,
      keepaEnabled: cfg.enabled,
      tokensLeft: tokens.tokensLeft,
      tokensLeftRaw: tokens.tokensLeftRaw,
      tokensLeftEffective: tokens.tokensLeftEffective,
      tokensUpdatedAt: tokens.tokensUpdatedAt,
      refillRatePerMinute: tokens.refillRatePerMinute,
      bucketCapacity: tokens.bucketCapacity,
      reserveTokens: tokens.reserveTokens,
      tokensKnown: tokens.tokensKnown,
      stores: storeRows,
      clicks30dAutoSync,
      jobs: {
        queued: jobCounts.queued ?? 0,
        running: jobCounts.running ?? 0,
        skippedWaitingTokens: jobCounts.skipped_waiting_tokens ?? 0,
        staleRecoveredLastRun: getStaleRecoveredLastRun(),
      },
    },
  }
}

export async function handlePostStockGuardSchedulerTick(): Promise<
  AdminResponse<SchedulerTickResult>
> {
  const workspaceId = getWorkspaceId()
  await runStockGuardMaintenance(workspaceId)
  const tick = await schedulerTick(workspaceId)
  let runMessage: string | undefined
  if (tick.jobQueued) {
    const run = await runNextScanJob(workspaceId)
    runMessage = run.message
  }
  return {
    status: 200,
    body: { ...tick, runMessage },
  }
}

export async function handlePostStockGuardRunNext(): Promise<
  AdminResponse<{ ok: true; ran: boolean; jobId?: number; message: string }>
> {
  const workspaceId = getWorkspaceId()
  await runStockGuardMaintenance(workspaceId)
  const r = await runNextScanJob(workspaceId)
  return { status: 200, body: { ok: true, ...r } }
}

/** Debug: maintenance + re-queue failed job (connected stores only). */
export async function handlePostStockGuardCleanup(): Promise<
  AdminResponse<{
    ok: true
    zeroQtyAlertsResolved: number
    completedJobErrorsCleared: number
    staleJobsRecovered: number
    resolvedPriceIncreaseAlerts: number
  }>
> {
  const result = await runStockGuardMaintenance(getWorkspaceId())
  return { status: 200, body: { ok: true, ...result } }
}

export async function handlePostStockGuardRequeueJob(
  req: AdminRequest
): Promise<AdminResponse<{ ok: true; requeued: boolean } | { ok: false; error: string }>> {
  const body = req.body as { jobId?: number }
  const jobId = Number(body.jobId)
  if (!Number.isFinite(jobId)) return bad("jobId is required")
  const requeued = await requeueFailedJob(jobId, getWorkspaceId())
  return { status: 200, body: { ok: true, requeued } }
}

export async function handleGetStockGuardSettings(
  req: AdminRequest
): Promise<AdminResponse<{ ok: true; settings: Record<string, unknown> } | { ok: false; error: string }>> {
  const storeCode = String(req.query?.storeCode ?? "").trim()
  if (!storeCode) return bad("storeCode is required")
  const row = await getStockGuardSettingsByStoreCode(getWorkspaceId(), storeCode)
  if (!row) return { status: 404, body: { ok: false, error: "Store not found" } }
  return {
    status: 200,
    body: {
      ok: true,
      settings: {
        storeCode: row.storeCode,
        storeName: row.storeName,
        enabled: row.enabled,
        mode: row.mode,
        priceAlertEnabled: row.priceAlertEnabled,
        priceIncreasePercentThreshold: row.priceIncreasePercentThreshold,
        priceIncreaseAmountThreshold: row.priceIncreaseAmountThreshold,
        soldScanHours: row.soldScanHours,
        clickedScanHours: row.clickedScanHours,
        normalScanHours: row.normalScanHours,
        autoZeroNoPriceRequiresRepeat: row.autoZeroNoPriceRequiresRepeat,
        autoProfitProtectionEnabled: row.autoProfitProtectionEnabled,
      },
    },
  }
}

export async function handlePostStockGuardSettings(
  req: AdminRequest
): Promise<AdminResponse<{ ok: true } | { ok: false; error: string }>> {
  const body = req.body as {
    storeCode?: string
    enabled?: boolean
    mode?: string
    priceAlertEnabled?: boolean
    autoProfitProtectionEnabled?: boolean
  }
  const storeCode = String(body.storeCode ?? "").trim()
  if (!storeCode) return bad("storeCode is required")

  const existing = await getStockGuardSettingsByStoreCode(getWorkspaceId(), storeCode)
  if (!existing) return { status: 404, body: { ok: false, error: "Store not found" } }

  const mode: StockGuardMode | undefined =
    body.mode === "auto" ? "auto" : body.mode === "manual" ? "manual" : undefined

  await updateStockGuardSettings(getWorkspaceId(), existing.storeId, {
    enabled: body.enabled,
    mode,
    priceAlertEnabled: body.priceAlertEnabled,
    autoProfitProtectionEnabled: body.autoProfitProtectionEnabled,
  })

  return { status: 200, body: { ok: true } }
}

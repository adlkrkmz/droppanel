import { loadKeepaConfig } from "../keepa/keepaClient"
import { cancelGhostStoreJobs, isStoreConnected } from "./stockGuardActiveStores"
import { canSpendTokens, recoverStaleStockGuardJobs } from "./keepaTokenGuardService"
import { findDueStockGuardForStore } from "./stockGuardDueFinder"
import {
  createScanJob,
  hasActiveJobForStore,
  markJobCompleted,
  markJobFailed,
  hasRunningJob,
  markJobRunning,
  pickNextRunnableJob,
  rescheduleJobForTokens,
} from "./stockGuardJobRepository"
import { ensureStockGuardSettings, listActiveStoresWithSettings } from "./stockGuardSettingsRepository"
import { STOCK_GUARD_MAX_DUE_ASINS_PER_JOB } from "./stockGuardScanEligibility"
import {
  cleanupZeroQtyPendingStockAlerts,
  runStockGuardMaintenance,
} from "./stockGuardCleanupService"
import { runStockGuardScanJob } from "./stockGuardScanService"
import { legacyAutomatedKeepaScanBlocked } from "./stockGuardScannerOwnership"

const TICK_MS = 10 * 60 * 1000
const RUN_NEXT_MS = 45 * 1000
const STARTUP_CATCHUP_MS = 45 * 1000

export type SchedulerNoJobReason =
  | "keepaDisabled"
  | "storeDisabled"
  | "noDueEligibleAsins"
  | "noEligibleAsin"
  | "activeJobExists"
  | "tokenInsufficient"
  | "noConnectedEbayAccount"
  | "v2OwnsScan"

export type SchedulerTickResult = {
  ok: boolean
  jobsCreated: number
  storesChecked: number
  dueFound: number
  jobQueued: boolean
  storeCode: string | null
  selectedCount: number
  skippedWaitingTokens: number
  keepaDisabled?: boolean
  runMessage?: string
  noJobReason?: SchedulerNoJobReason
}

type StoreDueCandidate = {
  storeId: number
  storeCode: string
  dueAsins: number
  dueListings: number
  noAsinListings: number
  soldDue: number
  clickedDue: number
  normalDue: number
  priority: number
}

function emptyTickResult(keepaDisabled = false): SchedulerTickResult {
  return {
    ok: !keepaDisabled,
    jobsCreated: 0,
    storesChecked: 0,
    dueFound: 0,
    jobQueued: false,
    storeCode: null,
    selectedCount: 0,
    skippedWaitingTokens: 0,
    keepaDisabled,
  }
}

export async function schedulerTick(workspaceId: string): Promise<SchedulerTickResult> {
  console.log("[StockGuardScheduler] tick start")

  const cfg = loadKeepaConfig()
  if (!cfg.enabled) {
    console.log("[StockGuardScheduler] no job reason=keepaDisabled")
    return { ...emptyTickResult(true), noJobReason: "keepaDisabled" }
  }

  if (legacyAutomatedKeepaScanBlocked()) {
    console.log("[StockGuardScheduler] no job reason=v2OwnsScan")
    return { ...emptyTickResult(), noJobReason: "v2OwnsScan" }
  }

  await recoverStaleStockGuardJobs(workspaceId)
  await cancelGhostStoreJobs(workspaceId)

  const stores = await listActiveStoresWithSettings(workspaceId)
  const candidates: StoreDueCandidate[] = []
  let dueFound = 0
  for (const s of stores) {
    const settings = s.settings ?? (await ensureStockGuardSettings(workspaceId, s.storeId))

    const { summary } = await findDueStockGuardForStore({
      workspaceId,
      storeId: s.storeId,
      limit: 10_000,
    })

    console.log(
      `[StockGuardScheduler] store=${s.storeCode} dueCount=${summary.dueListings} eligibleCount=${summary.eligibleAsins} noAsin=${summary.noAsinListings}`
    )

    if (summary.eligibleAsins === 0) continue

    dueFound += summary.eligibleAsins
    candidates.push({
      storeId: s.storeId,
      storeCode: s.storeCode,
      dueAsins: summary.eligibleAsins,
      dueListings: summary.dueListings,
      noAsinListings: summary.noAsinListings,
      soldDue: summary.soldDue,
      clickedDue: summary.clickedDue,
      normalDue: summary.normalDue,
      priority: summary.priority,
    })
    console.log(
      `[StockGuardScheduler] due store=${s.storeCode} count=${summary.eligibleAsins} sold=${summary.soldDue} clicked=${summary.clickedDue} normal=${summary.normalDue}`
    )
  }

  if (candidates.length === 0) {
    const reason: SchedulerNoJobReason = "noDueEligibleAsins"
    console.log(`[StockGuardScheduler] no job reason=${reason} dueFound=0`)
    return {
      ...emptyTickResult(),
      storesChecked: stores.length,
      noJobReason: reason,
    }
  }

  candidates.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority
    if (b.dueAsins !== a.dueAsins) return b.dueAsins - a.dueAsins
    return a.storeCode.localeCompare(b.storeCode)
  })

  let jobsCreated = 0
  let jobQueued = false
  let storeCode: string | null = null
  let selectedCount = 0
  let skippedWaitingTokens = 0
  let noJobReason: SchedulerNoJobReason | undefined

  for (const c of candidates) {
    if (!(await isStoreConnected(workspaceId, c.storeId))) {
      noJobReason = "noConnectedEbayAccount"
      console.log(`[StockGuardScheduler] no job reason=noConnectedEbayAccount store=${c.storeCode}`)
      continue
    }

    if (await hasActiveJobForStore(workspaceId, c.storeId)) {
      noJobReason = "activeJobExists"
      console.log(`[StockGuardScheduler] no job reason=activeJobExists store=${c.storeCode}`)
      continue
    }

    const estimated = Math.min(c.dueAsins, STOCK_GUARD_MAX_DUE_ASINS_PER_JOB)
    const tokenCheck = await canSpendTokens(workspaceId, estimated)

    if (!tokenCheck.allowed) {
      skippedWaitingTokens = 1
      noJobReason = "tokenInsufficient"
      console.log(
        `[StockGuardScheduler] skipped tokens store=${c.storeCode} needed=${estimated} reason=${tokenCheck.reason}`
      )
    }

    const delayMin = tokenCheck.allowed ? 0 : (tokenCheck.waitMinutes ?? 15)
    const jobPriority = c.priority === 0 ? 10 : c.priority === 1 ? 50 : 100

    await createScanJob({
      workspaceId,
      storeId: c.storeId,
      estimatedTokens: estimated,
      scheduledFor: delayMin > 0 ? new Date(Date.now() + delayMin * 60_000) : new Date(),
      priority: jobPriority,
    })

    jobsCreated++
    jobQueued = true
    storeCode = c.storeCode
    selectedCount = estimated
    noJobReason = undefined
    console.log(
      `[StockGuardScheduler] selected store=${c.storeCode} count=${estimated} reason=priority`
    )
    console.log(
      `[StockGuardScheduler] queued store=${c.storeCode} selected=${estimated} tokensOk=${tokenCheck.allowed}`
    )
    break
  }

  if (!jobQueued && !noJobReason) {
    noJobReason = "activeJobExists"
  }

  console.log(
    `[StockGuardScheduler] done dueFound=${dueFound} jobsCreated=${jobsCreated} store=${storeCode ?? "none"} reason=${noJobReason ?? "ok"}`
  )

  return {
    ok: true,
    jobsCreated,
    storesChecked: stores.length,
    dueFound,
    jobQueued,
    storeCode,
    selectedCount,
    skippedWaitingTokens,
    noJobReason: jobQueued ? undefined : noJobReason,
  }
}

export async function runNextScanJob(workspaceId: string): Promise<{
  ran: boolean
  jobId?: number
  message: string
}> {
  const cfg = loadKeepaConfig()
  if (!cfg.enabled) {
    return { ran: false, message: "Keepa disabled" }
  }

  if (legacyAutomatedKeepaScanBlocked()) {
    return { ran: false, message: "V2 owns automated Keepa scan" }
  }

  await recoverStaleStockGuardJobs(workspaceId)
  await cancelGhostStoreJobs(workspaceId)

  if (await hasRunningJob(workspaceId)) {
    return { ran: false, message: "Another store scan is already running" }
  }

  const MAX_SKIP = 25
  for (let attempt = 0; attempt < MAX_SKIP; attempt++) {
    const job = await pickNextRunnableJob(workspaceId)
    if (!job) {
      return { ran: false, message: "No queued jobs" }
    }

    if (!(await isStoreConnected(workspaceId, job.storeId))) {
      await markJobFailed(job.id, workspaceId, "inactive or disconnected store")
      continue
    }

    const estimated = Math.min(
      job.estimatedTokens ?? 1,
      STOCK_GUARD_MAX_DUE_ASINS_PER_JOB
    )
    const tokenCheck = await canSpendTokens(workspaceId, estimated)
    if (!tokenCheck.allowed) {
      const delayMin = tokenCheck.waitMinutes ?? 15
      await rescheduleJobForTokens(job.id, workspaceId, delayMin, tokenCheck.reason)
      return {
        ran: false,
        jobId: job.id,
        message: tokenCheck.reason,
      }
    }

    const locked = await markJobRunning(job.id, workspaceId)
    if (!locked) {
      return { ran: false, message: "Job could not be locked" }
    }

    const settings = await ensureStockGuardSettings(workspaceId, job.storeId)

    try {
      const result = await runStockGuardScanJob({
        workspaceId,
        storeId: job.storeId,
        settings,
        jobId: job.id,
      })
      await markJobCompleted(job.id, workspaceId, result.scanned, result.risks)
      await cleanupZeroQtyPendingStockAlerts(workspaceId)
      return {
        ran: true,
        jobId: job.id,
        message: `completed scanned=${result.scanned} risks=${result.risks} auto=${result.autoZeroed} skippedZeroQty=${result.skippedZeroQty}`,
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error(
        `[StockGuard][run-next] job failed jobId=${job.id} storeId=${job.storeId} error=${msg}`
      )
      await markJobFailed(job.id, workspaceId, msg.slice(0, 500))
      return { ran: true, jobId: job.id, message: `failed: ${msg}` }
    }
  }

  return { ran: false, message: "No runnable jobs after skipping invalid stores" }
}

let schedulerIntervalStarted = false

export function startStockGuardScheduler(workspaceId: string): void {
  if (schedulerIntervalStarted) return
  schedulerIntervalStarted = true

  void runStockGuardMaintenance(workspaceId).then(r => {
    if (
      r.staleJobsRecovered > 0 ||
      r.zeroQtyAlertsResolved > 0 ||
      r.completedJobErrorsCleared > 0 ||
      r.resolvedPriceIncreaseAlerts > 0
    ) {
      console.log(`[StockGuardScheduler] startup maintenance`, r)
    }
  })

  console.log(
    `[StockGuardScheduler] startup catch-up scheduled in ${STARTUP_CATCHUP_MS / 1000}s`
  )

  setTimeout(() => {
    console.log("[StockGuardScheduler] startup catch-up tick")
    void schedulerTick(workspaceId)
      .then(r => {
        console.log(
          `[StockGuardScheduler] startup catch-up dueFound=${r.dueFound} jobsCreated=${r.jobsCreated} store=${r.storeCode ?? "none"}`
        )
        return runNextScanJob(workspaceId)
      })
      .then(r => {
        if (r.ran) {
          console.log(`[StockGuardScheduler] startup run-next jobId=${r.jobId} ${r.message}`)
        }
      })
      .catch(e => console.error("[StockGuardScheduler] startup catch-up:", e))
  }, STARTUP_CATCHUP_MS)

  setInterval(() => {
    void schedulerTick(workspaceId).catch(e =>
      console.error("[StockGuardScheduler] tick:", e)
    )
  }, TICK_MS)

  setInterval(() => {
    void runNextScanJob(workspaceId).catch(e =>
      console.error("[StockGuardScheduler] run-next:", e)
    )
  }, RUN_NEXT_MS)

  console.log(
    `[StockGuardScheduler] Started (tick ${TICK_MS / 60_000}m, run-next ${RUN_NEXT_MS / 1000}s, catch-up ${STARTUP_CATCHUP_MS / 1000}s)`
  )
}

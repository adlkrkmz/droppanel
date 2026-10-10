import { query } from "../../db/client"
import { loadAmazonVerificationConfig } from "../amazonVerification/amazonVerificationConfig"
import {
  countClaimableVerificationTasks,
  countPendingVerificationTasks,
  countRetryBackoffVerificationTasks,
  getNextRetryAvailableAt,
} from "../amazonVerification/amazonVerificationQueue"
import {
  amazonBrowserWorkerOnline,
  getAmazonBrowserHeartbeat,
  type AmazonBrowserHeartbeatRow,
} from "./amazonBrowserHeartbeat"
import {
  getAmazonWorkerAccount,
  publicAmazonAccountView,
  saveAmazonWorkerAccount,
  updateAmazonAccountStatus,
} from "./amazonWorkerAccountVault"
import {
  amazonBrowserProfileDir,
  amazonPublicStallMs,
  AMAZON_BROWSER_WORKER_ID,
  AMAZON_PUBLIC_BROWSER_WORKER_ID,
} from "./amazonBrowserWorkerConstants"
import { publicWorkerOwnsQueue, resolveVerificationEngineStatus } from "./amazonWorkerEngineStatus"
import {
  AMAZON_PUBLIC_BROWSER_POOL_ID,
  amazonPublicWorkerCount,
  configuredPublicWorkerSlots,
  publicWorkerClaimId,
  publicWorkerHeartbeatIdPrefix,
} from "../amazonPublicWorker/amazonPublicWorkerPool"
import {
  collectPublicWorkerProcessMetrics,
  collectServerResourceSnapshot,
} from "./serverResourceMetrics"

function parseSlotMetrics(amazonSessionState: string | null | undefined): {
  timeoutCount: number
  recycleCount: number
} {
  const s = String(amazonSessionState ?? "")
  const t = /(?:^|\|)t=(\d+)/.exec(s)
  const r = /(?:^|\|)r=(\d+)/.exec(s)
  return {
    timeoutCount: t ? parseInt(t[1], 10) || 0 : 0,
    recycleCount: r ? parseInt(r[1], 10) || 0 : 0,
  }
}

export async function handleGetAmazonWorkerAdminStatus(): Promise<{ status: number; body: unknown }> {
  const cfg = loadAmazonVerificationConfig()
  const account = await getAmazonWorkerAccount()
  const legacyHb = await getAmazonBrowserHeartbeat(AMAZON_BROWSER_WORKER_ID)
  const poolHb = await getAmazonBrowserHeartbeat(AMAZON_PUBLIC_BROWSER_POOL_ID)
  const allowAllReasons = cfg.verificationEnabled === true || cfg.serverBrowserEnabled === true
  const [pending, claimable, backoff, nextRetryAt] = await Promise.all([
    countPendingVerificationTasks(),
    countClaimableVerificationTasks({ allowAllReasons }),
    countRetryBackoffVerificationTasks(),
    getNextRetryAvailableAt(),
  ])
  const configuredSlots = configuredPublicWorkerSlots()
  const configuredCount = amazonPublicWorkerCount()

  const hour = await query<{
    completed: string
    completed_15m: string
    failed: string
    running: string
    last_progress_at: Date | null
    avg_duration_1h: string | null
    pool_completed: string
    pool_completed_15m: string
    pool_avg_duration_1h: string | null
  }>(
    `SELECT
       SUM(CASE WHEN status = 'COMPLETED' AND completed_at >= NOW() - interval '1 hour' THEN 1 ELSE 0 END)::text AS completed,
       SUM(CASE WHEN status = 'COMPLETED' AND completed_at >= NOW() - interval '15 minutes' THEN 1 ELSE 0 END)::text AS completed_15m,
       SUM(CASE WHEN status = 'FAILED' AND updated_at >= NOW() - interval '1 hour' THEN 1 ELSE 0 END)::text AS failed,
       SUM(CASE WHEN status IN ('CLAIMED','RUNNING') AND claimed_by_source = 'SERVER_BROWSER' THEN 1 ELSE 0 END)::text AS running,
       -- Progress includes COMPLETED + RETRYABLE/FAILED attempt finishes (not only VALID_SOURCE).
       GREATEST(
         MAX(completed_at),
         MAX(claimed_at),
         MAX(CASE
           WHEN claimed_at IS NOT NULL
                AND status IN ('RETRYABLE', 'FAILED', 'COMPLETED', 'CLAIMED', 'RUNNING')
           THEN updated_at
           ELSE NULL
         END)
       ) AS last_progress_at,
       AVG(CASE
         WHEN status = 'COMPLETED' AND claimed_by_source = 'SERVER_BROWSER'
              AND completed_at >= NOW() - interval '1 hour' AND claimed_at IS NOT NULL
         THEN EXTRACT(EPOCH FROM (completed_at - claimed_at))
         ELSE NULL
       END)::text AS avg_duration_1h,
       SUM(CASE
         WHEN status = 'COMPLETED' AND completed_at >= NOW() - interval '1 hour'
              AND worker_id LIKE $1
         THEN 1 ELSE 0 END)::text AS pool_completed,
       SUM(CASE
         WHEN status = 'COMPLETED' AND completed_at >= NOW() - interval '15 minutes'
              AND worker_id LIKE $1
         THEN 1 ELSE 0 END)::text AS pool_completed_15m,
       AVG(CASE
         WHEN status = 'COMPLETED' AND worker_id LIKE $1
              AND completed_at >= NOW() - interval '1 hour' AND claimed_at IS NOT NULL
         THEN EXTRACT(EPOCH FROM (completed_at - claimed_at))
         ELSE NULL
       END)::text AS pool_avg_duration_1h
     FROM amazon_price_verification_tasks`,
    [`${publicWorkerHeartbeatIdPrefix()}%`]
  )
  const running = parseInt(hour.rows[0]?.running ?? "0", 10) || 0
  const completedLast1h = parseInt(hour.rows[0]?.completed ?? "0", 10) || 0
  const completedLast15m = parseInt(hour.rows[0]?.pool_completed_15m ?? hour.rows[0]?.completed_15m ?? "0", 10) || 0
  const poolCompletedLast1h = parseInt(hour.rows[0]?.pool_completed ?? "0", 10) || 0
  const poolAvgDurationSec =
    hour.rows[0]?.pool_avg_duration_1h != null
      ? Number(hour.rows[0].pool_avg_duration_1h)
      : hour.rows[0]?.avg_duration_1h != null
        ? Number(hour.rows[0].avg_duration_1h)
        : null
  const lastProgressAt = hour.rows[0]?.last_progress_at ? new Date(hour.rows[0].last_progress_at) : null
  const stallMs = amazonPublicStallMs()
  const now = Date.now()
  const queueProgressAgeMs = lastProgressAt ? now - lastProgressAt.getTime() : Number.POSITIVE_INFINITY
  const nextRetryInMs = nextRetryAt ? Math.max(0, nextRetryAt.getTime() - now) : null
  const nextRetryInMinutes =
    nextRetryInMs != null ? Math.max(1, Math.ceil(nextRetryInMs / 60_000)) : null

  const perWorkerStats = await query<{
    worker_id: string
    completed_1h: string
    completed_15m: string
    avg_duration_1h: string | null
    last_completed_at: Date | null
    last_claimed_at: Date | null
    last_attempt_at: Date | null
    inflight_claimed_at: Date | null
    inflight_task_id: string | null
  }>(
    `SELECT worker_id,
            SUM(CASE WHEN status = 'COMPLETED' AND completed_at >= NOW() - interval '1 hour' THEN 1 ELSE 0 END)::text AS completed_1h,
            SUM(CASE WHEN status = 'COMPLETED' AND completed_at >= NOW() - interval '15 minutes' THEN 1 ELSE 0 END)::text AS completed_15m,
            AVG(CASE
              WHEN status = 'COMPLETED' AND completed_at >= NOW() - interval '1 hour' AND claimed_at IS NOT NULL
              THEN EXTRACT(EPOCH FROM (completed_at - claimed_at))
              ELSE NULL
            END)::text AS avg_duration_1h,
            MAX(completed_at) AS last_completed_at,
            MAX(claimed_at) AS last_claimed_at,
            MAX(CASE
              WHEN claimed_at IS NOT NULL
                   AND status IN ('RETRYABLE', 'FAILED', 'COMPLETED', 'CLAIMED', 'RUNNING')
              THEN GREATEST(COALESCE(completed_at, claimed_at), COALESCE(updated_at, claimed_at), claimed_at)
              ELSE NULL
            END) AS last_attempt_at,
            MIN(CASE WHEN status IN ('CLAIMED','RUNNING') THEN claimed_at END) AS inflight_claimed_at,
            MIN(CASE WHEN status IN ('CLAIMED','RUNNING') THEN id::text END) AS inflight_task_id
     FROM amazon_price_verification_tasks
     WHERE worker_id IS NOT NULL
       AND (
         worker_id LIKE $1
         OR worker_id = $2
         OR worker_id = $3
       )
     GROUP BY worker_id`,
    [`${publicWorkerHeartbeatIdPrefix()}%`, AMAZON_PUBLIC_BROWSER_WORKER_ID, AMAZON_BROWSER_WORKER_ID]
  )
  const statsByWorker = new Map(perWorkerStats.rows.map(r => [r.worker_id, r]))
  const processMetrics = collectPublicWorkerProcessMetrics(configuredSlots)
  const processBySlot = new Map(processMetrics.map(m => [m.slot, m]))
  const serverResources = collectServerResourceSnapshot()

  const publicWorkers: Array<Record<string, unknown>> = []
  let healthy = 0
  let active = 0
  let anyStalled = false
  let anyBackoff = false

  for (const slot of configuredSlots) {
    const hbId = publicWorkerClaimId(slot)
    const hb = await getAmazonBrowserHeartbeat(hbId)
    const stats = statsByWorker.get(hbId)
    const metrics = parseSlotMetrics(hb?.amazonSessionState)
    const proc = processBySlot.get(slot)
    const online = amazonBrowserWorkerOnline(hb)
    const currentTaskId =
      hb?.currentTaskId ?? (stats?.inflight_task_id != null ? Number(stats.inflight_task_id) : null)
    const hasInflight = currentTaskId != null || stats?.inflight_claimed_at != null
    // Shared-queue progress: attempt finishes clear worker_id, so include pool last_progress_at.
    const progressCandidates = [
      hb?.lastSuccessAt?.getTime() ?? 0,
      stats?.last_completed_at ? new Date(stats.last_completed_at).getTime() : 0,
      stats?.last_claimed_at ? new Date(stats.last_claimed_at).getTime() : 0,
      stats?.last_attempt_at ? new Date(stats.last_attempt_at).getTime() : 0,
      lastProgressAt?.getTime() ?? 0,
    ]
    const lastProgressMs = Math.max(...progressCandidates, 0)
    const inflightAgeMs = stats?.inflight_claimed_at
      ? now - new Date(stats.inflight_claimed_at).getTime()
      : 0
    const progressAgeMs = lastProgressMs > 0 ? now - lastProgressMs : Number.POSITIVE_INFINITY

    let displayStatus = "OFFLINE"
    if (poolHb?.status === "CHALLENGE_REQUIRED" || hb?.status === "CHALLENGE_REQUIRED") {
      displayStatus = "CHALLENGE"
    } else if (hb?.status === "PAUSED") {
      displayStatus = "PAUSED"
    } else if (hb?.status === "STARTING") {
      displayStatus = "STARTING"
      healthy += 1
    } else if (online && hasInflight && inflightAgeMs <= stallMs) {
      displayStatus = "ACTIVE"
      healthy += 1
      active += 1
    } else if (
      online &&
      claimable > 0 &&
      ((hasInflight && inflightAgeMs > stallMs) || (!hasInflight && progressAgeMs > stallMs))
    ) {
      displayStatus = "STALLED"
      anyStalled = true
    } else if (online && claimable === 0 && backoff > 0) {
      displayStatus = "BACKOFF BEKLİYOR"
      anyBackoff = true
      healthy += 1
    } else if (online && claimable === 0 && backoff === 0 && !hasInflight) {
      displayStatus = "IDLE"
      healthy += 1
    } else if (online) {
      displayStatus = hasInflight ? "ACTIVE" : "IDLE"
      healthy += 1
      if (hasInflight) active += 1
    }

    publicWorkers.push({
      slot,
      workerId: hbId,
      displayStatus,
      online,
      status: hb?.status ?? "OFFLINE",
      browserRunning: hb?.browserRunning === true,
      currentTaskId,
      lastHeartbeatAt: hb?.lastHeartbeatAt?.toISOString() ?? null,
      lastSuccessAt: hb?.lastSuccessAt?.toISOString() ?? null,
      lastProgressAt: lastProgressMs > 0 ? new Date(lastProgressMs).toISOString() : null,
      lastCompletedAt: stats?.last_completed_at ? new Date(stats.last_completed_at).toISOString() : null,
      completedLast15m: parseInt(stats?.completed_15m ?? "0", 10) || 0,
      completedLast1h: parseInt(stats?.completed_1h ?? "0", 10) || 0,
      avgTaskDurationSec: stats?.avg_duration_1h != null ? Number(stats.avg_duration_1h) : null,
      timeoutCount: metrics.timeoutCount,
      recycleCount: metrics.recycleCount,
      nodeRssBytes: proc?.nodeRssBytes ?? null,
      chromiumRssBytes: proc?.chromiumRssBytes ?? null,
      chromiumProcessCount: proc?.chromiumProcessCount ?? 0,
      pid: proc?.pid ?? null,
      lastError: hb?.lastError ?? null,
      pauseReason: hb?.pauseReason ?? null,
      nextRetryAt: nextRetryAt?.toISOString() ?? null,
      nextRetryInMinutes: displayStatus === "BACKOFF BEKLİYOR" ? nextRetryInMinutes : null,
    })
  }

  const publicPoolChallenge = poolHb?.status === "CHALLENGE_REQUIRED"
  const poolStalled =
    publicWorkerOwnsQueue() && claimable > 0 && (anyStalled || (healthy === 0 && queueProgressAgeMs > stallMs)) && !publicPoolChallenge
  const poolBackoff = publicWorkerOwnsQueue() && claimable === 0 && backoff > 0 && !publicPoolChallenge && !poolStalled

  const engine = resolveVerificationEngineStatus({
    accountStatus: account.accountStatus,
    sessionState: account.sessionState,
    heartbeatStatus: legacyHb?.status ?? null,
    pauseReason: legacyHb?.pauseReason ?? account.lastError,
    publicWorkerProcessOnline: healthy > 0,
    publicWorkerStalled: poolStalled || anyStalled,
    publicPoolChallenge,
    publicPoolBackoff: poolBackoff || anyBackoff,
    poolHealthy: healthy,
    poolConfigured: configuredCount,
  })

  const workerOnline = amazonBrowserWorkerOnline(legacyHb)
  let browserWorker: "ONLINE" | "OFFLINE" | "PAUSED" | "STARTING" = "OFFLINE"
  const pausedStatuses = ["PAUSED", "THROTTLED", "LOGIN_REQUIRED", "LOGIN_FAILED", "CHALLENGE_REQUIRED"]
  if (account.accountStatus === "PAUSED" || pausedStatuses.includes(legacyHb?.status ?? "")) {
    browserWorker = "PAUSED"
  } else if (legacyHb?.status === "STARTING") {
    browserWorker = "STARTING"
  } else if (workerOnline && legacyHb?.browserRunning === true) {
    browserWorker = "ONLINE"
  } else if (workerOnline) {
    browserWorker = "OFFLINE"
  }

  let amazonSession: "ACTIVE" | "LOGIN REQUIRED" | "CHALLENGE" | "LOGIN_FAILED" | "UNKNOWN" = "UNKNOWN"
  const lastErr = `${legacyHb?.lastError ?? ""} ${account.lastError ?? ""}`
  const hbSession = (legacyHb?.amazonSessionState ?? account.sessionState ?? "").toUpperCase()
  if (
    account.sessionState === "CHALLENGE" ||
    account.accountStatus === "CHALLENGE_REQUIRED" ||
    legacyHb?.status === "CHALLENGE_REQUIRED" ||
    publicPoolChallenge
  ) {
    amazonSession = "CHALLENGE"
  } else if (legacyHb?.status === "LOGIN_FAILED" || /\bLOGIN_FAILED\b/.test(lastErr)) {
    amazonSession = "LOGIN_FAILED"
  } else if (
    hbSession === "ACTIVE" &&
    legacyHb?.browserRunning === true &&
    (account.accountStatus === "ONLINE" || legacyHb?.status === "ONLINE")
  ) {
    amazonSession = "ACTIVE"
  } else if (
    hbSession === "LOGIN_REQUIRED" ||
    account.sessionState === "LOGIN_REQUIRED" ||
    account.accountStatus === "LOGIN_REQUIRED" ||
    legacyHb?.status === "LOGIN_REQUIRED"
  ) {
    amazonSession = "LOGIN REQUIRED"
  } else if (account.accountStatus === "READY" || hbSession === "UNKNOWN" || !legacyHb) {
    amazonSession = "UNKNOWN"
  } else {
    amazonSession = "LOGIN REQUIRED"
  }

  const primaryPublic: AmazonBrowserHeartbeatRow | null =
    (await getAmazonBrowserHeartbeat(publicWorkerClaimId(configuredSlots[0] ?? "A"))) ??
    (await getAmazonBrowserHeartbeat(AMAZON_PUBLIC_BROWSER_WORKER_ID))

  return {
    status: 200,
    body: {
      generatedAt: new Date().toISOString(),
      flags: {
        serverBrowserEnabled: cfg.serverBrowserEnabled,
        serverBrowserPrimary: cfg.serverBrowserPrimary,
        extensionFallbackEnabled: cfg.extensionFallbackEnabled,
        keepaDispatchEnabled: cfg.keepaDispatchEnabled,
      },
      engine: {
        activeEngine: engine.activeEngine,
        verificationEngineLabel: engine.verificationEngineLabel,
        legacyLoginWorkerStatus: engine.legacyLoginWorker.code,
        legacyLoginWorkerLabel: engine.legacyLoginWorker.label,
        publicWorkerOwnsQueue: engine.publicWorkerOwnsQueue,
        loginWorkerClaimEnabled: engine.loginWorkerClaimEnabled,
        publicWorkerStalled: engine.publicWorkerStalled,
        publicPoolChallenge,
        publicPoolBackoff: poolBackoff || anyBackoff,
        publicHeartbeatWorkerId: publicWorkerClaimId(configuredSlots[0] ?? "A"),
        stallThresholdMs: stallMs,
        lastQueueProgressAt: lastProgressAt?.toISOString() ?? null,
        queueSource: "amazon_price_verification_tasks",
        queueNote:
          "pending=queued total; claimable=claim SQL now; backoff=RETRYABLE waiting available_at; STALLED only when claimable>0",
      },
      pool: {
        label: "PUBLIC WORKER POOL",
        configured: configuredCount,
        healthy,
        active,
        stalled: publicWorkers.filter(w => w.displayStatus === "STALLED").length,
        backoffWaiting: publicWorkers.filter(w => w.displayStatus === "BACKOFF BEKLİYOR").length,
        challenge: publicPoolChallenge,
        queuePending: pending,
        queueClaimable: claimable,
        queueBackoff: backoff,
        queueRunning: running,
        nextRetryAt: nextRetryAt?.toISOString() ?? null,
        nextRetryInMinutes,
        completedLast15m,
        completedLast1h: poolCompletedLast1h,
        avgTaskDurationSec: poolAvgDurationSec != null && Number.isFinite(poolAvgDurationSec) ? poolAvgDurationSec : null,
        workers: publicWorkers,
      },
      serverResources: {
        ramTotalBytes: serverResources.ramTotalBytes,
        ramUsedBytes: serverResources.ramUsedBytes,
        ramAvailableBytes: serverResources.ramAvailableBytes,
        ramUsedPct: serverResources.ramUsedPct,
        swapTotalBytes: serverResources.swapTotalBytes,
        swapUsedBytes: serverResources.swapUsedBytes,
        cpuPct: serverResources.cpuPct,
        load1: serverResources.load1,
        load5: serverResources.load5,
        load15: serverResources.load15,
        iowaitPct: serverResources.iowaitPct,
        warning: serverResources.warning,
        warningReason: serverResources.warningReason,
      },
      account: publicAmazonAccountView(account),
      worker: {
        workerId: publicWorkerOwnsQueue()
          ? publicWorkerClaimId(configuredSlots[0] ?? "A")
          : AMAZON_BROWSER_WORKER_ID,
        legacyWorkerId: AMAZON_BROWSER_WORKER_ID,
        online: publicWorkerOwnsQueue() ? healthy > 0 : workerOnline,
        status: publicWorkerOwnsQueue() ? (primaryPublic?.status ?? "OFFLINE") : (legacyHb?.status ?? "OFFLINE"),
        browserWorker,
        amazonSession,
        lastHeartbeatAt: publicWorkerOwnsQueue()
          ? primaryPublic?.lastHeartbeatAt?.toISOString() ?? null
          : legacyHb?.lastHeartbeatAt?.toISOString() ?? null,
        browserRunning: publicWorkerOwnsQueue()
          ? publicWorkers.some(w => w.browserRunning === true)
          : legacyHb?.browserRunning === true,
        amazonSessionState: publicWorkerOwnsQueue()
          ? primaryPublic?.amazonSessionState ?? "PUBLIC_UNAUTHENTICATED"
          : legacyHb?.amazonSessionState ?? account.sessionState,
        currentTaskId: publicWorkerOwnsQueue()
          ? (publicWorkers.find(w => w.currentTaskId != null)?.currentTaskId as number | null) ?? null
          : legacyHb?.currentTaskId ?? null,
        queuePending: pending,
        queueClaimable: claimable,
        queueBackoff: backoff,
        lastSuccessAt: publicWorkerOwnsQueue()
          ? primaryPublic?.lastSuccessAt?.toISOString() ?? null
          : legacyHb?.lastSuccessAt?.toISOString() ??
            account.lastSuccessfulVerificationAt?.toISOString() ??
            null,
        lastError: publicWorkerOwnsQueue()
          ? poolHb?.lastError ?? primaryPublic?.lastError ?? null
          : legacyHb?.lastError ?? account.lastError,
        pauseReason: publicWorkerOwnsQueue()
          ? poolHb?.pauseReason ?? primaryPublic?.pauseReason ?? null
          : legacyHb?.pauseReason ?? null,
        concurrency: configuredCount,
        profilePathConfigured: Boolean(process.env.AMAZON_BROWSER_PROFILE_DIR?.trim() || amazonBrowserProfileDir()),
      },
      queue: {
        pending,
        claimable,
        backoff,
        running,
        nextRetryAt: nextRetryAt?.toISOString() ?? null,
        nextRetryInMinutes,
        completedLast1h,
        failedLast1h: parseInt(hour.rows[0]?.failed ?? "0", 10) || 0,
      },
    },
  }
}

export async function handlePutAmazonWorkerAccount(body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  const accountType = String(body.accountType ?? "").toUpperCase()
  const saved = await saveAmazonWorkerAccount({
    email: typeof body.email === "string" ? body.email : undefined,
    accountType: accountType === "BUSINESS" || accountType === "PERSONAL" ? accountType : undefined,
    password: typeof body.password === "string" ? body.password : undefined,
    authenticatorEnabled: typeof body.authenticatorEnabled === "boolean" ? body.authenticatorEnabled : undefined,
    totpSecret: typeof body.totpSecret === "string" ? body.totpSecret : undefined,
    proxyEnabled: typeof body.proxyEnabled === "boolean" ? body.proxyEnabled : undefined,
    proxyHost: typeof body.proxyHost === "string" ? body.proxyHost : undefined,
    proxyPort: body.proxyPort != null && body.proxyPort !== "" ? Number(body.proxyPort) : undefined,
    proxyUsername: typeof body.proxyUsername === "string" ? body.proxyUsername : undefined,
    proxyPassword: typeof body.proxyPassword === "string" ? body.proxyPassword : undefined,
  })
  return { status: 200, body: { ok: true, account: publicAmazonAccountView(saved) } }
}

export async function handlePostAmazonWorkerPause(): Promise<{ status: number; body: unknown }> {
  await updateAmazonAccountStatus({
    accountStatus: "PAUSED",
    lastError: "Paused from admin panel",
  })
  return { status: 200, body: { ok: true, accountStatus: "PAUSED" } }
}

export async function handlePostAmazonWorkerResume(): Promise<{ status: number; body: unknown }> {
  const account = await getAmazonWorkerAccount()
  const next = account.email && account.passwordEncrypted ? "READY" : "UNCONFIGURED"
  await updateAmazonAccountStatus({
    accountStatus: next,
    sessionState: "UNKNOWN",
    lastError: null,
  })
  return { status: 200, body: { ok: true, accountStatus: next, sessionBootstrapRequested: next === "READY" } }
}

export async function handlePostAmazonWorkerResetSecret(body: Record<string, unknown>): Promise<{
  status: number
  body: unknown
}> {
  const target = String(body.target ?? "").toLowerCase()
  if (!["password", "totp", "proxyPassword"].includes(target)) {
    return { status: 400, body: { error: "target must be password, totp, or proxyPassword" } }
  }
  const saved = await saveAmazonWorkerAccount({
    removePassword: target === "password",
    removeTotp: target === "totp",
    removeProxyPassword: target === "proxyPassword",
  })
  return { status: 200, body: { ok: true, account: publicAmazonAccountView(saved) } }
}

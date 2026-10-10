/**
 * Public Amazon verification worker loop (one process = one pool slot A/B/C…).
 * Claims the shared SERVER_BROWSER production queue; concurrency=1 per slot.
 * Challenge → pool-wide pause (no profile rotation). Technical failure → RETRYABLE + recycle.
 */
import {
  countPendingVerificationTasks,
  failVerificationTask,
  markVerificationRunning,
  recoverExpiredRunningServerBrowserTasks,
  routePriceMissingToAuthenticatedWorker,
  submitVerificationResult,
} from "../amazonVerification/amazonVerificationQueue"
import {
  claimNextServerBrowserVerificationTask,
  releaseServerBrowserVerificationTask,
} from "../amazonBrowserWorker/amazonBrowserClaim"
import {
  getAmazonBrowserHeartbeat,
  upsertAmazonBrowserHeartbeat,
} from "../amazonBrowserWorker/amazonBrowserHeartbeat"
import {
  amazonBrowserExpiredRunningWatchdogMs,
  amazonBrowserHeartbeatMs,
  amazonBrowserPaceMs,
  amazonPublicObserveHardTimeoutMs,
  AMAZON_BROWSER_WORKER_ID,
  AMAZON_PUBLIC_BROWSER_WORKER_ID,
} from "../amazonBrowserWorker/amazonBrowserWorkerConstants"
import { classifyVerifiedAmazonSource } from "../amazonVerification/verifiedSourceDecision"
import { shipsFromAmazon } from "../amazonVerification/amazonVerificationNormalize"
import {
  AmazonPublicWorker,
  setPublicWorkerPersistenceSink,
  type AmazonResult,
} from "../amazonPublicWorker"
import type { AppConfig } from "../amazonPublicWorker/types"
import { mapPublicObservationToVerificationPayload } from "../amazonPublicWorker/mapPublicObservationToVerificationPayload"
import { publicWorkerOwnsQueue } from "../amazonBrowserWorker/amazonWorkerEngineStatus"
import { updateAmazonAccountStatus } from "../amazonBrowserWorker/amazonWorkerAccountVault"
import {
  AMAZON_PUBLIC_BROWSER_POOL_ID,
  resolvePublicWorkerIdentity,
  type PublicWorkerIdentity,
} from "./amazonPublicWorkerPool"
import fs from "fs"
import path from "path"

const EXTRA_LOG_LIMIT = 400
let extraLogged = 0
let stopping = false
let workerStatus = "STARTING"
let pauseReason: string | null = null
let currentTaskId: number | null = null
let lastSuccessAt: Date | null = null
let lastError: string | null = null
let browserRunning = false
let publicWorker: AmazonPublicWorker | null = null
let timeoutCount = 0
let recycleCount = 0
let identity: PublicWorkerIdentity = resolvePublicWorkerIdentity()

const LOG_PATH = path.join(process.cwd(), "var", "diagnostics", "public-worker-task-log.jsonl")

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

function logPublicTask(row: Record<string, unknown>): void {
  if (extraLogged >= EXTRA_LOG_LIMIT) return
  extraLogged += 1
  const line = JSON.stringify({ ts: new Date().toISOString(), slot: identity.slot, ...row })
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true })
    fs.appendFileSync(LOG_PATH, line + "\n")
  } catch {
    /* ignore */
  }
  console.log(
    `[PUBLIC_WORKER_TASK] slot=${identity.slot} ASIN=${row.asin} status=${row.publicStatus} mapped=${row.mappedProductionResult} price=${row.price} Prime=${row.prime} ShipsFrom=${row.shipsFrom} action=${row.finalAction}`
  )
}

async function heartbeat(): Promise<void> {
  await upsertAmazonBrowserHeartbeat({
    workerId: identity.heartbeatWorkerId,
    status: workerStatus,
    browserRunning,
    amazonSessionState: `PUBLIC_UNAUTHENTICATED|slot=${identity.slot}|t=${timeoutCount}|r=${recycleCount}`,
    currentTaskId,
    queuePending: await countPendingVerificationTasks().catch(() => null),
    lastSuccessAt,
    lastError,
    pauseReason,
  })
}

async function setPoolChallenge(reason: string): Promise<void> {
  await upsertAmazonBrowserHeartbeat({
    workerId: AMAZON_PUBLIC_BROWSER_POOL_ID,
    status: "CHALLENGE_REQUIRED",
    browserRunning: false,
    amazonSessionState: "POOL_CHALLENGE",
    currentTaskId: null,
    queuePending: await countPendingVerificationTasks().catch(() => null),
    lastSuccessAt: null,
    lastError: reason,
    pauseReason: `Pool challenge from worker ${identity.slot}: ${reason}`,
  })
}

async function readPoolChallengeActive(): Promise<boolean> {
  const pool = await getAmazonBrowserHeartbeat(AMAZON_PUBLIC_BROWSER_POOL_ID).catch(() => null)
  return pool?.status === "CHALLENGE_REQUIRED"
}

function defaultConfig(): AppConfig {
  return {
    localPort: 0,
    keepaConcurrency: 1,
    amazonMode: "FAILOVER",
    amazonWorkers: [identity.browserName],
    amazonActiveConcurrency: 1,
    amazonHeadless: true,
    navigationTimeout: 45000,
    keepaHeadless: true,
    keepaDelayMs: 1500,
    amazonDelayMs: 2500,
    technicalRetryMax: 1,
  }
}

function needsBrowserRecycle(reason: string | undefined): boolean {
  if (!reason) return false
  return /OBSERVE_HARD_TIMEOUT|timeout|timed?\s*out|Target closed|browser|connection|crashed|Protocol error|Execution context|Session closed|net::ERR/i.test(
    reason
  )
}

async function recyclePublicBrowser(reason: string): Promise<void> {
  recycleCount += 1
  if (/OBSERVE_HARD_TIMEOUT/i.test(reason)) timeoutCount += 1
  console.warn(`[amazon-public-worker-${identity.slot}] browser recycle (#${recycleCount}): ${reason}`)
  const prev = publicWorker
  publicWorker = null
  browserRunning = false
  await prev?.close("RECYCLE").catch(() => undefined)
}

async function ensurePublicWorker(): Promise<AmazonPublicWorker> {
  if (!publicWorker) {
    publicWorker = new AmazonPublicWorker(identity.browserName, defaultConfig(), {
      profileDir: identity.profileDir,
    })
  }
  await publicWorker.open()
  browserRunning = true
  return publicWorker
}

async function observeWithHardTimeout(worker: AmazonPublicWorker, asin: string): Promise<AmazonResult> {
  const hardMs = amazonPublicObserveHardTimeoutMs()
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeoutPromise = new Promise<AmazonResult>(resolve => {
    timer = setTimeout(() => {
      timedOut = true
      resolve({ kind: "technical", reason: `OBSERVE_HARD_TIMEOUT after ${hardMs}ms` })
    }, hardMs)
  })
  try {
    const result = await Promise.race([worker.observe(asin), timeoutPromise])
    if (timedOut || (result.kind === "technical" && /OBSERVE_HARD_TIMEOUT/i.test(result.reason ?? ""))) {
      await recyclePublicBrowser(`OBSERVE_HARD_TIMEOUT asin=${asin}`)
      return { kind: "technical", reason: `OBSERVE_HARD_TIMEOUT after ${hardMs}ms` }
    }
    return result
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function processOne(): Promise<boolean> {
  if (!publicWorkerOwnsQueue()) {
    workerStatus = "PAUSED"
    pauseReason = "AMAZON_PUBLIC_WORKER_OWNS_QUEUE not enabled"
    return false
  }

  const { loadAmazonScanConfig } = await import("../amazonScan/amazonScanConfig")
  if (loadAmazonScanConfig().remoteWorkersEnabled) {
    workerStatus = "PAUSED"
    pauseReason = "AMAZON_SCAN_REMOTE_WORKERS_ENABLED — local public claim stopped"
    return false
  }

  if (await readPoolChallengeActive()) {
    workerStatus = "CHALLENGE_REQUIRED"
    pauseReason = "Pool challenge — no profile rotation; waiting for operator"
    return false
  }

  if (workerStatus === "CHALLENGE_REQUIRED") {
    return false
  }

  const claimed = await claimNextServerBrowserVerificationTask({
    workerId: identity.claimWorkerId,
  })
  if (!claimed.task) {
    if (workerStatus !== "CHALLENGE_REQUIRED" && workerStatus !== "PAUSED") {
      workerStatus = "ONLINE"
      pauseReason = null
    }
    return false
  }

  const task = claimed.task
  currentTaskId = task.id
  workerStatus = "ONLINE"
  pauseReason = null

  const running = await markVerificationRunning({
    taskId: task.id,
    workspaceId: task.workspaceId,
    userId: task.preferredUserId,
    workerId: identity.claimWorkerId,
  })
  if (!running) {
    currentTaskId = null
    return true
  }

  try {
    const worker = await ensurePublicWorker()
    const result = await observeWithHardTimeout(worker, task.asin)

    if (result.kind === "challenge") {
      workerStatus = "CHALLENGE_REQUIRED"
      pauseReason = result.reason ?? "Amazon CAPTCHA"
      lastError = pauseReason
      await setPoolChallenge(pauseReason).catch(() => undefined)
      await releaseServerBrowserVerificationTask({
        taskId: task.id,
        workerId: identity.claimWorkerId,
      })
      logPublicTask({
        asin: task.asin,
        publicStatus: "CHALLENGE",
        mappedProductionResult: "CAPTCHA",
        price: null,
        prime: null,
        shipsFrom: null,
        finalAction: "POOL_PAUSE_NO_ROTATION",
      })
      return false
    }

    if (result.kind === "technical") {
      lastError = result.reason ?? "public worker technical error"
      if (needsBrowserRecycle(result.reason)) {
        await recyclePublicBrowser(result.reason ?? "technical")
      }
      await failVerificationTask({
        taskId: task.id,
        workspaceId: task.workspaceId,
        userId: task.preferredUserId,
        workerId: identity.claimWorkerId,
        code: "WORKER_ERROR",
        message: result.reason ?? "public worker technical error",
      })
      lastSuccessAt = new Date()
      logPublicTask({
        asin: task.asin,
        publicStatus: "TECHNICAL",
        mappedProductionResult: "TECHNICAL",
        price: null,
        prime: null,
        shipsFrom: null,
        finalAction: "FAIL_RETRYABLE",
      })
      return true
    }

    const observation = result.observation!
    const publicStatus = result.status ?? "AMAZON_INCOMPLETE"
    const mapped = mapPublicObservationToVerificationPayload({
      requestedAsin: task.asin,
      observation,
      publicStatus,
    })

    const priceMissing =
      observation.pageExists &&
      observation.actualAsin === task.asin.trim().toUpperCase() &&
      (observation.priceMissing === true ||
        observation.mainPrice == null ||
        observation.mainPrice <= 0)
    if (priceMissing) {
      const routed = await routePriceMissingToAuthenticatedWorker({
        taskId: task.id,
        workspaceId: task.workspaceId,
        userId: task.preferredUserId,
        workerId: identity.claimWorkerId,
        originalReason: task.reason,
      })
      if (routed) {
        lastSuccessAt = new Date()
        lastError = null
        logPublicTask({
          asin: task.asin,
          publicStatus,
          mappedProductionResult: "PRICE_MISSING_AUTH_FALLBACK",
          price: observation.mainPrice,
          prime: observation.primeVisible,
          shipsFrom: mapped.shipsFromNormalized,
          finalAction: "ROUTED_TO_SERVER_BROWSER_AUTH",
        })
      }
      return true
    }

    if (publicStatus === "AMAZON_INCOMPLETE") {
      await failVerificationTask({
        taskId: task.id,
        workspaceId: task.workspaceId,
        userId: task.preferredUserId,
        workerId: identity.claimWorkerId,
        code: "AMAZON_INCOMPLETE",
        message: "Public observation incomplete — non-destructive",
      })
      // Progress = any finished attempt (retryable incomplete counts; not only VALID_SOURCE).
      lastSuccessAt = new Date()
      lastError = null
      logPublicTask({
        asin: task.asin,
        publicStatus,
        mappedProductionResult: "INCOMPLETE",
        price: observation.mainPrice,
        prime: observation.primeVisible,
        shipsFrom: mapped.shipsFromNormalized,
        finalAction: "FAIL_RETRYABLE_NON_DESTRUCTIVE",
      })
      return true
    }

    await submitVerificationResult({
      taskId: task.id,
      workspaceId: task.workspaceId,
      userId: task.preferredUserId,
      workerId: identity.claimWorkerId,
      payload: mapped.payload,
    })

    const decision = classifyVerifiedAmazonSource({
      requestedAsin: task.asin,
      finalAsin: mapped.payload.finalAsin,
      displayedPrice: typeof mapped.payload.displayedPrice === "number" ? mapped.payload.displayedPrice : null,
      condition: typeof mapped.payload.condition === "string" ? mapped.payload.condition : null,
      isPrime: typeof mapped.payload.isPrime === "boolean" ? mapped.payload.isPrime : null,
      isFba: typeof mapped.payload.isFba === "boolean" ? mapped.payload.isFba : null,
      shipsFromAmazon: shipsFromAmazon(mapped.shipsFromNormalized),
      stockStatus: typeof mapped.payload.stockStatus === "string" ? mapped.payload.stockStatus : null,
      availabilityText: typeof mapped.payload.availabilityText === "string" ? mapped.payload.availabilityText : null,
      pageUnavailable: mapped.payload.pageUnavailable === true,
      redirected: mapped.payload.redirected === true,
      offerPageHealthy: mapped.payload.metadata?.offerPageHealthy === true,
    })

    lastSuccessAt = new Date()
    lastError = null
    logPublicTask({
      asin: task.asin,
      publicStatus,
      mappedProductionResult: `${decision.outcome}/${decision.code}`,
      price: observation.mainPrice,
      prime: observation.primeVisible,
      shipsFrom: mapped.shipsFromNormalized,
      finalAction: decision.outcome,
    })
    return true
  } catch (e) {
    const message = e instanceof Error ? e.message.slice(0, 200) : "public verification failed"
    lastError = message
    if (needsBrowserRecycle(message)) {
      await recyclePublicBrowser(message)
    }
    await failVerificationTask({
      taskId: task.id,
      workspaceId: task.workspaceId,
      userId: task.preferredUserId,
      workerId: identity.claimWorkerId,
      code: "WORKER_ERROR",
      message,
    }).catch(() => undefined)
    lastSuccessAt = new Date()
    logPublicTask({
      asin: task.asin,
      publicStatus: "TECHNICAL",
      mappedProductionResult: "TECHNICAL",
      price: null,
      prime: null,
      shipsFrom: null,
      finalAction: "FAIL_RETRYABLE",
    })
    return true
  } finally {
    currentTaskId = null
  }
}

export async function startAmazonPublicBrowserWorkerLoop(): Promise<void> {
  identity = resolvePublicWorkerIdentity()
  stopping = false
  workerStatus = "STARTING"
  setPublicWorkerPersistenceSink({
    logEvent: (event, asin, worker, detail) => {
      console.log(
        `[public-worker-${identity.slot}] ${event} asin=${asin ?? "-"} worker=${worker ?? "-"} ${detail ?? ""}`
      )
    },
    updateItem: () => undefined,
  })

  console.log(
    `[amazon-public-worker] slot=${identity.slot} claimId=${identity.claimWorkerId} ` +
      `heartbeatId=${identity.heartbeatWorkerId} profile=${identity.profileDir} ` +
      `ownsQueue=${publicWorkerOwnsQueue()} observeHardTimeoutMs=${amazonPublicObserveHardTimeoutMs()}`
  )

  const beat = setInterval(() => {
    void heartbeat().catch((error: unknown) => {
      lastError = error instanceof Error ? error.message : String(error)
      console.error("[amazon-public-worker-" + identity.slot + "] heartbeat error:", lastError)
    })
  }, amazonBrowserHeartbeatMs())

  const expiredWatch = setInterval(() => {
    void recoverExpiredRunningServerBrowserTasks({
      workerId: identity.claimWorkerId,
      limit: 20,
    }).catch(() => undefined)
  }, amazonBrowserExpiredRunningWatchdogMs())

  // Own slot + legacy single-worker ids (post-migrate orphans).
  for (const wid of [
    identity.claimWorkerId,
    AMAZON_PUBLIC_BROWSER_WORKER_ID,
    AMAZON_BROWSER_WORKER_ID,
  ]) {
    await recoverExpiredRunningServerBrowserTasks({ workerId: wid, limit: 50 }).catch(() => undefined)
  }

  if (publicWorkerOwnsQueue()) {
    await updateAmazonAccountStatus({
      lastError: "STANDBY — public Amazon worker pool owns queue (legacy login not claiming)",
    }).catch(() => undefined)
  }

  // Clear stale pool challenge only if env explicitly requests (ops). Default: keep challenge sticky.
  if (String(process.env.AMAZON_PUBLIC_POOL_CLEAR_CHALLENGE_ON_BOOT ?? "").toLowerCase() === "true") {
    await upsertAmazonBrowserHeartbeat({
      workerId: AMAZON_PUBLIC_BROWSER_POOL_ID,
      status: "ONLINE",
      browserRunning: false,
      amazonSessionState: "POOL_READY",
      pauseReason: null,
      lastError: null,
    }).catch(() => undefined)
  }

  if (await readPoolChallengeActive()) {
    workerStatus = "CHALLENGE_REQUIRED"
    pauseReason = "Pool challenge — no profile rotation; waiting for operator"
  } else {
    workerStatus = "ONLINE"
  }
  await heartbeat()

  while (!stopping) {
    try {
      if (workerStatus === "CHALLENGE_REQUIRED" || (await readPoolChallengeActive())) {
        workerStatus = "CHALLENGE_REQUIRED"
        pauseReason = pauseReason ?? "Pool challenge — no profile rotation; waiting for operator"
        await heartbeat()
        await sleep(amazonBrowserPaceMs())
        continue
      }
      const did = await processOne()
      await heartbeat()
      await sleep(did ? amazonBrowserPaceMs() : Math.min(amazonBrowserPaceMs(), 3000))
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
      console.error(`[amazon-public-worker-${identity.slot}] loop error:`, lastError)
      if (needsBrowserRecycle(lastError)) {
        await recyclePublicBrowser(lastError).catch(() => undefined)
      }
      await heartbeat().catch(() => undefined)
      await sleep(amazonBrowserPaceMs())
    }
  }

  clearInterval(beat)
  clearInterval(expiredWatch)
  await publicWorker?.close().catch(() => undefined)
  publicWorker = null
  browserRunning = false
  setPublicWorkerPersistenceSink(null)
  await heartbeat().catch(() => undefined)
}

export async function stopAmazonPublicBrowserWorkerLoop(): Promise<void> {
  stopping = true
  await publicWorker?.close().catch(() => undefined)
  publicWorker = null
  browserRunning = false
}

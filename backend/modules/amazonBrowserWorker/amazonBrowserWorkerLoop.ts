import fs from "fs"
import { chromium, type BrowserContext, type Page } from "playwright"
import { loadAmazonVerificationConfig } from "../amazonVerification/amazonVerificationConfig"
import {
  claimNextAuthenticatedPriceFallbackTask,
  countClaimableAuthenticatedPriceFallbackTasks,
  countPendingVerificationTasks,
  failVerificationTask,
  markVerificationRunning,
  recoverExpiredRunningAuthenticatedPriceTasks,
  recoverExpiredRunningServerBrowserTasks,
  releaseAuthenticatedPriceFallbackTask,
  submitVerificationResult,
} from "../amazonVerification/amazonVerificationQueue"
import {
  claimNextServerBrowserVerificationTask,
  releaseServerBrowserVerificationTask,
} from "./amazonBrowserClaim"
import {
  amazonBrowserCircuitCooldownMs,
  amazonBrowserCircuitFailures,
  amazonBrowserExpiredRunningWatchdogMs,
  amazonBrowserFinalizationTimeoutMs,
  amazonBrowserGotoTimeoutMs,
  amazonBrowserHeartbeatMs,
  amazonBrowserPaceMs,
  amazonBrowserProfileDir,
  amazonBrowserTaskAttemptWallclockMs,
  AMAZON_AUTH_PRICE_FALLBACK_WORKER_ID,
  AMAZON_BROWSER_WORKER_ID,
} from "./amazonBrowserWorkerConstants"
import { upsertAmazonBrowserHeartbeat } from "./amazonBrowserHeartbeat"
import { extractAmazonVerification, isAmazonSorryPage, pageLooksLikeAmazonNotFound, waitForProductOfferReady } from "./amazonPageExtract"
import { evaluateOfferPrimeFbaSignals } from "./amazonOfferPrimeFbaGate"
import { detectAmazonSession, ensureAmazonSession, isAmazonSignInLocation } from "./amazonLoginManager"
import {
  decryptAmazonProxyPassword,
  getAmazonWorkerAccount,
  updateAmazonAccountStatus,
} from "./amazonWorkerAccountVault"
import { loginWorkerClaimEnabled, publicWorkerOwnsQueue } from "./amazonWorkerEngineStatus"

class CircuitBreaker {
  failures = 0
  openUntil = 0
  recordSuccess(): void {
    this.failures = 0
    this.openUntil = 0
  }
  recordFailure(): boolean {
    this.failures += 1
    if (this.failures >= amazonBrowserCircuitFailures()) {
      this.openUntil = Date.now() + amazonBrowserCircuitCooldownMs()
      return true
    }
    return false
  }
  isOpen(): boolean {
    return Date.now() < this.openUntil
  }
}

let stopping = false
let context: BrowserContext | null = null
let page: Page | null = null
let currentTaskId: number | null = null
let pauseReason: string | null = null
let workerStatus = "STARTING"
let sessionState = "UNKNOWN"
let browserRunning = false
let lastSuccessAt: Date | null = null
let lastError: string | null = null
let sessionGateOk = false
let lastBootstrapAttemptAt = 0
let lastSuccessfulSessionCheckAt = 0
const circuit = new CircuitBreaker()

const BOOTSTRAP_FAIL_COOLDOWN_MS = 60_000
const SESSION_RECHECK_MS = 5 * 60_000

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`))
    }, ms)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  }) as Promise<T>
}

function isNavigationTechnicalError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e)
  if (/NAVIGATION_TIMEOUT|TASK_ATTEMPT_WATCHDOG/i.test(msg)) return true
  if (/Timeout \d+ms exceeded/i.test(msg)) return true
  if (/page\.goto/i.test(msg) && /timeout/i.test(msg)) return true
  if (/Navigation timeout/i.test(msg)) return true
  if (/net::ERR_/i.test(msg)) return true
  if (/Target closed|browser has been closed|Protocol error/i.test(msg)) return true
  return false
}

async function discardWedgedPage(): Promise<void> {
  try {
    if (page && !page.isClosed()) {
      await page.close({ runBeforeUnload: false }).catch(() => undefined)
    }
  } catch {
    /* ignore */
  }
  page = null
  try {
    if (context) {
      page = await context.newPage()
    }
  } catch (e) {
    console.warn(
      `[amazon-browser-worker] page recycle failed:`,
      e instanceof Error ? e.message : e
    )
    browserRunning = Boolean(context)
  }
}

type VerifyTaskRef = {
  id: number
  workspaceId: string
  preferredUserId: string
  asin: string
  attemptCount?: number
}

async function finalizeTechnicalFailure(
  task: VerifyTaskRef,
  code: string,
  message: string,
  logTag: string
): Promise<void> {
  const msg = message.slice(0, 400)
  lastError = msg.slice(0, 200)
  console.log(
    `[amazon-browser-worker] ${logTag} task_id=${task.id} asin=${task.asin} ` +
      `attempt_count=${(task.attemptCount ?? 0) + 1} reason=${msg.slice(0, 160)}`
  )
  const opened = circuit.recordFailure()
  if (opened) {
    workerStatus = "THROTTLED"
    pauseReason = "Circuit breaker open after Amazon errors"
    lastError = pauseReason
  }
  try {
    await withDeadline(
      failVerificationTask({
        taskId: task.id,
        workspaceId: task.workspaceId,
        userId: task.preferredUserId,
        workerId: AMAZON_BROWSER_WORKER_ID,
        code,
        message: msg,
      }),
      amazonBrowserFinalizationTimeoutMs(),
      "TASK_FINALIZATION"
    )
  } catch (e) {
    const failMsg = e instanceof Error ? e.message : String(e)
    console.error(
      `[amazon-browser-worker] TASK_FINALIZATION_FAILURE task_id=${task.id} asin=${task.asin}: ${failMsg}`
    )
    // Last-resort ownership clear so claim/watchdog can proceed.
    await releaseServerBrowserVerificationTask({
      taskId: task.id,
      workerId: AMAZON_BROWSER_WORKER_ID,
    }).catch(() => undefined)
  }
  await discardWedgedPage()
  currentTaskId = null
}

async function heartbeat(): Promise<void> {
  await upsertAmazonBrowserHeartbeat({
    status: workerStatus,
    browserRunning,
    amazonSessionState: sessionState,
    currentTaskId,
    queuePending: await countPendingVerificationTasks().catch(() => null),
    lastSuccessAt,
    lastError,
    pauseReason,
  })
}

function pauseWorker(status: string, reason: string): void {
  workerStatus = status
  pauseReason = reason
  lastError = reason
  if (
    status === "LOGIN_REQUIRED" ||
    status === "LOGIN_FAILED" ||
    status === "CHALLENGE_REQUIRED" ||
    status === "PAUSED" ||
    status === "ERROR"
  ) {
    sessionGateOk = false
  }
}

async function applyAmazonSessionGate(activePage: Page): Promise<boolean> {
  sessionGateOk = false
  const login = await ensureAmazonSession(activePage)
  if (!login.ok) {
    const hbStatus =
      login.state === "CHALLENGE_REQUIRED"
        ? "CHALLENGE_REQUIRED"
        : login.state === "LOGIN_FAILED"
          ? "LOGIN_FAILED"
          : "LOGIN_REQUIRED"
    pauseWorker(hbStatus, login.reason)
    sessionState = login.state === "CHALLENGE_REQUIRED" ? "CHALLENGE" : "LOGIN_REQUIRED"
    console.log(`[amazon-browser-worker] Amazon session bootstrap failed: ${login.state}`)
    return false
  }
  sessionGateOk = true
  sessionState = "ACTIVE"
  workerStatus = "ONLINE"
  pauseReason = null
  lastError = null
  lastSuccessfulSessionCheckAt = Date.now()
  circuit.recordSuccess()
  console.log("[amazon-browser-worker] Amazon login successful / session verified")
  return true
}

/**
 * Proactive Amazon session bootstrap — runs with empty queue too.
 * Does not claim verification tasks. Never mutates eBay.
 */
async function bootstrapAmazonSession(reason: string): Promise<boolean> {
  const account = await getAmazonWorkerAccount()
  if (account.accountStatus === "PAUSED") {
    pauseWorker("PAUSED", account.lastError || "PAUSED")
    sessionState = account.sessionState || "UNKNOWN"
    return false
  }
  if (account.accountStatus === "CHALLENGE_REQUIRED") {
    pauseWorker("CHALLENGE_REQUIRED", "Amazon CAPTCHA or challenge")
    sessionState = "CHALLENGE"
    return false
  }
  if (account.accountStatus === "UNCONFIGURED" || !account.email || !account.passwordEncrypted) {
    workerStatus = "ONLINE"
    sessionState = "LOGIN_REQUIRED"
    pauseReason = "Amazon credentials not configured"
    lastError = pauseReason
    sessionGateOk = false
    return false
  }

  const now = Date.now()
  const forceAfterResume = account.accountStatus === "READY"
  if (
    sessionGateOk &&
    browserRunning &&
    !forceAfterResume &&
    now - lastSuccessfulSessionCheckAt < SESSION_RECHECK_MS
  ) {
    return true
  }
  if (
    !forceAfterResume &&
    !sessionGateOk &&
    lastBootstrapAttemptAt > 0 &&
    now - lastBootstrapAttemptAt < BOOTSTRAP_FAIL_COOLDOWN_MS &&
    (workerStatus === "LOGIN_REQUIRED" ||
      workerStatus === "LOGIN_FAILED" ||
      workerStatus === "CHALLENGE_REQUIRED" ||
      workerStatus === "ERROR")
  ) {
    return false
  }

  lastBootstrapAttemptAt = now
  workerStatus = "STARTING"
  sessionState = "UNKNOWN"
  pauseReason = null
  console.log(`[amazon-browser-worker] Amazon session bootstrap started (${reason})`)
  await heartbeat().catch(() => undefined)

  try {
    const activePage = await ensurePage()
    console.log("[amazon-browser-worker] Persistent browser launched")
    if (!/amazon\./i.test(activePage.url())) {
      await activePage
        .goto("https://www.amazon.com/", { waitUntil: "domcontentloaded", timeout: 45000 })
        .catch(() => undefined)
    }

    const bootSession = await detectAmazonSession(activePage)
    if (bootSession === "CHALLENGE_REQUIRED") {
      pauseWorker("CHALLENGE_REQUIRED", "Amazon CAPTCHA or challenge")
      await updateAmazonAccountStatus({
        accountStatus: "CHALLENGE_REQUIRED",
        sessionState: "CHALLENGE",
        lastError: "Amazon CAPTCHA or challenge",
      })
      console.log("[amazon-browser-worker] Amazon challenge detected")
      return false
    }
    if (bootSession === "ACTIVE") {
      sessionGateOk = true
      sessionState = "ACTIVE"
      workerStatus = "ONLINE"
      pauseReason = null
      lastError = null
      lastSuccessfulSessionCheckAt = Date.now()
      await updateAmazonAccountStatus({
        accountStatus: "ONLINE",
        sessionState: "ACTIVE",
        lastError: null,
      })
      console.log("[amazon-browser-worker] Existing Amazon session verified")
      return true
    }

    console.log("[amazon-browser-worker] Amazon login required")
    return await applyAmazonSessionGate(activePage)
  } catch (e) {
    const message = e instanceof Error ? e.message.slice(0, 200) : "session bootstrap failed"
    // Technical failure: never consume tasks / never fake ACTIVE
    pauseWorker("ERROR", message)
    sessionState = "UNKNOWN"
    sessionGateOk = false
    browserRunning = Boolean(context)
    console.log(`[amazon-browser-worker] Amazon session bootstrap failed: technical — ${message}`)
    return false
  }
}

async function releaseClaimedTaskWithoutFail(taskId: number): Promise<void> {
  currentTaskId = null
  await releaseServerBrowserVerificationTask({
    taskId,
    workerId: AMAZON_BROWSER_WORKER_ID,
  })
}

async function submitProductNotFoundResult(task: {
  id: number
  workspaceId: string
  preferredUserId: string
  asin: string
}, pageUrl: string): Promise<void> {
  await submitVerificationResult({
    taskId: task.id,
    workspaceId: task.workspaceId,
    userId: task.preferredUserId,
    workerId: AMAZON_BROWSER_WORKER_ID,
    payload: {
      asin: task.asin,
      requestedAsin: task.asin,
      finalAsin: task.asin,
      displayedPrice: null,
      currency: "USD",
      condition: "New",
      shipsFrom: "",
      soldBy: "",
      isPrime: null,
      hasAddToCart: false,
      hasBuyNow: false,
      availabilityText: "Page not found",
      stockStatus: "OUT_OF_STOCK",
      pageUrl,
      captcha: false,
      pageUnavailable: true,
      redirected: false,
      metadata: {
        verificationSource: "SERVER_BROWSER",
        taskType: "VERIFY_SOURCE",
        verifiedAt: new Date().toISOString(),
      },
    },
  })
  lastSuccessAt = new Date()
  lastError = null
  workerStatus = "ONLINE"
  sessionState = "ACTIVE"
}

function productUrl(asin: string): string {
  return `https://www.amazon.com/dp/${encodeURIComponent(asin.trim().toUpperCase())}?th=1`
}

async function launchBrowser(): Promise<void> {
  const dir = amazonBrowserProfileDir()
  fs.mkdirSync(dir, { recursive: true })
  try {
    fs.chmodSync(dir, 0o700)
  } catch {
    /* Windows may ignore posix mode */
  }
  const account = await getAmazonWorkerAccount()
  const headless = process.env.AMAZON_BROWSER_HEADLESS === "true"
  const launchOpts: Parameters<typeof chromium.launchPersistentContext>[1] = {
    headless,
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
    args: ["--disable-dev-shm-usage"],
  }
  if (account.proxyEnabled && account.proxyHost && account.proxyPort) {
    const proxyPassword = decryptAmazonProxyPassword(account)
    launchOpts.proxy = {
      server: `http://${account.proxyHost}:${account.proxyPort}`,
      username: account.proxyUsername || undefined,
      password: proxyPassword || undefined,
    }
  }
  context = await chromium.launchPersistentContext(dir, launchOpts)
  const pages = context.pages()
  page = pages[0] ?? (await context.newPage())
  for (const extra of pages.slice(1)) {
    await extra.close().catch(() => undefined)
  }
  browserRunning = true
}

async function ensurePage(): Promise<Page> {
  if (!context || !page || page.isClosed()) {
    await launchBrowser()
  }
  if (!page) throw new Error("Amazon browser page is not available")
  return page
}

/**
 * One-shot authenticated price read for a row explicitly routed by the public worker.
 * This path never claims normal verification work and never uses cart/checkout.
 */
async function processAuthenticatedPriceFallback(): Promise<boolean> {
  const cfg = loadAmazonVerificationConfig()
  if (!cfg.serverBrowserEnabled || !publicWorkerOwnsQueue()) return false


  // Do not claim auth-owned work until the persisted account/session gate is
  // healthy. A challenge must leave tasks untouched, rather than claiming and
  // releasing each one into a new backoff window.
  const claimable = await countClaimableAuthenticatedPriceFallbackTasks()
  if (claimable === 0) return false

  const preflightAccount = await getAmazonWorkerAccount()
  if (
    preflightAccount.accountStatus === "PAUSED" ||
    preflightAccount.accountStatus === "CHALLENGE_REQUIRED" ||
    preflightAccount.accountStatus === "UNCONFIGURED" ||
    !preflightAccount.email ||
    !preflightAccount.passwordEncrypted
  ) {
    workerStatus = preflightAccount.accountStatus === "CHALLENGE_REQUIRED" ? "CHALLENGE_REQUIRED" : "PAUSED"
    sessionState = preflightAccount.sessionState || "UNKNOWN"
    pauseReason = preflightAccount.accountStatus === "CHALLENGE_REQUIRED" ? "Amazon CAPTCHA or challenge" : (preflightAccount.lastError || "Authenticated Prime worker unavailable")
    sessionGateOk = false
    return false
  }

  if (!sessionGateOk || preflightAccount.accountStatus === "READY") {
    const ok = await bootstrapAmazonSession("price-missing-auth-fallback")
    if (!ok) return false
  }

  const claimed = await claimNextAuthenticatedPriceFallbackTask({
    workerId: AMAZON_AUTH_PRICE_FALLBACK_WORKER_ID,
  })
  if (!claimed.task) return false

  const task = claimed.task
  currentTaskId = task.id
  workerStatus = "ONLINE"
  pauseReason = null

  const releaseAuthTask = async (delayMinutes = 30): Promise<void> => {
    await releaseAuthenticatedPriceFallbackTask({
      taskId: task.id,
      workerId: AMAZON_AUTH_PRICE_FALLBACK_WORKER_ID,
      delayMinutes,
    }).catch(() => undefined)
    currentTaskId = null
  }

  const running = await markVerificationRunning({
    taskId: task.id,
    workspaceId: task.workspaceId,
    userId: task.preferredUserId,
    workerId: AMAZON_AUTH_PRICE_FALLBACK_WORKER_ID,
  })
  if (!running) {
    currentTaskId = null
    return true
  }

  const account = await getAmazonWorkerAccount()
  if (
    account.accountStatus === "PAUSED" ||
    account.accountStatus === "CHALLENGE_REQUIRED" ||
    account.accountStatus === "UNCONFIGURED" ||
    !account.email ||
    !account.passwordEncrypted
  ) {
    pauseReason = account.lastError || "Authenticated Prime worker unavailable"
    await releaseAuthTask()
    return false
  }

  if (!sessionGateOk || account.accountStatus === "READY") {
    const ok = await bootstrapAmazonSession("price-missing-auth-fallback")
    if (!ok) {
      await releaseAuthTask()
      return false
    }
  }

  const activePage = await ensurePage()
  try {
    const liveSession = await detectAmazonSession(activePage)
    if (liveSession === "CHALLENGE_REQUIRED") {
      pauseWorker("CHALLENGE_REQUIRED", "Amazon CAPTCHA or challenge")
      await updateAmazonAccountStatus({
        accountStatus: "CHALLENGE_REQUIRED",
        sessionState: "CHALLENGE",
        lastError: "Amazon CAPTCHA or challenge during price fallback",
      })
      await releaseAuthTask()
      return false
    }
    if (liveSession === "LOGIN_REQUIRED") {
      if (!(await applyAmazonSessionGate(activePage))) {
        await releaseAuthTask()
        return false
      }
    }

    await activePage.goto(productUrl(task.asin), {
      waitUntil: "domcontentloaded",
      timeout: amazonBrowserGotoTimeoutMs(),
    })
    const readyState = await waitForProductOfferReady(activePage, 12000)
    if (readyState === "captcha") {
      pauseWorker("CHALLENGE_REQUIRED", "Amazon CAPTCHA")
      await updateAmazonAccountStatus({
        accountStatus: "CHALLENGE_REQUIRED",
        sessionState: "CHALLENGE",
        lastError: "Amazon CAPTCHA during price fallback",
      })
      await releaseAuthTask()
      return false
    }
    if (readyState === "gone" || (await pageLooksLikeAmazonNotFound(activePage))) {
      await failVerificationTask({
        taskId: task.id,
        workspaceId: task.workspaceId,
        userId: task.preferredUserId,
        workerId: AMAZON_AUTH_PRICE_FALLBACK_WORKER_ID,
        code: "PRICE_NOT_FOUND",
        message: "Authenticated Prime PDP did not expose a product price",
        preserveClaimedBySource: "SERVER_BROWSER_AUTH",
      })
      return true
    }

    const extracted = await extractAmazonVerification(activePage, task.asin)
    if (!extracted.ok) {
      if (extracted.errorCode === "CAPTCHA") {
        pauseWorker("CHALLENGE_REQUIRED", "Amazon CAPTCHA")
        await updateAmazonAccountStatus({
          accountStatus: "CHALLENGE_REQUIRED",
          sessionState: "CHALLENGE",
          lastError: "Amazon CAPTCHA during price fallback",
        })
        await releaseAuthTask()
        return false
      }
      if (extracted.errorCode === "LOGIN_REQUIRED") {
        await releaseAuthTask()
        return false
      }
      await failVerificationTask({
        taskId: task.id,
        workspaceId: task.workspaceId,
        userId: task.preferredUserId,
        workerId: AMAZON_AUTH_PRICE_FALLBACK_WORKER_ID,
        code: "PRICE_NOT_FOUND",
        message: `Authenticated Prime price extraction failed: ${extracted.errorCode}`,
        preserveClaimedBySource: "SERVER_BROWSER_AUTH",
      })
      return true
    }

    const data = extracted.data
    if (
      data.pageUnavailable ||
      data.displayedPrice == null ||
      !Number.isFinite(data.displayedPrice) ||
      data.displayedPrice <= 0
    ) {
      await failVerificationTask({
        taskId: task.id,
        workspaceId: task.workspaceId,
        userId: task.preferredUserId,
        workerId: AMAZON_AUTH_PRICE_FALLBACK_WORKER_ID,
        code: "PRICE_NOT_FOUND",
        message: "Authenticated Prime PDP still has no usable price",
        preserveClaimedBySource: "SERVER_BROWSER_AUTH",
      })
      return true
    }
    const signals = evaluateOfferPrimeFbaSignals(data)
    await submitVerificationResult({
      taskId: task.id,
      workspaceId: task.workspaceId,
      userId: task.preferredUserId,
      workerId: AMAZON_AUTH_PRICE_FALLBACK_WORKER_ID,
      payload: {
        asin: data.asin ?? task.asin,
        requestedAsin: data.requestedAsin ?? task.asin,
        finalAsin: data.finalAsin ?? data.asin ?? undefined,
        displayedPrice: data.displayedPrice,
        currency: data.currency,
        condition: data.condition,
        shipsFrom: data.shipsFrom,
        soldBy: data.soldBy,
        isPrime: signals.isPrime,
        isFba: signals.isFba,
        hasAddToCart: data.hasAddToCart,
        hasBuyNow: data.hasBuyNow,
        availabilityText: data.availabilityText,
        stockStatus: data.stockStatus,
        pageUrl: data.pageUrl,
        captcha: data.captcha,
        pageUnavailable: data.pageUnavailable,
        redirected: data.redirected,
        metadata: {
          verificationSource: "SERVER_BROWSER_AUTH",
          taskType: "PRICE_MISSING_AUTH_FALLBACK",
          verifiedAt: new Date().toISOString(),
          fallbackReason: "PUBLIC_PRICE_MISSING",
          decisionOrder: "PAGE>ASIN>STOCK>PRIME>SHIPS_FROM_AMAZON>CONDITION>IN_STOCK",
          shipsFromAmazon: signals.shipsFromAmazon,
          soldByAmazon: signals.soldByAmazon,
          purchasable: signals.purchasable,
          offerPageHealthy: signals.offerPageHealthy,
          domReadPass: 1,
          pageReady: readyState,
        },
      },
    })
    await updateAmazonAccountStatus({
      accountStatus: "ONLINE",
      sessionState: "ACTIVE",
      lastError: null,
      lastSuccessfulVerificationAt: new Date(),
    })
    lastSuccessAt = new Date()
    lastError = null
    workerStatus = "ONLINE"
    sessionState = "ACTIVE"
    return true
  } catch (e) {
    const message = e instanceof Error ? e.message.slice(0, 200) : "authenticated price fallback failed"
    if (isNavigationTechnicalError(e)) await discardWedgedPage()
    await failVerificationTask({
      taskId: task.id,
      workspaceId: task.workspaceId,
      userId: task.preferredUserId,
      workerId: AMAZON_AUTH_PRICE_FALLBACK_WORKER_ID,
      code: "PRICE_NOT_FOUND",
      message,
      preserveClaimedBySource: "SERVER_BROWSER_AUTH",
    }).catch(() => undefined)
    lastError = message
    return true
  } finally {
    currentTaskId = null
  }
}

async function processVerifySource(): Promise<boolean> {
  const cfg = loadAmazonVerificationConfig()
  if (!cfg.serverBrowserEnabled) {
    workerStatus = "PAUSED"
    pauseReason = "GLOBAL_SERVER_BROWSER_VERIFICATION_ENABLED=false"
    sessionGateOk = false
    return false
  }
  // Public worker owns normal production claims. Login may only process explicit
  // PRICE_MISSING auth exception rows in this mode.
  if (publicWorkerOwnsQueue()) {
    return await withDeadline(
      processAuthenticatedPriceFallback(),
      amazonBrowserTaskAttemptWallclockMs(),
      "AUTH_PRICE_FALLBACK_WATCHDOG"
    )
  }
  if (!loginWorkerClaimEnabled()) {
    workerStatus = "PAUSED"
    pauseReason = "STANDBY — public Amazon worker owns queue"
    sessionGateOk = false
    return false
  }
  const account = await getAmazonWorkerAccount()
  if (account.accountStatus === "PAUSED") {
    workerStatus = "PAUSED"
    pauseReason = account.lastError || "PAUSED"
    sessionGateOk = false
    return false
  }
  if (account.accountStatus === "CHALLENGE_REQUIRED") {
    workerStatus = "CHALLENGE_REQUIRED"
    pauseReason = account.lastError || "CHALLENGE_REQUIRED"
    sessionGateOk = false
    return false
  }

  if (circuit.isOpen()) {
    workerStatus = "THROTTLED"
    pauseReason = "Circuit breaker open after Amazon errors"
    lastError = pauseReason
    return false
  }

  // Session ready before claiming work (also wakes after Devam Et → READY).
  if (!sessionGateOk || account.accountStatus === "READY") {
    const ok = await bootstrapAmazonSession(
      account.accountStatus === "READY" ? "resume-ready" : "pre-claim"
    )
    if (!ok) return false
  }

  const claimed = await claimNextServerBrowserVerificationTask({
    workerId: AMAZON_BROWSER_WORKER_ID,
  })
  if (!claimed.task) {
    // Empty queue must NOT imply ACTIVE — keep verified session state as-is.
    if (
      workerStatus !== "CHALLENGE_REQUIRED" &&
      workerStatus !== "PAUSED" &&
      workerStatus !== "LOGIN_REQUIRED" &&
      workerStatus !== "LOGIN_FAILED" &&
      workerStatus !== "ERROR" &&
      workerStatus !== "THROTTLED"
    ) {
      workerStatus = sessionGateOk ? "ONLINE" : workerStatus
      if (sessionGateOk) pauseReason = null
    }
    return false
  }

  const task = claimed.task
  currentTaskId = task.id
  workerStatus = "ONLINE"
  const running = await markVerificationRunning({
    taskId: task.id,
    workspaceId: task.workspaceId,
    userId: task.preferredUserId,
    workerId: AMAZON_BROWSER_WORKER_ID,
  })
  if (!running) {
    currentTaskId = null
    return true
  }

  const activePage = await ensurePage()
  const attempt = async (): Promise<boolean> => {
    try {
      const liveSession = await detectAmazonSession(activePage)
      if (liveSession === "CHALLENGE_REQUIRED") {
        pauseWorker("CHALLENGE_REQUIRED", "Amazon CAPTCHA or challenge")
        await updateAmazonAccountStatus({
          accountStatus: "CHALLENGE_REQUIRED",
          sessionState: "CHALLENGE",
          lastError: "Amazon CAPTCHA or challenge",
        })
        await releaseClaimedTaskWithoutFail(task.id)
        return false
      }
      if (liveSession === "LOGIN_REQUIRED") {
        if (!(await applyAmazonSessionGate(activePage))) {
          await releaseClaimedTaskWithoutFail(task.id)
          return false
        }
      } else if (liveSession === "PAGE_NOT_FOUND") {
        sessionState = "ACTIVE"
      } else {
        sessionState = "ACTIVE"
        sessionGateOk = true
      }

      try {
        await activePage.goto(productUrl(task.asin), {
          waitUntil: "domcontentloaded",
          timeout: amazonBrowserGotoTimeoutMs(),
        })
      } catch (navErr) {
        if (isNavigationTechnicalError(navErr)) {
          const message = navErr instanceof Error ? navErr.message : String(navErr)
          await finalizeTechnicalFailure(
            { id: task.id, workspaceId: task.workspaceId, preferredUserId: task.preferredUserId, asin: task.asin, attemptCount: task.attemptCount },
            "WORKER_ERROR",
            message,
            "NAVIGATION_TIMEOUT"
          )
          return true
        }
        throw navErr
      }

      const readyState = await waitForProductOfferReady(activePage, 12000)
      if (readyState === "captcha") {
        pauseWorker("CHALLENGE_REQUIRED", "Amazon CAPTCHA")
        await updateAmazonAccountStatus({
          accountStatus: "CHALLENGE_REQUIRED",
          sessionState: "CHALLENGE",
          lastError: "Amazon CAPTCHA",
        })
        await releaseClaimedTaskWithoutFail(task.id)
        return false
      }

      const title = await activePage.title().catch(() => "")
      const body = await activePage
        .evaluate(() => String(document.body && document.body.innerText ? document.body.innerText.slice(0, 600) : ""))
        .catch(() => "")
      if (isAmazonSorryPage(title, body)) {
        const opened = circuit.recordFailure()
        if (opened) {
          workerStatus = "THROTTLED"
          pauseReason = "Amazon service errors tripped circuit breaker"
          lastError = pauseReason
        }
        await failVerificationTask({
          taskId: task.id,
          workspaceId: task.workspaceId,
          userId: task.preferredUserId,
          workerId: AMAZON_BROWSER_WORKER_ID,
          code: "AMAZON_SERVICE_ERROR",
          message: "Amazon page unavailable",
        })
        return true
      }

      if (readyState === "gone" || (await pageLooksLikeAmazonNotFound(activePage))) {
        await submitProductNotFoundResult(task, activePage.url())
        return true
      }

      const midSession = await detectAmazonSession(activePage)
      if (midSession === "CHALLENGE_REQUIRED") {
        pauseWorker("CHALLENGE_REQUIRED", "Amazon CAPTCHA or challenge")
        await updateAmazonAccountStatus({
          accountStatus: "CHALLENGE_REQUIRED",
          sessionState: "CHALLENGE",
          lastError: "Amazon CAPTCHA or challenge",
        })
        await releaseClaimedTaskWithoutFail(task.id)
        return false
      }
      if (midSession === "PAGE_NOT_FOUND") {
        await submitProductNotFoundResult(task, activePage.url())
        return true
      }
      if (midSession === "LOGIN_REQUIRED" && isAmazonSignInLocation(activePage.url(), title)) {
        if (!(await applyAmazonSessionGate(activePage))) {
          await releaseClaimedTaskWithoutFail(task.id)
          return false
        }
        // Session recovery only — single product navigation after login gate
        try {
          await activePage.goto(productUrl(task.asin), {
            waitUntil: "domcontentloaded",
            timeout: amazonBrowserGotoTimeoutMs(),
          })
        } catch (navErr) {
          if (isNavigationTechnicalError(navErr)) {
            const message = navErr instanceof Error ? navErr.message : String(navErr)
            await finalizeTechnicalFailure(
              { id: task.id, workspaceId: task.workspaceId, preferredUserId: task.preferredUserId, asin: task.asin, attemptCount: task.attemptCount },
              "WORKER_ERROR",
              message,
              "NAVIGATION_TIMEOUT"
            )
            return true
          }
          throw navErr
        }
        const afterLoginReady = await waitForProductOfferReady(activePage, 12000)
        if (afterLoginReady === "captcha") {
          pauseWorker("CHALLENGE_REQUIRED", "Amazon CAPTCHA")
          await updateAmazonAccountStatus({
            accountStatus: "CHALLENGE_REQUIRED",
            sessionState: "CHALLENGE",
            lastError: "Amazon CAPTCHA",
          })
          await releaseClaimedTaskWithoutFail(task.id)
          return false
        }
        if (afterLoginReady === "gone" || (await pageLooksLikeAmazonNotFound(activePage))) {
          await submitProductNotFoundResult(task, activePage.url())
          return true
        }
      }

      if (readyState === "timeout") {
        // Still attempt one same-page extract; classifier treats unreadables as non-destructive
      }

      const extracted = await extractAmazonVerification(activePage, task.asin)
      if (!extracted.ok) {
        if (extracted.errorCode === "CAPTCHA") {
          pauseWorker("CHALLENGE_REQUIRED", "Amazon CAPTCHA")
          await updateAmazonAccountStatus({
            accountStatus: "CHALLENGE_REQUIRED",
            sessionState: "CHALLENGE",
            lastError: "Amazon CAPTCHA",
          })
          await releaseClaimedTaskWithoutFail(task.id)
          return false
        }
        if (await pageLooksLikeAmazonNotFound(activePage)) {
          await submitProductNotFoundResult(task, activePage.url())
          return true
        }
        if (extracted.errorCode === "LOGIN_REQUIRED") {
          if (isAmazonSignInLocation(activePage.url(), await activePage.title().catch(() => ""))) {
            pauseWorker("LOGIN_REQUIRED", "Amazon login required")
            await updateAmazonAccountStatus({
              accountStatus: "LOGIN_REQUIRED",
              sessionState: "LOGIN_REQUIRED",
              lastError: "Amazon login required during verification",
            })
            await releaseClaimedTaskWithoutFail(task.id)
            return false
          }
        }
        await failVerificationTask({
          taskId: task.id,
          workspaceId: task.workspaceId,
          userId: task.preferredUserId,
          workerId: AMAZON_BROWSER_WORKER_ID,
          code: extracted.errorCode,
          message: extracted.errorCode,
        })
        if (extracted.errorCode === "EXTRACTOR_FAILED") circuit.recordFailure()
        return true
      }

      const data = extracted.data
      const signals = evaluateOfferPrimeFbaSignals(data)
      const isPrime = signals.isPrime
      const isFba = signals.isFba

      await submitVerificationResult({
        taskId: task.id,
        workspaceId: task.workspaceId,
        userId: task.preferredUserId,
        workerId: AMAZON_BROWSER_WORKER_ID,
        payload: {
          asin: data.asin ?? task.asin,
          requestedAsin: data.requestedAsin ?? task.asin,
          finalAsin: data.finalAsin ?? data.asin ?? undefined,
          displayedPrice: data.displayedPrice,
          currency: data.currency,
          condition: data.condition,
          shipsFrom: data.shipsFrom,
          soldBy: data.soldBy,
          isPrime,
          isFba,
          hasAddToCart: data.hasAddToCart,
          hasBuyNow: data.hasBuyNow,
          availabilityText: data.availabilityText,
          stockStatus: data.stockStatus,
          pageUrl: data.pageUrl,
          captcha: data.captcha,
          pageUnavailable: data.pageUnavailable,
          redirected: data.redirected,
          metadata: {
            verificationSource: "SERVER_BROWSER",
            taskType: "VERIFY_SOURCE",
            verifiedAt: new Date().toISOString(),
            decisionOrder: "PAGE>ASIN>STOCK>PRIME>SHIPS_FROM_AMAZON>IN_STOCK",
            shipsFromAmazon: signals.shipsFromAmazon,
            soldByAmazon: signals.soldByAmazon,
            purchasable: signals.purchasable,
            offerPageHealthy: signals.offerPageHealthy,
            domReadPass: 1,
            pageReady: readyState,
          },
        },
      })
      circuit.recordSuccess()
      lastSuccessAt = new Date()
      lastError = null
      await updateAmazonAccountStatus({
        accountStatus: "ONLINE",
        sessionState: "ACTIVE",
        lastError: null,
        lastSuccessfulVerificationAt: lastSuccessAt,
      })
      workerStatus = "ONLINE"
      sessionState = "ACTIVE"
      return true
    } catch (e) {
      const message = e instanceof Error ? e.message.slice(0, 200) : "verification failed"
      // Technical / navigation / browser faults: never probe the wedged page.
      if (isNavigationTechnicalError(e)) {
        await finalizeTechnicalFailure(
          { id: task.id, workspaceId: task.workspaceId, preferredUserId: task.preferredUserId, asin: task.asin, attemptCount: task.attemptCount },
          "WORKER_ERROR",
          message,
          /TASK_ATTEMPT_WATCHDOG/i.test(message) ? "TASK_ATTEMPT_WATCHDOG" : "NAVIGATION_TIMEOUT"
        )
        return true
      }
      // Non-navigation errors: still avoid unbounded page probes.
      lastError = message
      await finalizeTechnicalFailure(
        { id: task.id, workspaceId: task.workspaceId, preferredUserId: task.preferredUserId, asin: task.asin, attemptCount: task.attemptCount },
        "WORKER_ERROR",
        message,
        "WORKER_ERROR"
      )
      return true
    } finally {
      currentTaskId = null
    }
  }

  try {
    return await withDeadline(
      attempt(),
      amazonBrowserTaskAttemptWallclockMs(),
      "TASK_ATTEMPT_WATCHDOG"
    )
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    if (/TASK_ATTEMPT_WATCHDOG/i.test(message) || isNavigationTechnicalError(e)) {
      await finalizeTechnicalFailure(
        { id: task.id, workspaceId: task.workspaceId, preferredUserId: task.preferredUserId, asin: task.asin, attemptCount: task.attemptCount },
        "WORKER_ERROR",
        message,
        "TASK_ATTEMPT_WATCHDOG"
      )
      return true
    }
    throw e
  }
}

export async function startAmazonBrowserWorkerLoop(): Promise<void> {
  stopping = false
  workerStatus = "STARTING"
  sessionGateOk = false
  sessionState = "UNKNOWN"

  const beat = setInterval(() => {
    void heartbeat()
  }, amazonBrowserHeartbeatMs())

  // Start expired-RUNNING recovery before session bootstrap so a hung
  // login/bootstrap cannot leave lease-expired RUNNING tasks forever.
  const expiredWatch = setInterval(() => {
    void recoverExpiredRunningServerBrowserTasks({
      workerId: AMAZON_BROWSER_WORKER_ID,
      limit: 20,
    })
      .then(result => {
        if (result.recovered > 0) {
          if (currentTaskId != null && result.taskIds.includes(currentTaskId)) {
            currentTaskId = null
            lastError = "EXPIRED_RUNNING_RECOVERED"
          }
          void heartbeat()
        }
      })
      .catch(e => {
        console.error(
          `[amazon-browser-worker] expired-RUNNING watchdog error:`,
          e instanceof Error ? e.message : e
        )
      })
  }, amazonBrowserExpiredRunningWatchdogMs())

  const authExpiredWatch = setInterval(() => {
    void recoverExpiredRunningAuthenticatedPriceTasks({
      workerId: AMAZON_AUTH_PRICE_FALLBACK_WORKER_ID,
      limit: 20,
    }).catch(e => {
      console.error(
        `[amazon-auth-price-worker] expired-RUNNING watchdog error:`,
        e instanceof Error ? e.message : e
      )
    })
  }, amazonBrowserExpiredRunningWatchdogMs())

  await recoverExpiredRunningServerBrowserTasks({
    workerId: AMAZON_BROWSER_WORKER_ID,
    limit: 50,
  }).catch(e => {
    console.error(
      `[amazon-browser-worker] boot expired-RUNNING recovery error:`,
      e instanceof Error ? e.message : e
    )
  })

  await recoverExpiredRunningAuthenticatedPriceTasks({
    workerId: AMAZON_AUTH_PRICE_FALLBACK_WORKER_ID,
    limit: 50,
  }).catch(e => {
    console.error(
      `[amazon-auth-price-worker] boot expired-RUNNING recovery error:`,
      e instanceof Error ? e.message : e
    )
  })

  const bootAccount = await getAmazonWorkerAccount()
  if (bootAccount.accountStatus === "PAUSED") {
    pauseWorker("PAUSED", bootAccount.lastError || "PAUSED")
  } else if (bootAccount.accountStatus === "CHALLENGE_REQUIRED") {
    pauseWorker("CHALLENGE_REQUIRED", "Amazon CAPTCHA or challenge")
  } else if (
    bootAccount.accountStatus === "UNCONFIGURED" ||
    !bootAccount.email ||
    !bootAccount.passwordEncrypted
  ) {
    workerStatus = "ONLINE"
    sessionState = "LOGIN_REQUIRED"
    pauseReason = "Amazon credentials not configured"
    lastError = pauseReason
  } else {
    // Proactive bootstrap even when queue_pending = 0
    await bootstrapAmazonSession("boot")
  }

  await heartbeat()

  while (!stopping) {
    try {
      const worked = await processVerifySource()
      await heartbeat()
      await sleep(worked ? amazonBrowserPaceMs() : 2500)
    } catch (e) {
      lastError = e instanceof Error ? e.message.slice(0, 200) : "loop error"
      workerStatus = "ERROR"
      sessionGateOk = false
      await heartbeat()
      await sleep(5000)
    }
  }
  clearInterval(beat)
  clearInterval(expiredWatch)
  clearInterval(authExpiredWatch)
}

export async function stopAmazonBrowserWorkerLoop(): Promise<void> {
  stopping = true
  browserRunning = false
  workerStatus = "OFFLINE"
  await heartbeat().catch(() => undefined)
  if (context) {
    await context.close().catch(() => undefined)
    context = null
    page = null
  }
}

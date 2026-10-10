import fs from "fs"
import path from "path"
import { fetchGlobalKeepaProducts, type GlobalKeepaProductFetchResult } from "../globalKeepa/globalKeepaProductClient"
import { createHash } from "crypto"
import { extractKeepaMonitoredSnapshot, missingKeepaMonitoredSnapshot } from "./keepaMonitoredSnapshot"
import { evaluateKeepaRead } from "./keepaSnapshotDiff"
import type { KeepaMonitoredSnapshot } from "./keepaMonitoredSnapshot"
import { evidenceFingerprint, snapshotToKeepaEvidence } from "./keepaEvidencePolicy"
import {
  applySyncEvent,
  candidateTelemetryCounts,
  countDueAsins,
  dueAsins,
  keepaSampleWindowTotals,
  keepaScanAllowed,
  listPendingAckIds,
  loadSnapshot,
  markAckAttempt,
  markAckedRemote,
  markScanned,
  openKeepaLocalDb,
  recordKeepaTokenSample,
  updateKeepaTokenSampleParsed,
  registryTelemetryCounts,
  saveSnapshot,
  setWorkerState,
  getWorkerState,
  enqueueObservationOutbox,
  listPendingObservationOutbox,
  markObservationAttempt,
  markObservationDelivered,
  localReconcileManifest,
  pendingAckCount,
  bootstrapPhase,
  pendingObservationCount,
  deliveredObservationCount,
  nextDueAtMs,
} from "./keepaLocalDb"
import { acquireCollectorProcessLock, CollectorLockError } from "./keepaCollectorLock"
import { runCollectorBootstrap, type CollectorHttp } from "./keepaCollectorBootstrap"
import { KEEPA_COLLECTOR_BOOTSTRAP_PAGE_SIZE_DEFAULT, KEEPA_COLLECTOR_CATCHUP_MAX_ROUNDS_DEFAULT, KEEPA_COLLECTOR_VERSION } from "./keepaCollectorVersion"
import {
  KEEPA_MAX_BATCH,
  KEEPA_SOLD_CADENCE_HOURS,
  KEEPA_STANDARD_CADENCE_HOURS,
  KEEPA_TOKEN_COST_PER_ASIN_MAX,
  KEEPA_TOKEN_RESERVE_DEFAULT,
  keepaCapacityStats,
  keepaScanMode,
  networkBackoffMs,
  nextDaemonSleepMs,
  planKeepaBatch,
  projectKeepaTokenState,
  refillWaitMs,
  spendableTokens,
  tokenCostExceeded,
  KEEPA_MAX_IDLE_SLEEP_MS,
  dueWorkStallAdvance,
} from "./keepaTokenScheduler"
import { catchUpLifecycleThenReconcile, type EventSyncHooks } from "./keepaCollectorEventSync"
import { runCollectorRepair } from "./keepaCollectorRepair"
import {
  createAutoRepairState,
  reconcileThenMaybeAutoRepair,
  KEEPA_AUTO_REPAIR_BACKOFF_MS,
} from "./keepaCollectorAutoRepair"
import { defaultCollectorId, stampTelemetry, telemetryContainsForbidden } from "./keepaCollectorTelemetry"

export type KeepaCollectorRunMode = "bootstrap-only" | "repair-only" | "once" | "daemon"

export type KeepaCollectorConfig = {
  apiBase: string
  workerToken: string
  keepaApiKey: string
  dbPath: string
  batchSize: number
  pollMs: number
  soldCadenceHours: number
  standardCadenceHours: number
  verifyRetryCooldownMs: number
  enabled: boolean
  runMode: KeepaCollectorRunMode | null
  maxBatches: number
  bootstrapPageSize: number
  keepaEnabled: boolean
  catchUpMaxRounds: number
  tokenReserve: number
  tokenCostPerAsinMax: number
  heartbeatMs: number
  collectorId: string
  batchGapMs: number
}

export type KeepaFetchFn = (input: {
  apiKey: string
  domain: number
  asins: string[]
  timeoutMs: number
}) => Promise<GlobalKeepaProductFetchResult>

export function loadKeepaCollectorConfig(env = process.env): KeepaCollectorConfig {
  const int = (name: string, fallback: number) => {
    const n = parseInt(env[name] ?? "", 10)
    return Number.isFinite(n) && n > 0 ? n : fallback
  }
  const modeRaw = String(env.KEEPA_COLLECTOR_RUN_MODE ?? "").trim()
  const runMode: KeepaCollectorRunMode | null =
    modeRaw === "bootstrap-only" || modeRaw === "repair-only" || modeRaw === "once" || modeRaw === "daemon"
      ? modeRaw
      : null
  return {
    apiBase: (env.LISTJETGO_API_BASE ?? "").replace(/\/$/, ""),
    workerToken: (env.KEEPA_COLLECTOR_WORKER_TOKEN ?? "").trim(),
    keepaApiKey: (env.KEEPA_API_KEY ?? "").trim(),
    dbPath: env.KEEPA_LOCAL_DB_PATH ?? "/var/lib/listjetgo-scan/keepa/keepa-worker.sqlite",
    batchSize: Math.min(KEEPA_MAX_BATCH, int("KEEPA_COLLECTOR_BATCH_SIZE", KEEPA_MAX_BATCH)),
    pollMs: int("KEEPA_COLLECTOR_POLL_MS", 15000),
    soldCadenceHours: KEEPA_SOLD_CADENCE_HOURS,
    standardCadenceHours: KEEPA_STANDARD_CADENCE_HOURS,
    verifyRetryCooldownMs: int("KEEPA_VERIFY_RETRY_COOLDOWN_MS", 6 * 3600_000),
    enabled: (env.KEEPA_COLLECTOR_ENABLED ?? "false").toLowerCase() === "true",
    runMode,
    maxBatches: int("KEEPA_COLLECTOR_MAX_BATCHES", 1),
    bootstrapPageSize: Math.min(200, int("KEEPA_COLLECTOR_BOOTSTRAP_PAGE_SIZE", KEEPA_COLLECTOR_BOOTSTRAP_PAGE_SIZE_DEFAULT)),
    keepaEnabled: (env.KEEPA_ENABLED ?? "false").toLowerCase() === "true",
    catchUpMaxRounds: int("KEEPA_COLLECTOR_CATCHUP_MAX_ROUNDS", KEEPA_COLLECTOR_CATCHUP_MAX_ROUNDS_DEFAULT),
    tokenReserve: int("KEEPA_TOKEN_RESERVE", KEEPA_TOKEN_RESERVE_DEFAULT),
    tokenCostPerAsinMax: KEEPA_TOKEN_COST_PER_ASIN_MAX,
    heartbeatMs: int("KEEPA_COLLECTOR_HEARTBEAT_MS", 15000),
    collectorId: defaultCollectorId(env),
    batchGapMs: Math.min(5000, Math.max(250, int("KEEPA_COLLECTOR_BATCH_GAP_MS", 800))),
  }
}

export function sanitizeErr(message: string, token: string, key: string): string {
  let m = message
  if (token) m = m.split(token).join("[REDACTED]")
  if (key) m = m.split(key).join("[REDACTED]")
  return m.slice(0, 200)
}

export const KEEPA_COLLECTOR_HTTP_TIMEOUT_MS = 20_000

export function createCollectorHttp(cfg: KeepaCollectorConfig, fetchImpl: typeof fetch = fetch): CollectorHttp {
  const call = async (method: string, pathName: string, body?: Record<string, unknown>) => {
    try {
      const res = await fetchImpl(`${cfg.apiBase}${pathName}`, {
        method,
        headers: {
          Authorization: `Bearer ${cfg.workerToken}`,
          "Content-Type": "application/json",
          "X-Request-Id": `kc-${Date.now()}`,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(KEEPA_COLLECTOR_HTTP_TIMEOUT_MS),
      })
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
      return { status: res.status, json }
    } catch (e) {
      const name = e instanceof Error ? e.name : ""
      const msg = e instanceof Error ? e.message : String(e)
      if (name === "TimeoutError" || name === "AbortError" || /aborted|timeout/i.test(msg)) {
        console.error("[keepa-collector] COLLECTOR_HTTP_TIMEOUT", pathName)
        throw new Error("COLLECTOR_HTTP_TIMEOUT")
      }
      throw e
    }
  }
  return {
    getJson: pathName => call("GET", pathName),
    postJson: (pathName, body) => call("POST", pathName, body),
  }
}

export async function ingestEvents(cfg: KeepaCollectorConfig, db: ReturnType<typeof openKeepaLocalDb>, http?: CollectorHttp): Promise<number> {
  const client = http ?? createCollectorHttp(cfg)
  const res = await client.getJson("/internal/keepa-collector/events?limit=100")
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`)
  const events = Array.isArray(res.json.events) ? res.json.events : []
  for (const raw of events) {
    const ev = raw as Record<string, unknown>
    const eventId = String(ev.eventId ?? "")
    const payload = (ev.payload ?? {}) as Record<string, unknown>
    applySyncEvent(db, {
      eventId,
      asin: String(ev.asin ?? ""),
      eventType: String(ev.eventType ?? ""),
      sourceVersion: Number(ev.sourceVersion) || 0,
      payload: {
        activeConsumerCount: Number(payload.activeConsumerCount),
        status: String(payload.status ?? "ACTIVE"),
        priority: String(payload.priority ?? "STANDARD"),
        cadenceHours: Number(payload.cadenceHours) || cfg.standardCadenceHours,
      },
      nowMs: Date.now(),
    })
  }
  const pending = listPendingAckIds(db)
  for (const eventId of pending) {
    const ack = await client.postJson("/internal/keepa-collector/ack", { eventIds: [eventId] })
    if (ack.status === 401 || ack.status === 403) {
      markAckAttempt(db, eventId, Date.now(), `HTTP_${ack.status}`)
      throw new Error(`ACK_UNAUTHORIZED_${ack.status}`)
    }
    if (ack.status !== 200 || ack.json.ok !== true) {
      markAckAttempt(db, eventId, Date.now(), `HTTP_${ack.status}`)
      throw new Error(`ACK_HTTP_${ack.status}`)
    }
    markAckedRemote(db, eventId, Date.now())
  }
  return pending.length
}

export async function flushKeepaObservationOutbox(
  db: ReturnType<typeof openKeepaLocalDb>,
  http?: CollectorHttp,
  nowMs = Date.now()
): Promise<{ delivered: number; failClosed: boolean }> {
  if (!http) return { delivered: 0, failClosed: false }
  if (getWorkerState(db, "keepa_fail_closed")) return { delivered: 0, failClosed: true }
  const pending = listPendingObservationOutbox(db, nowMs)
  let delivered = 0
  for (const row of pending) {
    try {
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>
      const res = await http.postJson("/internal/keepa-collector/observations", payload)
      if (res.status === 401 || res.status === 403) {
        markObservationAttempt(db, row.fingerprint, nowMs, `HTTP_${res.status}`)
        setWorkerState(db, "keepa_fail_closed", `OBSERVATION_HTTP_${res.status}`)
        setWorkerState(db, "last_error_code", `OBSERVATION_HTTP_${res.status}`)
        return { delivered, failClosed: true }
      }
      if (res.status !== 200 || res.json.ok !== true) {
        markObservationAttempt(db, row.fingerprint, nowMs, `HTTP_${res.status}`)
        continue
      }
      markObservationDelivered(db, row.fingerprint, nowMs)
      delivered++
    } catch {
      markObservationAttempt(db, row.fingerprint, nowMs, "NETWORK")
    }
  }
  return { delivered, failClosed: false }
}

function observationOutboxRecord(requestedAsin: string, snapshot: KeepaMonitoredSnapshot, nowMs: number): {
  fingerprint: string
  payloadJson: string
} {
  const evidence = snapshotToKeepaEvidence(requestedAsin, snapshot)
  const observationFingerprint = evidenceFingerprint(evidence)
  const payload = {
    requestedAsin: evidence.requestedAsin,
    returnedAsin: evidence.returnedAsin,
    observedAt: new Date(nowMs).toISOString(),
    observationFingerprint,
    priceEvidence: {
      amazonCents: evidence.amazonCents,
      newCents: evidence.newCents,
      buyBoxCents: evidence.buyBoxCents,
      primeExclusiveCents: evidence.primeExclusiveCents,
    },
    availability: evidence.availability,
    buyBoxIsPrimeExclusive: evidence.buyBoxIsPrimeExclusive,
    newFbaCount: evidence.newFbaCount,
    newFbmCount: evidence.newFbmCount,
    requestedAsinPresent: evidence.requestedAsinPresent,
    returnedAsinMismatch: evidence.returnedAsinMismatch,
    parentAsin: evidence.parentAsin,
    variationAsinsFingerprint: evidence.variationAsinsFingerprint,
    productUnavailable: evidence.productUnavailable,
  }
  const fingerprint = createHash("sha256")
    .update(`${evidence.requestedAsin}|${nowMs}|${observationFingerprint}`)
    .digest("hex")
  return { fingerprint, payloadJson: JSON.stringify(payload) }
}

const inFlightAsins = new Set<string>()

function emptyScan(partial: Partial<ScanDueResult> = {}): ScanDueResult {
  return {
    scanned: 0,
    candidates: 0,
    keepaCalls: 0,
    skipped: null,
    waitMs: 0,
    stopKeepa: false,
    requested: 0,
    continueDrain: false,
    spendable: 0,
    dueRemaining: 0,
    ...partial,
  }
}

export type ScanDueResult = {
  scanned: number
  candidates: number
  keepaCalls: number
  skipped: string | null
  waitMs: number
  stopKeepa: boolean
  requested: number
  continueDrain: boolean
  spendable: number
  dueRemaining: number
}

export function buildCollectorTelemetryPayload(
  cfg: KeepaCollectorConfig,
  db: ReturnType<typeof openKeepaLocalDb>,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  const nowMs = Date.now()
  const registry = registryTelemetryCounts(db)
  const due = countDueAsins(db, nowMs)
  const cand = candidateTelemetryCounts(db)
  const windows = keepaSampleWindowTotals(db, nowMs)
  const local = localReconcileManifest(db)
  const tokensLeft = Number(getWorkerState(db, "last_tokens_left") ?? "")
  const refillRate = Number(getWorkerState(db, "last_refill_rate") ?? "")
  const refillIn = Number(getWorkerState(db, "last_refill_in") ?? "")
  const consumed = Number(getWorkerState(db, "last_tokens_consumed") ?? "")
  const reduction = Number(getWorkerState(db, "last_token_flow_reduction") ?? "")
  const cap = keepaCapacityStats({
    sold: registry.sold,
    standard: registry.standard,
    refillRate: Number.isFinite(refillRate) ? refillRate : 0,
    tokenFlowReduction: Number.isFinite(reduction) ? reduction : 0,
  })
  const spendable = spendableTokens(Number.isFinite(tokensLeft) ? tokensLeft : null, cfg.tokenReserve)
  const dueAtMs = nextDueAtMs(db, nowMs)
  const dueAt = extra.nextDueAt ?? (dueAtMs != null ? new Date(dueAtMs).toISOString() : null)
  const scanMode =
    extra.scanMode ??
    keepaScanMode({ dueCount: due.sold + due.standard, spendable })
  const stalled = scanMode === "STALLED" || extra.stallReason === "COLLECTOR_STALLED_DUE_WORK"
  const coverage = registry.active + registry.paused > 0
    ? Math.round((registry.snapshotted / Math.max(1, registry.active + registry.paused)) * 1000) / 10
    : 0
  const etaSec =
    cap.effectiveRefillRate > 0 ? Math.round((due.total / cap.effectiveRefillRate) * 60) : null
  return stampTelemetry(
    {
      ...extra,
      collectorId: cfg.collectorId,
      phase: bootstrapPhase(db),
      runMode: cfg.runMode,
      enabled: cfg.enabled,
      lastLoopAt: extra.lastLoopAt ?? new Date(nowMs).toISOString(),
      lastKeepaAt: getWorkerState(db, "last_keepa_at"),
      lastSuccessAt: getWorkerState(db, "last_success_at"),
      tokensLeft: Number.isFinite(tokensLeft) ? tokensLeft : null,
      refillRate: Number.isFinite(refillRate) ? refillRate : null,
      refillIn: Number.isFinite(refillIn) ? refillIn : null,
      tokensConsumed: Number.isFinite(consumed) ? consumed : null,
      tokenFlowReduction: Number.isFinite(reduction) ? reduction : null,
      estimatedBucketCapacity: cap.estimatedBucketCapacity,
      effectiveRefillRate: cap.effectiveRefillRate,
      registryActive: registry.active,
      registryPaused: registry.paused,
      registrySold: registry.sold,
      registryStandard: registry.standard,
      baselineCount: registry.snapshotted,
      baselineCoveragePct: coverage,
      dueSold: due.sold,
      dueStandard: due.standard,
      retryCount: Number(getWorkerState(db, "retry_count") ?? 0) || 0,
      backoffMs: Number(getWorkerState(db, "backoff_ms") ?? 0) || 0,
      candidatePending: cand.pending,
      candidateRetryable: cand.retryable,
      candidateNoBusinessChange: cand.noBusinessChange,
      candidateConfirmed: cand.confirmed,
      candidateConflict: cand.conflict,
      candidateTerminal: cand.terminal,
      ...windows,
      requested: Number(getWorkerState(db, "last_requested") ?? 0) || 0,
      returned: Number(getWorkerState(db, "last_returned") ?? 0) || 0,
      parsed: Number(getWorkerState(db, "last_parsed") ?? 0) || 0,
      errorCount: Number(getWorkerState(db, "error_count") ?? 0) || 0,
      http429: Number(getWorkerState(db, "http_429") ?? 0) || 0,
      http401: Number(getWorkerState(db, "http_401") ?? 0) || 0,
      http403: Number(getWorkerState(db, "http_403") ?? 0) || 0,
      http5xx: Number(getWorkerState(db, "http_5xx") ?? 0) || 0,
      oldestDueAgeSec: due.oldestDueAgeSec,
      queueEtaSec: etaSec,
      lastErrorCode: extra.lastErrorCode ?? getWorkerState(db, "last_error_code"),
      localReconcileCount: extra.localReconcileCount ?? local.uniqueAsins,
      localReconcileHash: extra.localReconcileHash ?? local.hash,
      keepaApiStatus:
        extra.keepaApiStatus ??
        (stalled ? "STALLED" : extra.syncState ?? getWorkerState(db, "keepa_api_status") ?? "idle"),
      pendingAck: extra.pendingAck ?? pendingAckCount(db),
      spendableTokens: extra.spendableTokens ?? spendable,
      scanMode,
      nextDueAt: dueAt,
      lastSchedulerDecisionAt: extra.lastSchedulerDecisionAt ?? new Date(nowMs).toISOString(),
      lastProgressAt: extra.lastProgressAt ?? getWorkerState(db, "last_success_at"),
      stallReason: extra.stallReason ?? null,
      observationOutboxPending: extra.observationOutboxPending ?? pendingObservationCount(db),
      observationOutboxDelivered: extra.observationOutboxDelivered ?? deliveredObservationCount(db),
      lastKeepaBatchSize: extra.lastKeepaBatchSize ?? (Number(getWorkerState(db, "last_requested") ?? 0) || 0),
    },
    { KEEPA_COLLECTOR_ID: cfg.collectorId }
  )
}

async function postCollectorTelemetry(
  cfg: KeepaCollectorConfig,
  db: ReturnType<typeof openKeepaLocalDb>,
  http: CollectorHttp,
  extra: Record<string, unknown> = {},
  force = false
): Promise<void> {
  try {
    const payload = buildCollectorTelemetryPayload(cfg, db, extra)
    if (telemetryContainsForbidden(payload)) return
    await http.postJson("/internal/keepa-collector/heartbeat", payload)
  } catch {
    /* telemetry must not break Keepa scan or SQLite */
  }
  void force
}

function readTokenSampledAtMs(db: ReturnType<typeof openKeepaLocalDb>, nowMs: number): number {
  const raw = Number(getWorkerState(db, "last_token_sampled_at") ?? "")
  if (Number.isFinite(raw) && raw > 0) return raw
  const iso = getWorkerState(db, "last_keepa_at")
  const parsed = iso ? Date.parse(iso) : NaN
  if (Number.isFinite(parsed) && parsed > 0) return parsed
  return nowMs
}

export async function scanDueAsins(
  cfg: KeepaCollectorConfig,
  db: ReturnType<typeof openKeepaLocalDb>,
  opts?: { keepaFetch?: KeepaFetchFn; nowMs?: number; http?: CollectorHttp; maxKeepaAttempts?: number; jitterMs?: number }
): Promise<ScanDueResult> {
  const nowMs = opts?.nowMs ?? Date.now()
  if (getWorkerState(db, "keepa_fail_closed")) {
    return emptyScan({ skipped: getWorkerState(db, "keepa_fail_closed"), stopKeepa: true })
  }
  const flushed = await flushKeepaObservationOutbox(db, opts?.http, nowMs)
  if (flushed.failClosed) {
    return emptyScan({ skipped: getWorkerState(db, "keepa_fail_closed"), stopKeepa: true })
  }
  const gate = keepaScanAllowed(db)
  if (!gate.allowed) return emptyScan({ skipped: gate.reason })
  if (!cfg.keepaEnabled) return emptyScan({ skipped: "KEEPA_DISABLED" })
  const dueMeta = countDueAsins(db, nowMs)
  const known = getWorkerState(db, "last_tokens_left") != null && getWorkerState(db, "last_tokens_left") !== ""
  const rawLeft = known ? Number(getWorkerState(db, "last_tokens_left")) : null
  const refillIn = Number(getWorkerState(db, "last_refill_in") ?? "")
  const refillRate = Number(getWorkerState(db, "last_refill_rate") ?? "")
  const projected = projectKeepaTokenState({
    sampledAtMs: readTokenSampledAtMs(db, nowMs),
    nowMs,
    tokensLeft: Number.isFinite(Number(rawLeft)) ? Number(rawLeft) : null,
    refillRate: Number.isFinite(refillRate) ? refillRate : null,
    refillInMs: Number.isFinite(refillIn) ? refillIn : null,
  })
  const tokensLeft = projected.tokensLeft
  const plan = planKeepaBatch({
    dueCount: dueMeta.total,
    tokensLeft: Number.isFinite(Number(tokensLeft)) ? Number(tokensLeft) : null,
    reserve: cfg.tokenReserve,
    maxBatch: cfg.batchSize,
    knownTelemetry: known,
    refillInMs: projected.refillInMs,
    pollMs: cfg.pollMs,
    jitterMs: opts?.jitterMs ?? 120,
  })
  if (plan.action === "idle") {
    return emptyScan({ skipped: "NO_DUE", spendable: plan.spendable, dueRemaining: 0 })
  }
  if (plan.action === "wait_refill") {
    return emptyScan({
      skipped: "TOKEN_WAIT",
      waitMs: plan.waitMs,
      spendable: 0,
      dueRemaining: dueMeta.total,
    })
  }
  const due = dueAsins(db, nowMs, plan.batch, [...inFlightAsins])
  if (due.length === 0) return emptyScan({ skipped: "NO_DUE", spendable: plan.spendable, dueRemaining: 0 })
  for (const row of due) inFlightAsins.add(row.asin)
  const fetchKeepa = opts?.keepaFetch ?? fetchGlobalKeepaProducts
  const maxAttempts = Math.max(1, Math.min(3, opts?.maxKeepaAttempts ?? 1))
  let fetched: GlobalKeepaProductFetchResult | null = null
  let keepaCalls = 0
  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      keepaCalls++
      fetched = await fetchKeepa({
        apiKey: cfg.keepaApiKey,
        domain: 1,
        asins: due.map(d => d.asin),
        timeoutMs: 25000,
      })
      setWorkerState(db, "last_keepa_at", new Date(nowMs).toISOString())
      if (fetched.ok === true) break
      if (fetched.code === "HTTP_401" || fetched.code === "HTTP_403") break
      if (fetched.code !== "HTTP_429" && fetched.code !== "HTTP_5XX" && fetched.code !== "NETWORK" && fetched.code !== "TIMEOUT") break
      if (attempt === maxAttempts) break
    }
    const requested = due.length
    const products = fetched && fetched.ok === true ? fetched.body.products ?? [] : fetched?.body?.products ?? []
    const returned = Array.isArray(products) ? products.length : 0
    const body = fetched && "body" in fetched ? fetched.body : null
    const httpStatus = fetched?.status ?? null
    const consumed = body?.tokensConsumed ?? null
    recordKeepaTokenSample(db, {
      collectedAt: nowMs,
      tokensLeft: body?.tokensLeft ?? null,
      refillRate: body?.refillRate ?? null,
      refillIn: body?.refillIn ?? null,
      tokensConsumed: consumed,
      tokenFlowReduction: body?.tokenFlowReduction ?? null,
      processingTimeInMs: body?.processingTimeInMs ?? (fetched && "durationMs" in fetched ? fetched.durationMs : null),
      httpStatus,
      requested,
      returned,
      parsed: 0,
    })
    if (body?.tokensLeft != null) {
      setWorkerState(db, "last_tokens_left", String(body.tokensLeft))
      setWorkerState(db, "last_token_sampled_at", String(nowMs))
    }
    if (body?.refillRate != null) setWorkerState(db, "last_refill_rate", String(body.refillRate))
    if (body?.refillIn != null) setWorkerState(db, "last_refill_in", String(body.refillIn))
    if (consumed != null) setWorkerState(db, "last_tokens_consumed", String(consumed))
    if (body?.tokenFlowReduction != null) setWorkerState(db, "last_token_flow_reduction", String(body.tokenFlowReduction))
    setWorkerState(db, "last_requested", String(requested))
    setWorkerState(db, "last_returned", String(returned))
    if (fetched && fetched.ok !== true) {
      const code = fetched.code
      setWorkerState(db, "last_error_code", code)
      setWorkerState(db, "keepa_api_status", code)
      if (code === "HTTP_401") setWorkerState(db, "http_401", String(Number(getWorkerState(db, "http_401") ?? 0) + 1))
      if (code === "HTTP_403") setWorkerState(db, "http_403", String(Number(getWorkerState(db, "http_403") ?? 0) + 1))
      if (code === "HTTP_429") setWorkerState(db, "http_429", String(Number(getWorkerState(db, "http_429") ?? 0) + 1))
      if (code === "HTTP_5XX" || code === "NETWORK" || code === "TIMEOUT") {
        setWorkerState(db, "http_5xx", String(Number(getWorkerState(db, "http_5xx") ?? 0) + 1))
      }
      if (code === "HTTP_401" || code === "HTTP_403") {
        setWorkerState(db, "keepa_fail_closed", code)
        return emptyScan({ keepaCalls, skipped: code, stopKeepa: true, requested })
      }
      if (code === "HTTP_429") {
        const waitMs = refillWaitMs({ refillInMs: body?.refillIn ?? null, attempt: 1, jitterMs: opts?.jitterMs ?? 200 })
        return emptyScan({ keepaCalls, skipped: "HTTP_429", waitMs, requested })
      }
      return emptyScan({ keepaCalls, skipped: code, waitMs: networkBackoffMs(1), requested })
    }
    if (!fetched || fetched.ok !== true || !fetched.body) {
      return emptyScan({ keepaCalls, skipped: "KEEPA_FETCH_FAILED", requested })
    }
    if (tokenCostExceeded(consumed, requested) || (consumed != null && consumed > requested * cfg.tokenCostPerAsinMax)) {
      setWorkerState(db, "keepa_fail_closed", "TOKEN_COST_EXCEEDED")
      setWorkerState(db, "last_error_code", "TOKEN_COST_EXCEEDED")
      return emptyScan({ keepaCalls, skipped: "TOKEN_COST_EXCEEDED", stopKeepa: true, requested })
    }
    let scanned = 0
    const candidates = 0
    let parsed = 0
    for (const row of due) {
      const responseProducts = fetched.body.products ?? []
      const product = responseProducts.find(p => p.asin?.toUpperCase() === row.asin)
      // A different returned ASIN is attributable only for a one-ASIN request. In a batch,
      // absence remains a strong signal but another row's product must not be misattributed.
      const soleReturnedAsin = due.length === 1 && responseProducts.length === 1 ? responseProducts[0]?.asin ?? null : null
      const extracted = extractKeepaMonitoredSnapshot(product ?? null)
      const snapshot = extracted
        ? { ...extracted, requestedAsin: row.asin, requestedAsinPresent: true, returnedAsinMismatch: extracted.returnedAsin !== row.asin }
        : missingKeepaMonitoredSnapshot({ requestedAsin: row.asin, returnedAsin: soleReturnedAsin })
      const prevRaw = loadSnapshot(db, row.asin)
      const previous: KeepaMonitoredSnapshot | null = prevRaw ? (JSON.parse(prevRaw.snapshot_json) as KeepaMonitoredSnapshot) : null
      const outcome = snapshot ? "OK" : "PARSE_FAILURE"
      const diff = evaluateKeepaRead({
        outcome: outcome as "OK" | "PARSE_FAILURE",
        snapshot,
        previous,
      })
      if (diff.kind === "ignored_error") continue
      parsed++
      try {
        db.exec("BEGIN")
        saveSnapshot(db, row.asin, diff.fingerprint, JSON.stringify(diff.snapshot), nowMs)
        const boxed = observationOutboxRecord(row.asin, diff.snapshot, nowMs)
        enqueueObservationOutbox(db, {
          fingerprint: boxed.fingerprint,
          asin: row.asin,
          payloadJson: boxed.payloadJson,
          nowMs,
        })
        markScanned(db, row.asin, nowMs, row.cadence_hours)
        db.exec("COMMIT")
      } catch (err) {
        try {
          db.exec("ROLLBACK")
        } catch {
          /* ignore */
        }
        throw err
      }
      scanned++
    }
    updateKeepaTokenSampleParsed(db, nowMs, parsed)
    const afterFlush = await flushKeepaObservationOutbox(db, opts?.http, nowMs)
    setWorkerState(db, "last_parsed", String(parsed))
    setWorkerState(db, "last_success_at", new Date(nowMs).toISOString())
    setWorkerState(db, "keepa_api_status", "ok")
    setWorkerState(db, "last_error_code", "")
    const tokensAfter = Number(fetched.body.tokensLeft)
    const spendable = spendableTokens(
      Number.isFinite(tokensAfter) ? tokensAfter : Number.isFinite(Number(tokensLeft)) ? Number(tokensLeft) : null,
      cfg.tokenReserve
    )
    const dueRemaining = countDueAsins(db, nowMs).total
    const continueDrain = !afterFlush.failClosed && dueRemaining > 0 && spendable > 0
    if (afterFlush.failClosed) {
      return emptyScan({
        scanned,
        candidates,
        keepaCalls,
        skipped: getWorkerState(db, "keepa_fail_closed"),
        waitMs: 0,
        stopKeepa: true,
        requested,
        spendable,
        dueRemaining,
      })
    }
    return {
      scanned,
      candidates,
      keepaCalls,
      skipped: null,
      waitMs: 0,
      stopKeepa: false,
      requested,
      continueDrain,
      spendable,
      dueRemaining,
    }
  } finally {
    for (const row of due) inFlightAsins.delete(row.asin)
  }
}

export async function runKeepaCollectorOnceBatches(
  cfg: KeepaCollectorConfig,
  db: ReturnType<typeof openKeepaLocalDb>,
  opts?: { keepaFetch?: KeepaFetchFn; http?: CollectorHttp }
): Promise<{ batches: number; scanned: number; keepaCalls: number }> {
  let batches = 0
  let scanned = 0
  let keepaCalls = 0
  const max = Math.max(1, cfg.maxBatches)
  for (let i = 0; i < max; i++) {
    const result = await scanDueAsins(cfg, db, opts)
    batches++
    scanned += result.scanned
    keepaCalls += result.keepaCalls
    if (result.stopKeepa || result.skipped === "NO_DUE" || result.skipped === "TOKEN_WAIT" || result.waitMs > 0) break
    if (!result.continueDrain) break
  }
  return { batches, scanned, keepaCalls }
}

function assertRunnable(cfg: KeepaCollectorConfig): void {
  if (!cfg.runMode) {
    throw new Error("KEEPA_COLLECTOR_RUN_MODE must be bootstrap-only|repair-only|once|daemon")
  }
  if (!cfg.apiBase || cfg.workerToken.length < 32) {
    throw new Error("LISTJETGO_API_BASE and KEEPA_COLLECTOR_WORKER_TOKEN (>=32) required")
  }
  if (cfg.runMode !== "bootstrap-only" && cfg.runMode !== "repair-only" && !cfg.keepaApiKey) {
    throw new Error("KEEPA_API_KEY required for once/daemon")
  }
}

export async function runKeepaCollector(opts?: {
  env?: NodeJS.ProcessEnv
  keepaFetch?: KeepaFetchFn
  http?: CollectorHttp
  db?: ReturnType<typeof openKeepaLocalDb>
  skipLock?: boolean
  eventSyncHooks?: EventSyncHooks
}): Promise<{ exitCode: number; mode: string | null; keepaCalls: number }> {
  delete process.env.DATABASE_URL
  delete process.env.EBAY_CLIENT_ID
  delete process.env.EBAY_CLIENT_SECRET
  delete process.env.EBAY_REFRESH_TOKEN
  const cfg = loadKeepaCollectorConfig(opts?.env ?? process.env)
  if (!cfg.enabled) {
    console.log("[keepa-collector] disabled (KEEPA_COLLECTOR_ENABLED!=true)")
    return { exitCode: 0, mode: cfg.runMode, keepaCalls: 0 }
  }
  try {
    assertRunnable(cfg)
  } catch (e) {
    console.error("[keepa-collector]", sanitizeErr(e instanceof Error ? e.message : String(e), cfg.workerToken, cfg.keepaApiKey))
    return { exitCode: 1, mode: cfg.runMode, keepaCalls: 0 }
  }
  let release = (): void => undefined
  if (!opts?.skipLock) {
    try {
      release = acquireCollectorProcessLock(cfg.dbPath).release
    } catch (e) {
      if (e instanceof CollectorLockError) {
        console.error("[keepa-collector] COLLECTOR_LOCK_HELD")
        return { exitCode: 1, mode: cfg.runMode, keepaCalls: 0 }
      }
      throw e
    }
  }
  try {
    if (!opts?.db) fs.mkdirSync(path.dirname(cfg.dbPath), { recursive: true })
    const db = opts?.db ?? openKeepaLocalDb(cfg.dbPath)
    const http = opts?.http ?? createCollectorHttp(cfg)
    console.log(`[keepa-collector] version ${KEEPA_COLLECTOR_VERSION} mode=${cfg.runMode}`)
    if (cfg.runMode === "bootstrap-only") {
      const boot = await runCollectorBootstrap({
        db,
        http,
        pageSize: cfg.bootstrapPageSize,
        hooks: { catchUpMaxRounds: cfg.catchUpMaxRounds },
      })
      if (boot.ok === false) {
        console.error("[keepa-collector] bootstrap failed:", boot.error)
        return { exitCode: 1, mode: cfg.runMode, keepaCalls: 0 }
      }
      return { exitCode: 0, mode: cfg.runMode, keepaCalls: 0 }
    }
    if (cfg.runMode === "repair-only") {
      await postCollectorTelemetry(cfg, db, http, { syncState: "REPAIRING_REGISTRY" }, true)
      try {
        const repair = await runCollectorRepair({
          db,
          http,
          pageSize: cfg.bootstrapPageSize,
          catchUpMaxRounds: cfg.catchUpMaxRounds,
          hooks: {
            ...opts?.eventSyncHooks,
            onProgress: async extra => {
              await postCollectorTelemetry(cfg, db, http, { syncState: "REPAIRING_REGISTRY", ...extra }, true)
            },
          },
        })
        await postCollectorTelemetry(
          cfg,
          db,
          http,
          {
            syncState: repair.ok ? "READY" : "SYNC_RECONCILE_MISMATCH",
            eventsPulled: repair.pulled,
            eventsApplied: repair.applied,
            eventsAcked: repair.acked,
            localReconcileCount: repair.localCount,
            localReconcileHash: repair.localHash,
            centralReconcileCount: repair.centralCount,
            lastErrorCode: repair.error,
            added: repair.merge.added,
            updated: repair.merge.updated,
            paused: repair.merge.paused,
            removed: repair.merge.removed,
            preserved: repair.merge.preserved,
            reconcileMatched: repair.ok,
          },
          true
        )
        if (!repair.ok) {
          console.error("[keepa-collector] repair failed:", repair.error)
          return { exitCode: 1, mode: cfg.runMode, keepaCalls: 0 }
        }
        return { exitCode: 0, mode: cfg.runMode, keepaCalls: 0 }
      } finally {
        await postCollectorTelemetry(cfg, db, http, { syncState: "IDLE" }, true)
      }
    }
    if (cfg.runMode === "once") {
      await postCollectorTelemetry(cfg, db, http, { syncState: "SYNCING_EVENTS" }, true)
      let keepaCalls = 0
      try {
        const sync = await catchUpLifecycleThenReconcile({
          db,
          http,
          catchUpMaxRounds: cfg.catchUpMaxRounds,
          hooks: opts?.eventSyncHooks,
        })
        await postCollectorTelemetry(
          cfg,
          db,
          http,
          {
            syncState: sync.keepaAllowed ? "READY" : "SYNC_RECONCILE_MISMATCH",
            eventsPulled: sync.pulled,
            eventsApplied: sync.applied,
            eventsNoop: sync.noop,
            localCommitted: sync.localCommitted,
            pendingAck: sync.pendingAck,
            eventsAcked: sync.acked,
            catchupRound: sync.catchupRound,
            reconcileMatched: sync.reconcileMatched,
            centralReconcileCount: sync.centralCount,
            lastEventCreatedAt: sync.lastEventCreatedAt,
            lastEventIdMasked: sync.lastEventIdMasked,
            lastErrorCode: sync.error,
          },
          true
        )
        if (!sync.keepaAllowed) {
          console.error("[keepa-collector] scan blocked:", sync.error)
          return { exitCode: 1, mode: cfg.runMode, keepaCalls: 0 }
        }
        const result = await runKeepaCollectorOnceBatches(cfg, db, { keepaFetch: opts?.keepaFetch, http })
        keepaCalls = result.keepaCalls
      } finally {
        await postCollectorTelemetry(cfg, db, http, { syncState: "IDLE" }, true)
      }
      return { exitCode: 0, mode: cfg.runMode, keepaCalls }
    }
    await runKeepaCollectorForever(cfg, db, http, opts?.keepaFetch)
    console.error("[keepa-collector] COLLECTOR_LOOP_RETURNED")
    return { exitCode: 1, mode: cfg.runMode, keepaCalls: 0 }
  } catch (e) {
    console.error("[keepa-collector]", sanitizeErr(e instanceof Error ? e.message : String(e), cfg.workerToken, cfg.keepaApiKey))
    return { exitCode: 1, mode: cfg.runMode, keepaCalls: 0 }
  } finally {
    release()
  }
}

export async function runKeepaCollectorForever(
  cfg?: KeepaCollectorConfig,
  db?: ReturnType<typeof openKeepaLocalDb>,
  http?: CollectorHttp,
  keepaFetch?: KeepaFetchFn
): Promise<void> {
  const loaded = cfg ?? loadKeepaCollectorConfig()
  if (loaded.runMode !== "daemon") {
    throw new Error("runKeepaCollectorForever is daemon-only")
  }
  if (!cfg) {
    const result = await runKeepaCollector()
    if (result.exitCode !== 0) process.exit(result.exitCode)
    return
  }
  const client = http ?? createCollectorHttp(loaded)
  const database = db ?? openKeepaLocalDb(loaded.dbPath)
  let lastHeartbeat = 0
  let keepaStopped = false
  let netAttempt = 0
  const autoRepair = createAutoRepairState()
  let stallLoops = 0
  let stallStartedAtMs: number | null = null
  const heartbeat = async () => {
    const now = Date.now()
    if (now - lastHeartbeat < loaded.heartbeatMs) return
    lastHeartbeat = now
    await postCollectorTelemetry(loaded, database, client)
  }
  const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, Math.max(0, ms)))
  const sleepChunked = async (ms: number) => {
    const cap = Math.min(Math.max(0, ms), KEEPA_MAX_IDLE_SLEEP_MS)
    const end = Date.now() + cap
    while (Date.now() < end) {
      await heartbeat()
      await sleep(Math.min(loaded.heartbeatMs, KEEPA_MAX_IDLE_SLEEP_MS, end - Date.now()))
    }
  }
  const exitIfStalled = async (input: {
    dueCount: number
    progressed: boolean
    tokenWait?: boolean
    stopKeepa?: boolean
    keepaAllowed?: boolean
    spendable?: number
    skipped?: string | null
  }) => {
    const next = dueWorkStallAdvance({
      previous: stallLoops,
      stallStartedAtMs,
      nowMs: Date.now(),
      dueCount: input.dueCount,
      progressed: input.progressed,
      tokenWait: input.tokenWait,
      stopKeepa: input.stopKeepa,
      keepaAllowed: input.keepaAllowed,
      spendable: input.spendable,
      skipped: input.skipped,
    })
    stallLoops = next.stallLoops
    stallStartedAtMs = next.stallStartedAtMs
    if (!next.shouldExit) return
    setWorkerState(database, "last_error_code", "COLLECTOR_STALLED_DUE_WORK")
    await postCollectorTelemetry(
      loaded,
      database,
      client,
      {
        scanMode: "STALLED",
        stallReason: "COLLECTOR_STALLED_DUE_WORK",
        lastErrorCode: "COLLECTOR_STALLED_DUE_WORK",
        keepaApiStatus: "STALLED",
      },
      true
    )
    console.error("[keepa-collector] COLLECTOR_STALLED_DUE_WORK")
    process.exit(1)
  }
  for (;;) {
    await heartbeat()
    try {
      if (!keepaStopped) {
        if (bootstrapPhase(database) !== "COMPLETE") {
          const boot = await runCollectorBootstrap({ db: database, http: client, pageSize: loaded.bootstrapPageSize })
          if (boot.ok === false) throw new Error(boot.error)
        }
        const loopNow = Date.now()
        const dueSnap = countDueAsins(database, loopNow)
        const dueAt = nextDueAtMs(database, loopNow)
        await postCollectorTelemetry(loaded, database, client, { syncState: "SYNCING_EVENTS" }, true)
        const turn = await reconcileThenMaybeAutoRepair({
          cfg: loaded,
          db: database,
          http: client,
          auto: autoRepair,
        })
        const repairMode = !turn.keepaAllowed || turn.repaired
        await postCollectorTelemetry(
          loaded,
          database,
          client,
          {
            syncState: turn.keepaAllowed ? "READY" : "SYNC_RECONCILE_MISMATCH",
            scanMode: repairMode && !turn.keepaAllowed ? "SYNC_REPAIR" : undefined,
            lastErrorCode: turn.error,
            reconcileMatched: turn.keepaAllowed,
            centralReconcileCount: turn.repair?.centralCount ?? null,
            added: turn.repair?.merge.added,
            updated: turn.repair?.merge.updated,
            paused: turn.repair?.merge.paused,
            removed: turn.repair?.merge.removed,
            preserved: turn.repair?.merge.preserved,
            nextDueAt: dueAt != null ? new Date(dueAt).toISOString() : null,
            lastLoopAt: new Date(loopNow).toISOString(),
          },
          true
        )
        if (turn.keepaStopped) {
          keepaStopped = true
          await sleepChunked(Math.min(loaded.heartbeatMs, KEEPA_MAX_IDLE_SLEEP_MS))
          continue
        }
        if (!turn.keepaAllowed) {
          keepaStopped = turn.error === "ACK_UNAUTHORIZED" || turn.error === "TOKEN_COST_EXCEEDED"
          const wait =
            turn.waitMs > 0 ? turn.waitMs : Math.min(loaded.pollMs, KEEPA_AUTO_REPAIR_BACKOFF_MS)
          await exitIfStalled({
            dueCount: dueSnap.total,
            progressed: false,
            stopKeepa: keepaStopped,
            keepaAllowed: false,
          })
          await sleepChunked(Math.min(Math.max(wait, 0), KEEPA_MAX_IDLE_SLEEP_MS))
          continue
        }
        let drainSafety = 0
        for (;;) {
          const result = await scanDueAsins(loaded, database, { keepaFetch, http: client, jitterMs: 150 })
          if (result.stopKeepa) keepaStopped = true
          setWorkerState(database, "backoff_ms", String(result.waitMs || 0))
          if (result.skipped === "HTTP_5XX" || result.skipped === "NETWORK" || result.skipped === "TIMEOUT") {
            netAttempt++
            await sleepChunked(networkBackoffMs(netAttempt))
            break
          }
          netAttempt = 0
          drainSafety++
          const afterDue = countDueAsins(database, Date.now())
          await exitIfStalled({
            dueCount: afterDue.total,
            progressed: result.keepaCalls > 0 || result.scanned > 0,
            tokenWait: result.skipped === "TOKEN_WAIT",
            stopKeepa: result.stopKeepa,
            keepaAllowed: true,
            spendable: result.spendable,
            skipped: result.skipped,
          })
          const sleepFor = nextDaemonSleepMs({
            skipped: result.skipped,
            waitMs: result.waitMs,
            keepaCalls: result.keepaCalls,
            pollMs: loaded.pollMs,
            stopKeepa: result.stopKeepa,
            heartbeatMs: loaded.heartbeatMs,
            continueDrain: result.continueDrain && drainSafety < 200,
            batchGapMs: loaded.batchGapMs,
            nextDueAtMs: nextDueAtMs(database, Date.now()),
            nowMs: Date.now(),
          })
          if (result.continueDrain && !result.stopKeepa && drainSafety < 200) {
            await sleepChunked(loaded.batchGapMs)
            continue
          }
          if (sleepFor > 0) await sleepChunked(sleepFor)
          break
        }
        continue
      }
      await sleepChunked(loaded.heartbeatMs)
    } catch (e) {
      const msg = sanitizeErr(e instanceof Error ? e.message : String(e), loaded.workerToken, loaded.keepaApiKey)
      console.error("[keepa-collector]", msg)
      await sleepChunked(Math.min(networkBackoffMs(++netAttempt), KEEPA_MAX_IDLE_SLEEP_MS))
    }
  }
}

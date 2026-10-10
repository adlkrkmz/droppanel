import { execFileSync } from "node:child_process"
import { query } from "../../db/client"
import { collectServerResourceSnapshot } from "../amazonBrowserWorker/serverResourceMetrics"
import { loadKeepaConfig } from "../keepa/keepaClient"
import { AMAZON_SCAN_ACTIVE_CONSUMER_WHERE } from "./amazonScanPlanner"
import { loadAmazonScanConfig } from "./amazonScanConfig"
import { BENCHMARK_VALID_PER_MIN, SAFE_ROUTINE_PER_HOST, computeAmazonScanCapacityAdvice } from "./amazonScanCapacity"
import {
  classifyAmazonScanWorker,
  includeActivityRow,
  isOnlineAmazonScanWorker,
  isStaleAmazonScanWorker,
  mergeScraperTelemetry,
  parseHostTelemetry,
  sortAmazonScanWorkers,
} from "./amazonScanDashboardWorkers"
import { collectAmazonScanHostTelemetry } from "./amazonScanHostTelemetry"
import { keepaCollectorDashboardFromRow } from "./keepaCollectorDashboard"
import { loadAmazonSourceControl } from "./amazonSourceControlDashboard"
import { oxylabsCanaryUsage } from "../oxylabsVerify/oxylabsPlanUsage"
const CACHE_MS = 5000

let cache: { at: number; body: Record<string, unknown> } | null = null

function maskAsin(asin: string | null | undefined): string {
  const s = String(asin ?? "").toUpperCase()
  if (s.length < 6) return "••••"
  return `${s.slice(0, 2)}••••${s.slice(-2)}`
}

function n(v: unknown): number {
  const x = typeof v === "number" ? v : parseInt(String(v ?? "0"), 10)
  return Number.isFinite(x) ? x : 0
}

function f(v: unknown): number | null {
  if (v == null) return null
  const x = typeof v === "number" ? v : parseFloat(String(v))
  return Number.isFinite(x) ? x : null
}

function incompleteSql(alias?: string): string {
  const p = alias ? `${alias}.` : ""
  return `(COALESCE(${p}result_payload->>'captcha','false')='true'
    OR COALESCE(${p}result_payload->>'timeout','false')='true'
    OR COALESCE(${p}result_payload->>'uncertain','false')='true'
    OR COALESCE(${p}result_payload->'metadata'->>'publicStatus','')='AMAZON_INCOMPLETE')`
}

function pm2Snapshot(): { api: string; panel: string; publicWorker: string } {
  try {
    const out = execFileSync("pm2", ["jlist"], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 2500 })
    const apps = JSON.parse(out) as Array<{ name?: string; pm2_env?: { status?: string } }>
    const st = (name: string) => apps.find(a => a.name === name)?.pm2_env?.status ?? "unknown"
    return {
      api: st("listjetgo-api"),
      panel: st("listjetgo-panel"),
      publicWorker: st("listjetgo-amazon-public-worker-A"),
    }
  } catch {
    return { api: "unknown", panel: "unknown", publicWorker: "unknown" }
  }
}

async function buildDashboard(): Promise<Record<string, unknown>> {
  const scanCfg = loadAmazonScanConfig()
  const keepaCfg = loadKeepaConfig()
  const generatedAt = new Date().toISOString()

  const [
    hb,
    jobAgg,
    workerAgg,
    outbox,
    cadence,
    pool,
    reviews,
    events,
    dup,
    stale,
    health,
  ] = await Promise.all([
    query<{
      worker_id: string
      status: string
      last_heartbeat_at: Date
      browser_running: boolean
      current_job_id: string | null
      last_error: string | null
      host_telemetry: unknown
    }>(
      `SELECT worker_id, status, last_heartbeat_at, browser_running, current_job_id::text,
              left(COALESCE(last_error,''), 180) AS last_error, host_telemetry
       FROM amazon_scan_worker_heartbeat
       WHERE last_heartbeat_at >= NOW() - interval '24 hours'
         AND (
           worker_id ~ '^amazon-public-browser-worker-[A-Z][A-Z0-9]{0,2}$'
           OR worker_id ~ '^amazon-scan-confirm-[A-Z][A-Z0-9]{0,2}$'
         )`,
    ),
    query<{
      active_routine: string
      pending_claimable: string
      retryable_due: string
      retryable_future: string
      claimed: string
      running: string
      active_confirm: string
      oldest_pending_age_s: string | null
      measure_span_s: string | null
      c15: string
      c1h: string
      c24: string
      v15: string
      v1h: string
      v24: string
      inc24: string
      captcha24: string
      timeout24: string
      failed24: string
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE kind='ROUTINE' AND status IN ('PENDING','RETRYABLE','CLAIMED','RUNNING'))::text AS active_routine,
         COUNT(*) FILTER (WHERE kind='ROUTINE' AND status='PENDING')::text AS pending_claimable,
         COUNT(*) FILTER (WHERE kind='ROUTINE' AND status='RETRYABLE' AND available_at <= NOW())::text AS retryable_due,
         COUNT(*) FILTER (WHERE kind='ROUTINE' AND status='RETRYABLE' AND available_at > NOW())::text AS retryable_future,
         COUNT(*) FILTER (WHERE kind='ROUTINE' AND status='CLAIMED')::text AS claimed,
         COUNT(*) FILTER (WHERE kind='ROUTINE' AND status='RUNNING')::text AS running,
         COUNT(*) FILTER (WHERE kind='CONFIRM' AND status IN ('PENDING','RETRYABLE','CLAIMED','RUNNING'))::text AS active_confirm,
         EXTRACT(EPOCH FROM (NOW() - MIN(created_at) FILTER (WHERE kind='ROUTINE' AND status IN ('PENDING','RETRYABLE'))))::int::text AS oldest_pending_age_s,
         EXTRACT(EPOCH FROM (
           MAX(completed_at) FILTER (WHERE kind='ROUTINE' AND status='COMPLETED' AND completed_at >= NOW()-interval '15 minutes')
           - MIN(completed_at) FILTER (WHERE kind='ROUTINE' AND status='COMPLETED' AND completed_at >= NOW()-interval '15 minutes')
         ))::int::text AS measure_span_s,
         COUNT(*) FILTER (WHERE status='COMPLETED' AND completed_at >= NOW()-interval '15 minutes')::text AS c15,
         COUNT(*) FILTER (WHERE status='COMPLETED' AND completed_at >= NOW()-interval '1 hour')::text AS c1h,
         COUNT(*) FILTER (WHERE status='COMPLETED' AND completed_at >= NOW()-interval '24 hours')::text AS c24,
         COUNT(*) FILTER (WHERE kind='ROUTINE' AND status='COMPLETED' AND completed_at >= NOW()-interval '15 minutes' AND NOT ${incompleteSql()})::text AS v15,
         COUNT(*) FILTER (WHERE kind='ROUTINE' AND status='COMPLETED' AND completed_at >= NOW()-interval '1 hour' AND NOT ${incompleteSql()})::text AS v1h,
         COUNT(*) FILTER (WHERE kind='ROUTINE' AND status='COMPLETED' AND completed_at >= NOW()-interval '24 hours' AND NOT ${incompleteSql()})::text AS v24,
         COUNT(*) FILTER (WHERE status='COMPLETED' AND completed_at >= NOW()-interval '24 hours' AND ${incompleteSql()})::text AS inc24,
         COUNT(*) FILTER (WHERE COALESCE(result_payload->>'captcha','false')='true' AND COALESCE(completed_at, created_at) >= NOW()-interval '24 hours')::text AS captcha24,
         COUNT(*) FILTER (WHERE COALESCE(result_payload->>'timeout','false')='true' AND COALESCE(completed_at, created_at) >= NOW()-interval '24 hours')::text AS timeout24,
         COUNT(*) FILTER (WHERE status='FAILED' AND COALESCE(completed_at, updated_at) >= NOW()-interval '24 hours')::text AS failed24
       FROM amazon_scan_jobs`
    ),
    query<{
      worker_id: string
      c15: string
      v15: string
      c1h: string
      c24: string
      valid24: string
      inc24: string
      failed24: string
      avg_sec: string | null
      matched24: string
      conflict24: string
      stale24: string
    }>(
      `SELECT worker_id,
         COUNT(*) FILTER (WHERE status='COMPLETED' AND completed_at >= NOW()-interval '15 minutes')::text AS c15,
         COUNT(*) FILTER (WHERE kind='ROUTINE' AND status='COMPLETED' AND completed_at >= NOW()-interval '15 minutes' AND NOT ${incompleteSql()})::text AS v15,
         COUNT(*) FILTER (WHERE status='COMPLETED' AND completed_at >= NOW()-interval '1 hour')::text AS c1h,
         COUNT(*) FILTER (WHERE status='COMPLETED' AND completed_at >= NOW()-interval '24 hours')::text AS c24,
         COUNT(*) FILTER (WHERE status='COMPLETED' AND completed_at >= NOW()-interval '24 hours' AND NOT ${incompleteSql()})::text AS valid24,
         COUNT(*) FILTER (WHERE status='COMPLETED' AND completed_at >= NOW()-interval '24 hours' AND ${incompleteSql()})::text AS inc24,
         COUNT(*) FILTER (WHERE status='FAILED' AND COALESCE(completed_at, updated_at) >= NOW()-interval '24 hours')::text AS failed24,
         AVG(EXTRACT(EPOCH FROM (completed_at - COALESCE(claimed_at, started_at, created_at))))
           FILTER (WHERE status='COMPLETED' AND completed_at >= NOW()-interval '1 hour')::text AS avg_sec,
         COUNT(*) FILTER (WHERE kind='CONFIRM' AND status='COMPLETED' AND completed_at >= NOW()-interval '24 hours' AND NOT ${incompleteSql()})::text AS matched24,
         COUNT(*) FILTER (WHERE COALESCE(failure_code,'') IN ('CONFIRM_CONFLICT') OR COALESCE(failure_message,'') LIKE '%CONFIRM_CONFLICT%')::text AS conflict24,
         COUNT(*) FILTER (WHERE COALESCE(failure_code,'') IN ('CONFIRM_PARENT_STALE','CONFIRM_RESULT_STALE') OR COALESCE(failure_message,'') LIKE '%STALE%')::text AS stale24
       FROM amazon_scan_jobs
       WHERE (
           worker_id ~ '^amazon-public-browser-worker-[A-Z][A-Z0-9]{0,2}$'
           OR worker_id ~ '^amazon-scan-confirm-[A-Z][A-Z0-9]{0,2}$'
         )
         AND COALESCE(completed_at, updated_at) >= NOW()-interval '24 hours'
       GROUP BY worker_id`
    ),
    query<{ status: string; n: string }>(
      `SELECT status, COUNT(*)::text AS n FROM amazon_scan_apply_outbox GROUP BY status`
    ),
    query<{ oldest_due_lag_s: string | null; due_now: string }>(
      `SELECT
         EXTRACT(EPOCH FROM (NOW() - MIN(next_check_at) FILTER (WHERE next_check_at < NOW())))::int::text AS oldest_due_lag_s,
         COUNT(*) FILTER (WHERE next_check_at IS NULL OR next_check_at <= NOW())::text AS due_now
       FROM amazon_scan_cadence`
    ),
    query<{ total: string; sold: string; other: string }>(
      `SELECT COUNT(*)::text AS total,
              COUNT(*) FILTER (WHERE priority = 0)::text AS sold,
              COUNT(*) FILTER (WHERE priority <> 0)::text AS other
       FROM (
         SELECT g.id,
           MIN(CASE WHEN COALESCE(scs.total_sold,0)>0 OR COALESCE(scs.sold_30d,0)>0 THEN 0 ELSE 2 END) AS priority
         FROM global_asin_consumers c
         JOIN global_amazon_asins g ON g.id = c.global_asin_id
         JOIN store_catalog_state scs ON scs.id = c.catalog_state_id
         JOIN stores st ON st.id = c.store_id AND st.workspace_id = c.workspace_id
         WHERE ${AMAZON_SCAN_ACTIVE_CONSUMER_WHERE}
         GROUP BY g.id
       ) t`
    ),
    query<{ price24: string; stock24: string; fail24: string }>(
      `SELECT
         COUNT(*) FILTER (WHERE operation_type='PRICE_PROTECTION' AND COALESCE(actioned_at, detected_at) >= NOW()-interval '24 hours')::text AS price24,
         COUNT(*) FILTER (WHERE operation_type='STOCK_PROTECTION' AND COALESCE(actioned_at, detected_at) >= NOW()-interval '24 hours')::text AS stock24,
         COUNT(*) FILTER (WHERE mutation_attempted=true AND review_status='failed' AND COALESCE(actioned_at, detected_at) >= NOW()-interval '24 hours')::text AS fail24
       FROM stock_review_items
       WHERE verification_source='SERVER_BROWSER_PUBLIC'
         AND COALESCE(actioned_at, detected_at) >= NOW()-interval '24 hours'`
    ),
    query<{
      id: string
      kind: string
      status: string
      worker_id: string | null
      asin: string
      claimed_at: Date | null
      completed_at: Date | null
      created_at: Date
      failure_code: string | null
      captcha: boolean
      timeout: boolean
      incomplete: boolean
    }>(
      `SELECT id::text, kind, status, worker_id, asin, claimed_at, completed_at, created_at, failure_code,
              (COALESCE(result_payload->>'captcha','false')='true') AS captcha,
              (COALESCE(result_payload->>'timeout','false')='true') AS timeout,
              ${incompleteSql()} AS incomplete
       FROM amazon_scan_jobs
       WHERE COALESCE(completed_at, claimed_at, created_at) >= NOW()-interval '24 hours'
       ORDER BY COALESCE(completed_at, claimed_at, created_at) DESC
       LIMIT 200`
    ),
    query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM (
         SELECT asin, kind FROM amazon_scan_jobs
         WHERE status IN ('PENDING','CLAIMED','RUNNING','WAITING_FOR_WORKER','RETRYABLE')
         GROUP BY asin, kind HAVING COUNT(*)>1
       ) d`
    ),
    query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM amazon_scan_jobs
       WHERE status IN ('CLAIMED','RUNNING') AND lease_expires_at IS NOT NULL AND lease_expires_at < NOW()`
    ),
    query("SELECT 1 AS ok"),
  ])

  const ja = jobAgg.rows[0]
  const activeRoutine = n(ja?.active_routine)
  const pendingClaimable = n(ja?.pending_claimable)
  const retryableDue = n(ja?.retryable_due)
  const retryableFuture = n(ja?.retryable_future)
  const claimedRoutine = n(ja?.claimed)
  const runningRoutine = n(ja?.running)
  const claimable = pendingClaimable + retryableDue
  const activeConfirm = n(ja?.active_confirm)
  const sold = n(pool.rows[0]?.sold)
  const other = n(pool.rows[0]?.other)
  const totalAsin = n(pool.rows[0]?.total)
  const requiredDaily = sold * 2 + other * 1
  const requiredPerHour = requiredDaily / 24
  const requiredPerMin = requiredDaily / 1440
  const createdVsDone = await query<{ created1h: string; done1h: string }>(
    `SELECT
       COUNT(*) FILTER (WHERE created_at >= NOW()-interval '1 hour' AND kind='ROUTINE')::text AS created1h,
       COUNT(*) FILTER (WHERE completed_at >= NOW()-interval '1 hour' AND kind='ROUTINE')::text AS done1h
     FROM amazon_scan_jobs`
  )
  const cr = n(createdVsDone.rows[0]?.created1h)
  const dn = n(createdVsDone.rows[0]?.done1h)
  const trend = cr > dn + 5 ? "buyuyor" : cr + 5 < dn ? "kuculuyor" : "stabil"
  const dueLag = n(cadence.rows[0]?.oldest_due_lag_s)

  const now = Date.now()
  const workers = sortAmazonScanWorkers(
    hb.rows.flatMap(row => {
      const cls = classifyAmazonScanWorker(row.worker_id)
      if (!cls) return []
      const ageS = row.last_heartbeat_at ? Math.round((now - new Date(row.last_heartbeat_at).getTime()) / 1000) : null
      if (isStaleAmazonScanWorker(ageS)) return []
      const stats = workerAgg.rows.find(r => r.worker_id === cls.workerId)
      const online = isOnlineAmazonScanWorker(row.status, ageS)
      const valid15m = n(stats?.v15)
      return [{
        slot: cls.slot,
        role: cls.role,
        workerId: cls.workerId,
        status: online ? "ONLINE" : "OFFLINE",
        heartbeatAgeSec: ageS,
        lastHeartbeatAt: row.last_heartbeat_at ? new Date(row.last_heartbeat_at).toISOString() : null,
        browserRunning: row.browser_running === true,
        currentJobId: row.current_job_id ? Number(row.current_job_id) : null,
        completed15m: n(stats?.c15),
        valid15m,
        ratePerMin15m: Math.round((valid15m / 15) * 1000) / 1000,
        completed1h: n(stats?.c1h),
        completed24h: n(stats?.c24),
        valid24h: n(stats?.valid24),
        incomplete24h: n(stats?.inc24),
        failed24h: n(stats?.failed24),
        matched24h: n(stats?.matched24),
        conflict24h: n(stats?.conflict24),
        stale24h: n(stats?.stale24),
        avgDurationSec: f(stats?.avg_sec),
        lastError: row.last_error || null,
        hostHostname: parseHostTelemetry(row.host_telemetry)?.hostname ?? null,
        inactive: !online,
      }]
    })
  )
  const onlineRoutine = workers.filter(w => w.role === "ROUTINE" && w.status === "ONLINE")
  const liveRoutinePerMin = onlineRoutine.reduce((s, w) => s + w.valid15m / 15, 0)
  const liveSampleCount = onlineRoutine.reduce((s, w) => s + w.valid15m, 0)
  const completed15mOnline = onlineRoutine.reduce((s, w) => s + w.completed15m, 0)
  const completedPerMin = completed15mOnline / 15
  const scraperEarly = mergeScraperTelemetry(hb.rows)
  const heartbeatHealthy = onlineRoutine.length > 0
  const advice = computeAmazonScanCapacityAdvice({
    claimable,
    maxOutstanding: scanCfg.plannerMaxOutstanding,
    measuredPerMin: liveRoutinePerMin,
    completedPerMin,
    requiredPerMin,
    measurementWindowSec: n(ja?.measure_span_s),
    sampleCount: liveSampleCount,
    heartbeatHealthy,
    telemetryReady: Boolean(scraperEarly?.hostname),
    perWorkerPerMin: onlineRoutine.length > 0 ? liveRoutinePerMin / onlineRoutine.length : 0,
    dueLagSec: dueLag,
    onlineRoutineCount: onlineRoutine.length,
  })
  const idle = advice.idle
  const recommendation = advice.recommendation
  const extraWorkers = advice.extraWorkersSuggested
  const liveCapacity = liveRoutinePerMin
  const utilizationPct = advice.measurementReady && liveCapacity > 0 ? (requiredPerMin / liveCapacity) * 100 : 0
  const remaining = liveCapacity - requiredPerMin
  const headroomPct = liveCapacity > 0 ? (remaining / liveCapacity) * 100 : 0
  const etaQueueMin = liveCapacity > 0 ? claimable / liveCapacity : null
  const etaPoolMin = liveCapacity > 0 ? requiredDaily / liveCapacity : null

  const noRoutineOnline = onlineRoutine.length === 0
  const captchaUp = n(ja?.captcha24) >= 5
  const critic =
    advice.utilizationSeverity === "critical" ||
    (advice.measurementReady && advice.queuePressure && liveCapacity + 0.0001 < requiredPerMin) ||
    dueLag > 3600 ||
    noRoutineOnline ||
    captchaUp

  const color =
    advice.idle
      ? "green"
      : !advice.measurementReady && !noRoutineOnline
        ? "yellow"
        : critic || advice.utilizationSeverity === "critical"
          ? "red"
          : advice.utilizationSeverity === "warning" || utilizationPct > 85
            ? "yellow"
            : "green"

  const outboxMap: Record<string, number> = {}
  for (const r of outbox.rows) outboxMap[r.status] = n(r.n)

  const activity = events.rows
    .filter(r => includeActivityRow(r.kind, r.worker_id))
    .slice(0, 50)
    .map(r => {
    let event = r.status
    if (r.status === "COMPLETED" && r.incomplete) event = "INCOMPLETE"
    if (r.captcha) event = "CAPTCHA"
    if (r.timeout) event = "TIMEOUT"
    if (r.kind === "CONFIRM" && r.status === "PENDING") event = "CONFIRM_OLUSTURULDU"
    if (r.kind === "ROUTINE" && r.status === "RUNNING") event = "ROUTINE_BASLADI"
    if (r.kind === "ROUTINE" && r.status === "COMPLETED" && !r.incomplete) event = "ROUTINE_TAMAMLANDI"
    if (r.kind === "CONFIRM" && r.status === "COMPLETED" && !r.incomplete) event = "CONFIRM_TAMAMLANDI"
    if (String(r.failure_code ?? "").includes("STALE")) event = "STALE"
    if (String(r.failure_code ?? "").includes("CONFLICT")) event = "CONFLICT"
    const cls = classifyAmazonScanWorker(r.worker_id)
    return {
      at: (r.completed_at || r.claimed_at || r.created_at).toString(),
      worker: cls ? `${cls.slot} (${cls.role})` : r.worker_id,
      event,
      asinMasked: maskAsin(r.asin),
      reason: r.failure_code,
    }
  })

  const host = collectServerResourceSnapshot()
  const localTel = collectAmazonScanHostTelemetry()
  const scraper = scraperEarly
  const pm2 = pm2Snapshot()

  let keepaSensor: Record<string, unknown> = {
    status: "OFFLINE",
    banner: "Kuyruk güncel — gereksiz tarama yapılmıyor",
    soldCadenceHours: 12,
    standardCadenceHours: 24,
    highTokensNotCritical: true,
  }
  try {
    const tel = await query<{ collector_id: string; hostname: string; payload: unknown; collected_at: Date }>(
      `SELECT collector_id, hostname, payload, collected_at
       FROM keepa_collector_host_telemetry
       ORDER BY collected_at DESC
       LIMIT 1`
    )
    const row = tel.rows[0]
    if (row) {
      const payload =
        row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)
          ? (row.payload as Record<string, unknown>)
          : {}
      keepaSensor = keepaCollectorDashboardFromRow({
        collectorId: row.collector_id,
        hostname: row.hostname,
        payload,
        collectedAt: row.collected_at,
      })
    }
  } catch {
    keepaSensor = { ...keepaSensor, lastErrorCode: "TELEMETRY_UNAVAILABLE" }
  }

  const healthObj = { api: "ok" as const, db: health.rows.length ? "ok" : "fail" }
  const oxylabsVerify = await oxylabsCanaryUsage()
  const sourceControl = await loadAmazonSourceControl(keepaSensor, oxylabsVerify, healthObj)

  return {
    generatedAt,
    system: sourceControl.system,
    systemDetail: sourceControl.systemDetail,
    flags: {
      keepa: false,
      planner: scanCfg.plannerEnabled,
      remoteWorkers: scanCfg.remoteWorkersEnabled,
      applyProcessor: scanCfg.applyProcessorEnabled,
      apply: scanCfg.applyEnabled,
      protocol: scanCfg.remoteProtocolEnabled,
    },
    health: healthObj,
    panelHost: {
      ...host,
      diskUsedPct: localTel.diskUsedPct,
      chromiumProcessCount: localTel.chromiumProcessCount,
      pm2,
    },
    scraperHost: scraper
      ? { ...scraper, source: "worker-heartbeat" }
      : { source: "missing", note: "Worker heartbeat telemetry yok" },
    workers,
    queue: {
      activeRoutine,
      pendingClaimable,
      retryableDue,
      retryableFuture,
      claimed: claimedRoutine,
      running: runningRoutine,
      claimable,
      maxOutstanding: scanCfg.plannerMaxOutstanding,
      activeConfirm,
      oldestPendingAgeSec: n(ja?.oldest_pending_age_s) || null,
      oldestDueLagSec: dueLag || null,
      completed15m: n(ja?.c15),
      completed1h: n(ja?.c1h),
      completed24h: n(ja?.c24),
      valid15m: liveSampleCount,
      valid1h: n(ja?.v1h),
      valid24h: n(ja?.v24),
      incomplete24h: n(ja?.inc24),
      captcha24h: n(ja?.captcha24),
      timeout24h: n(ja?.timeout24),
      staleLease: n(stale.rows[0]?.n),
      duplicateActiveAsin: n(dup.rows[0]?.n),
      outbox: {
        pending: outboxMap.PENDING ?? 0,
        processing: 0,
        done: outboxMap.DONE ?? 0,
        failed: outboxMap.FAILED ?? 0,
      },
      priceChange24h: n(reviews.rows[0]?.price24),
      stockZero24h: n(reviews.rows[0]?.stock24),
      mutationFailure24h: n(reviews.rows[0]?.fail24),
      confirmConflict24h: workers.reduce((s, w) => s + w.conflict24h, 0),
      confirmStale24h: workers.reduce((s, w) => s + w.stale24h, 0),
    },
    capacity: {
      uniqueActiveAsins: totalAsin,
      soldAsins: sold,
      otherAsins: other,
      requiredDaily,
      requiredPerHour: Math.round(requiredPerHour * 100) / 100,
      requiredPerMin: Math.round(requiredPerMin * 1000) / 1000,
      validPerMin15m: Math.round(liveRoutinePerMin * 1000) / 1000,
      validPerMin1h: Math.round(n(ja?.v1h) / 60 * 1000) / 1000,
      validPerMin24h: Math.round(n(ja?.v24) / (24 * 60) * 1000) / 1000,
      liveRoutinePerMin: Math.round(liveRoutinePerMin * 1000) / 1000,
      completedPerMin15m: Math.round(completedPerMin * 1000) / 1000,
      qualityRatio: Math.round(advice.qualityRatio * 1000) / 1000,
      qualityPct: Math.round(advice.qualityRatio * 1000) / 10,
      qualityWarning: advice.qualityWarning,
      sameHostAddable: advice.sameHostAddable,
      secondHostRecommended: advice.secondHostRecommended,
      safeRoutinePerHost: SAFE_ROUTINE_PER_HOST,
      hostRoutineOnline: onlineRoutine.length,
      onlineRoutineCount: onlineRoutine.length,
      routineRates: workers
        .filter(w => w.role === "ROUTINE")
        .map(w => ({ slot: w.slot, perMin: w.ratePerMin15m, online: w.status === "ONLINE" })),
      measuredTotalPerMin: Math.round(liveRoutinePerMin * 1000) / 1000,
      idle,
      idleLabel: advice.idleLabel,
      measurementReady: advice.measurementReady,
      measurementWindowSec: n(ja?.measure_span_s),
      queueFull: advice.queueFull,
      queuePressure: advice.queuePressure,
      queueSignal: advice.queueSignal,
      utilizationSeverity: advice.utilizationSeverity,
      benchmarkValidPerMin: BENCHMARK_VALID_PER_MIN,
      benchmarkLabel: "eski A+B benchmark (referans, canli kapasiteye eklenmez)",
      utilizationPct: Math.round(utilizationPct * 10) / 10,
      headroomPct: Math.round(headroomPct * 10) / 10,
      remainingPerMin: Math.round(remaining * 1000) / 1000,
      etaActiveQueueMin: etaQueueMin != null ? Math.round(etaQueueMin * 10) / 10 : null,
      etaFirstPoolHours: etaPoolMin != null ? Math.round((etaPoolMin / 60) * 10) / 10 : null,
      queueTrend1h: trend,
      color,
      critical: critic,
      recommendation,
      extraWorkersSuggested: extraWorkers,
    },
    activity,
    keepaEnabled: keepaCfg.enabled,
    keepaSensor,
    oxylabsVerify,
    sourceControl,
  }
}

export async function handleGetAmazonScanDashboard(): Promise<{ status: number; body: unknown }> {
  try {
    if (cache && Date.now() - cache.at < CACHE_MS) {
      return { status: 200, body: { ...cache.body, cached: true } }
    }
    const body = await buildDashboard()
    cache = { at: Date.now(), body }
    return { status: 200, body: { ...body, cached: false } }
  } catch (e) {
    return {
      status: 500,
      body: { error: "AmazonScanDashboardFailed", message: e instanceof Error ? e.message : String(e) },
    }
  }
}

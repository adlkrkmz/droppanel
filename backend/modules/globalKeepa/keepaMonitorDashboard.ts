import { query } from "../../db/client"
import { avgTokensPerAsin } from "./globalKeepaCapacity"
import { loadGlobalKeepaFoundationConfig } from "./globalKeepaConfig"
import { GLOBAL_KEEPA_ACTIVE_ASIN_IDS_SQL, GLOBAL_KEEPA_ACTIVE_CONSUMER_WHERE } from "./globalKeepaEligibility"
import { getPlatformKeepaMonitorStatus } from "./globalKeepaAdminStatus"
import { countActiveGlobalAsins, countDuePlannerBuckets } from "./globalKeepaPlannerState"
import { getKeepaMonitorRuntime } from "./keepaMonitorTelemetry"
import { rollingUsageTotals, rollingUsageWindow } from "./keepaPlatformUsage"
import { getPlatformAmazonVerificationStatus } from "../amazonVerification/amazonVerificationAdminStatus"
import { loadAmazonVerificationConfig } from "../amazonVerification/amazonVerificationConfig"
import {
  getStockGuardScannerMode,
  legacyAutomatedKeepaScanBlocked,
} from "../stockGuard/stockGuardScannerOwnership"

function n(v: string | number | null | undefined): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0
  return parseInt(String(v ?? "0"), 10) || 0
}

function round1(v: number): number {
  return Math.round(v * 10) / 10
}

function friendlyKeepaResult(status: string | null, decision: string | null): string {
  const d = String(decision ?? "").toUpperCase()
  const s = String(status ?? "").toUpperCase()
  if (d === "STABLE" || s === "PRICE_UNCHANGED" || s === "KEEPA_OK" || s === "FBA_PRESENT") return "STABLE"
  if (d === "FBM_ONLY" || d.includes("FBM")) return "FBM_ONLY"
  if (d === "VERIFY" || d === "PRICE_CHANGED" || d === "PRICE_AMBIGUOUS" || d === "VERIFY_PRICE" || s === "PRICE_AMBIGUOUS") {
    return "VERIFY_PRICE"
  }
  if (d === "FBA_SIGNAL_LOST" || s === "FBA_MISSING") return "FBA_AMBIGUOUS"
  if (d === "PRICE_MISSING" || d === "PRICE_MISSING_VERIFY") return "NO_RELIABLE_PRICE"
  if (d.includes("STALE") || d.includes("MISMATCH") || d.includes("REDIRECT")) return "REDIRECT / SOURCE MISMATCH"
  if (s === "CHECK_FAILED" || d === "CHECK_FAILED" || d === "HTTP_429" || d === "TIMEOUT") return "CHECK_FAILED"
  if (s === "PRODUCT_NOT_RETURNED" || d === "PRODUCT_NOT_RETURNED") return "MISSING PRODUCT"
  return s || d || "OTHER"
}

function friendlyErrorType(status: string): string {
  if (status === "HTTP_429") return "HTTP 429"
  if (status === "HTTP_5XX") return "HTTP 500+"
  if (status === "TIMEOUT") return "TIMEOUT"
  if (status === "NETWORK") return "NETWORK ERROR"
  if (status === "MALFORMED_JSON") return "MALFORMED RESPONSE"
  if (status === "PRODUCT_NOT_RETURNED") return "MISSING PRODUCT"
  if (status === "CHECK_FAILED") return "OTHER"
  return "OTHER"
}

const KEEPA_HARD_DOWN_STATUSES = new Set(["TIMEOUT", "NETWORK", "HTTP_5XX", "MALFORMED_JSON"])
const KEEPA_THROTTLE_STATUSES = new Set(["HTTP_429"])

function healthTs(v: Date | string | null | undefined): number {
  if (v == null) return 0
  const t = new Date(v).getTime()
  return Number.isFinite(t) ? t : 0
}

function keepaApiHealth(input: {
  lastSuccessAt: Date | string | null
  lastFailureAt: Date | string | null
  lastFailureStatus: string | null
  plannerActive: boolean
  hardErrorRate1h: number
  hardFailed1h: number
}): "HEALTHY" | "DEGRADED" | "DOWN" {
  const lastSuccess = healthTs(input.lastSuccessAt)
  const lastFail = healthTs(input.lastFailureAt)
  const failStatus = String(input.lastFailureStatus ?? "").toUpperCase()
  const failIsLatest = lastFail > 0 && lastFail >= lastSuccess

  // DOWN only for a real Keepa HTTP/transport failure. Idle / noDue / empty-product
  // CHECK_FAILED must not look like "BAĞLANTI YOK".
  if (failIsLatest && KEEPA_HARD_DOWN_STATUSES.has(failStatus)) return "DOWN"
  if (failIsLatest && KEEPA_THROTTLE_STATUSES.has(failStatus)) return "DEGRADED"
  if (
    input.hardErrorRate1h >= 10 ||
    (input.hardFailed1h > 0 && failIsLatest && Date.now() - lastSuccess > 3 * 60_000)
  ) {
    return "DEGRADED"
  }
  if (!input.plannerActive && lastSuccess > 0 && Date.now() - lastSuccess > 30 * 60_000) {
    return "DEGRADED"
  }
  return "HEALTHY"
}

function utilizationLabel(util: number, backlog: number): "GOOD" | "UNDERUTILIZED" | "TOO SLOW" | "OK" {
  if (backlog <= 0 && util < 40) return "OK"
  if (util >= 80) return "GOOD"
  if (util >= 40) return "UNDERUTILIZED"
  if (backlog > 0) return "TOO SLOW"
  return "OK"
}

function formatEta(backlog: number, ratePerMin: number): string {
  if (backlog <= 0) return "CAUGHT UP"
  if (!(ratePerMin > 0)) return "STALLED"
  const minutes = backlog / ratePerMin
  const h = Math.floor(minutes / 60)
  const m = Math.round(minutes % 60)
  if (h <= 0) return `${m}m`
  return `${h}h ${m}m`
}

function ago(iso: string | null | undefined): string | null {
  if (!iso) return null
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return null
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${sec} sec ago`
  const min = Math.round(sec / 60)
  if (min < 60) return `${min} min ago`
  const hours = Math.round(min / 60)
  return `${hours}h ago`
}

export async function getKeepaMonitorDashboard(): Promise<Record<string, unknown>> {
  const cfg = loadGlobalKeepaFoundationConfig()
  const verifyCfg = loadAmazonVerificationConfig()
  const scannerMode = getStockGuardScannerMode(cfg)
  const plannerActive = cfg.plannerEnabled && cfg.monitorEnabled
  const runtime = getKeepaMonitorRuntime()
  const foundation = await getPlatformKeepaMonitorStatus()
  const verification = await getPlatformAmazonVerificationStatus()

  const [
    tokenRow,
    active,
    due,
    usage1m,
    usage5m,
    usage1h,
    usage24h,
    exclusion,
    neverScanned,
    scanned1h,
    scanned24h,
    snapshot1h,
    snapshot24h,
    usageErrors1h,
    usageErrors24h,
    lastError,
    lastApi,
    scannedPriority24h,
    verifyBuckets,
    recent,
    historyUsage,
    historySamples,
    qty0Scanned,
    legacyJobs,
    staleRejected,
    obsoleteRejected,
    techZero,
    peak1h,
  ] = await Promise.all([
    query<{
      tokens_left: number | null
      refill_rate: number | null
      refill_in: number | null
      last_api_response_at: Date | null
    }>(`SELECT tokens_left, refill_rate, refill_in, last_api_response_at FROM keepa_platform_token_state WHERE id = 1`),
    countActiveGlobalAsins(),
    countDuePlannerBuckets(cfg.hardMaxCheckAgeHours),
    rollingUsageWindow("interval '1 minute'"),
    rollingUsageWindow("interval '5 minutes'"),
    rollingUsageTotals(1),
    rollingUsageTotals(24),
    query<{
      eligible_listings: string
      qty0: string
      sg_off: string
      ended: string
      no_item: string
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE ${GLOBAL_KEEPA_ACTIVE_CONSUMER_WHERE})::text AS eligible_listings,
         COUNT(*) FILTER (WHERE COALESCE(scs.ebay_quantity, 0) <= 0)::text AS qty0,
         COUNT(*) FILTER (WHERE scs.stock_guard_enabled = false)::text AS sg_off,
         COUNT(*) FILTER (WHERE scs.current_status IS NOT NULL AND scs.current_status <> 'live')::text AS ended,
         COUNT(*) FILTER (WHERE scs.ebay_item_id IS NULL OR BTRIM(scs.ebay_item_id) = '')::text AS no_item
       FROM global_asin_consumers c
       JOIN store_catalog_state scs ON scs.id = c.catalog_state_id
       JOIN stores st ON st.id = c.store_id AND st.workspace_id = c.workspace_id`
    ),
    query<{ c: string }>(
      `WITH eligible AS (${GLOBAL_KEEPA_ACTIVE_ASIN_IDS_SQL})
       SELECT COUNT(*)::text AS c
       FROM eligible e
       LEFT JOIN global_keepa_planner_state p ON p.global_asin_id = e.global_asin_id
       WHERE p.last_success_at IS NULL AND p.last_checked_at IS NULL`
    ),
    query<{ c: string }>(
      `WITH eligible AS (${GLOBAL_KEEPA_ACTIVE_ASIN_IDS_SQL})
       SELECT COUNT(*)::text AS c
       FROM global_keepa_planner_state p
       JOIN eligible e ON e.global_asin_id = p.global_asin_id
       WHERE p.last_checked_at >= NOW() - interval '1 hour'
          OR p.last_success_at >= NOW() - interval '1 hour'`
    ),
    query<{ c: string }>(
      `WITH eligible AS (${GLOBAL_KEEPA_ACTIVE_ASIN_IDS_SQL})
       SELECT COUNT(*)::text AS c
       FROM global_keepa_planner_state p
       JOIN eligible e ON e.global_asin_id = p.global_asin_id
       WHERE p.last_checked_at >= NOW() - interval '24 hours'
          OR p.last_success_at >= NOW() - interval '24 hours'`
    ),
    query<{ status: string; c: string }>(
      `SELECT status, COUNT(*)::text AS c
       FROM global_keepa_snapshots
       WHERE checked_at >= NOW() - interval '1 hour' OR updated_at >= NOW() - interval '1 hour'
       GROUP BY status`
    ),
    query<{ status: string; c: string }>(
      `SELECT status, COUNT(*)::text AS c
       FROM global_keepa_snapshots
       WHERE checked_at >= NOW() - interval '24 hours' OR updated_at >= NOW() - interval '24 hours'
       GROUP BY status`
    ),
    query<{ status: string; c: string }>(
      `SELECT status, COUNT(*)::text AS c
       FROM keepa_platform_usage
       WHERE created_at >= NOW() - interval '1 hour'
       GROUP BY status`
    ),
    query<{ status: string; c: string }>(
      `SELECT status, COUNT(*)::text AS c
       FROM keepa_platform_usage
       WHERE created_at >= NOW() - interval '24 hours'
       GROUP BY status`
    ),
    query<{ status: string; created_at: Date; error_message: string | null }>(
      `SELECT status, created_at, error_message
       FROM keepa_platform_usage
       WHERE status NOT IN ('OK','PARTIAL')
       ORDER BY created_at DESC
       LIMIT 1`
    ).catch(() => ({ rows: [] as { status: string; created_at: Date; error_message: string | null }[] })),
    query<{ last_api_response_at: Date | null }>(
      `SELECT last_api_response_at FROM keepa_platform_token_state WHERE id = 1`
    ),
    query<{ sold: string; clicked: string; normal: string }>(
      `WITH eligible AS (${GLOBAL_KEEPA_ACTIVE_ASIN_IDS_SQL})
       SELECT
         COALESCE(SUM(CASE WHEN p.priority = 0 THEN 1 ELSE 0 END),0)::text AS sold,
         COALESCE(SUM(CASE WHEN p.priority = 1 THEN 1 ELSE 0 END),0)::text AS clicked,
         COALESCE(SUM(CASE WHEN COALESCE(p.priority, 2) = 2 THEN 1 ELSE 0 END),0)::text AS normal
       FROM global_keepa_planner_state p
       JOIN eligible e ON e.global_asin_id = p.global_asin_id
       WHERE p.last_checked_at >= NOW() - interval '24 hours'
          OR p.last_success_at >= NOW() - interval '24 hours'`
    ),
    query<{
      pending: string
      waiting: string
      claimed: string
      running: string
      completed_1h: string
      failed_24h: string
      oldest_pending_min: string | null
      avg_sec: string | null
    }>(
      `SELECT
         SUM(CASE WHEN status IN ('PENDING','RETRYABLE') THEN 1 ELSE 0 END)::text AS pending,
         SUM(CASE WHEN status = 'WAITING_FOR_WORKER' THEN 1 ELSE 0 END)::text AS waiting,
         SUM(CASE WHEN status = 'CLAIMED' THEN 1 ELSE 0 END)::text AS claimed,
         SUM(CASE WHEN status = 'RUNNING' THEN 1 ELSE 0 END)::text AS running,
         SUM(CASE WHEN status = 'COMPLETED' AND completed_at >= NOW() - interval '1 hour' THEN 1 ELSE 0 END)::text AS completed_1h,
         SUM(CASE WHEN status = 'FAILED' AND updated_at >= NOW() - interval '24 hours' THEN 1 ELSE 0 END)::text AS failed_24h,
         EXTRACT(EPOCH FROM (NOW() - MIN(CASE
           WHEN status IN ('PENDING','RETRYABLE','WAITING_FOR_WORKER') THEN created_at END))) / 60 AS oldest_pending_min,
         AVG(CASE WHEN status = 'COMPLETED' AND completed_at >= NOW() - interval '24 hours' AND claimed_at IS NOT NULL
           THEN EXTRACT(EPOCH FROM (completed_at - claimed_at)) END) AS avg_sec
       FROM amazon_price_verification_tasks`
    ),
    query<{
      created_at: Date
      asin: string
      consumer_count: string | null
      priority: number | null
      snapshot_status: string | null
      decision_code: string | null
      candidate_price: string | null
      amazon_price: string | null
      fba_count: number | null
      fbm_count: number | null
      verify_queued: boolean
      tokens_used: number | null
      duration_ms: number | null
      error_type: string | null
    }>(
      `SELECT created_at, asin, consumer_count::text, priority, snapshot_status, decision_code,
              candidate_price::text, amazon_price::text, fba_count, fbm_count,
              verify_queued, tokens_used, duration_ms, error_type
       FROM keepa_asin_scan_events
       ORDER BY created_at DESC
       LIMIT 100`
    ).catch(() => ({ rows: [] })),
    query<{ bucket: Date; asins: string; tokens: string; requests: string; tokens_left: string | null }>(
      `SELECT date_trunc('minute', created_at) AS bucket,
              COALESCE(SUM(returned_product_count),0)::text AS asins,
              COALESCE(SUM(tokens_consumed),0)::text AS tokens,
              COUNT(*)::text AS requests,
              MAX(tokens_left_after)::text AS tokens_left
       FROM keepa_platform_usage
       WHERE created_at >= NOW() - interval '60 minutes'
       GROUP BY 1
       ORDER BY 1`
    ),
    query<{ bucket: Date; tokens_left: number | null; backlog: number | null }>(
      `SELECT date_trunc('minute', created_at) AS bucket,
              MAX(tokens_left) AS tokens_left,
              MAX(backlog) AS backlog
       FROM keepa_monitor_samples
       WHERE created_at >= NOW() - interval '60 minutes'
       GROUP BY 1
       ORDER BY 1`
    ).catch(() => ({ rows: [] })),
    query<{ c: string }>(
      `SELECT COUNT(DISTINCT p.global_asin_id)::text AS c
       FROM global_keepa_planner_state p
       WHERE (p.last_checked_at >= NOW() - interval '24 hours' OR p.last_success_at >= NOW() - interval '24 hours')
         AND p.global_asin_id NOT IN (${GLOBAL_KEEPA_ACTIVE_ASIN_IDS_SQL})
         AND EXISTS (
           SELECT 1 FROM global_asin_consumers c
           JOIN store_catalog_state scs ON scs.id = c.catalog_state_id
           WHERE c.global_asin_id = p.global_asin_id
             AND COALESCE(scs.ebay_quantity, 0) <= 0
         )`
    ),
    query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM stock_guard_jobs
       WHERE job_type = 'source_scan' AND created_at >= NOW() - interval '24 hours'`
    ).catch(() => ({ rows: [{ c: "0" }] })),
    query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM amazon_price_verification_tasks
       WHERE failure_code = 'STALE_SOURCE_RESULT' AND updated_at >= NOW() - interval '24 hours'`
    ).catch(() => ({ rows: [{ c: "0" }] })),
    query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM amazon_price_verification_tasks
       WHERE failure_code = 'OBSOLETE_SOURCE_RESULT' AND updated_at >= NOW() - interval '24 hours'`
    ).catch(() => ({ rows: [{ c: "0" }] })),
    query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM store_catalog_state
       WHERE bot_zeroed_at >= NOW() - interval '24 hours'
         AND bot_zeroed_by = 'verified_source_safety'
         AND COALESCE(bot_zeroed_reason, '') IN (
           'EXTRACTOR_FAILED','CHECK_FAILED','TIMEOUT','NETWORK','CAPTCHA',
           'LOGIN_REQUIRED','MALFORMED','HTTP_429','HTTP_5XX','TECHNICAL_FAILURE'
         )`
    ).catch(() => ({ rows: [{ c: "0" }] })),
    query<{ peak: string }>(
      `SELECT COALESCE(MAX(n),0)::text AS peak FROM (
         SELECT SUM(returned_product_count) AS n
         FROM keepa_platform_usage
         WHERE created_at >= NOW() - interval '1 hour'
         GROUP BY date_trunc('minute', created_at)
       ) t`
    ),
  ])

  const tokensLeft = tokenRow.rows[0]?.tokens_left ?? null
  const refillRate = tokenRow.rows[0]?.refill_rate ?? 20
  const lastApiAt =
    runtime.lastSuccessfulKeepaRequestAt ??
    lastApi.rows[0]?.last_api_response_at?.toISOString() ??
    tokenRow.rows[0]?.last_api_response_at?.toISOString() ??
    null
  const lastPlannerAt =
    runtime.lastPlannerTickAt ??
    historySamples.rows.reduce<string | null>((acc, row) => {
      const iso = new Date(row.bucket).toISOString()
      return !acc || iso > acc ? iso : acc
    }, null)

  const consume1m = usage1m.tokensConsumed
  const consume5m = usage5m.tokensConsumed / 5
  const consume1h = usage1h.tokensConsumed / 60
  const scan1m = usage1m.asinsProcessed
  const scan5m = usage5m.asinsProcessed / 5
  const scan1hAvg = usage1h.asinsProcessed / 60
  const request1m = usage1m.checks
  const asinsPerReq = usage1h.checks > 0 ? usage1h.asinsProcessed / usage1h.checks : null
  const avgTok = avgTokensPerAsin(usage24h.tokensConsumed, usage24h.asinsProcessed)
  const net1m = refillRate - consume1m
  const util = refillRate > 0 ? round1((consume1m > 0 ? consume1m : consume1h) / refillRate * 100) : 0
  const backlog = due.dueUniqueAsins
  const scanRate = scan1m > 0 ? scan1m : scan5m > 0 ? scan5m : scan1hAvg
  const err1h = usageErrors1h.rows.reduce((acc, r) => (r.status === "OK" || r.status === "PARTIAL" ? acc : acc + n(r.c)), 0)
  const ok1h = usageErrors1h.rows.reduce((acc, r) => (r.status === "OK" || r.status === "PARTIAL" ? acc + n(r.c) : acc), 0)
  const total1h = err1h + ok1h
  const errorRate = total1h > 0 ? round1((err1h / total1h) * 100) : 0
  const hardFailed1h = usageErrors1h.rows.reduce((acc, r) => {
    const status = String(r.status ?? "").toUpperCase()
    return KEEPA_HARD_DOWN_STATUSES.has(status) || KEEPA_THROTTLE_STATUSES.has(status) ? acc + n(r.c) : acc
  }, 0)
  const hardErrorRate = total1h > 0 ? round1((hardFailed1h / total1h) * 100) : 0
  const errorMap = (rows: { status: string; c: string }[], missingProduct: number) => {
    const m: Record<string, number> = {
      "HTTP 429": 0,
      "HTTP 500+": 0,
      TIMEOUT: 0,
      "NETWORK ERROR": 0,
      "MALFORMED RESPONSE": 0,
      "MISSING PRODUCT": missingProduct,
      OTHER: 0,
    }
    for (const r of rows) {
      if (r.status === "OK" || r.status === "PARTIAL") continue
      const label = friendlyErrorType(r.status)
      if (label in m) m[label] += n(r.c)
      else m.OTHER += n(r.c)
    }
    return m
  }
  const classMap = (rows: { status: string; c: string }[]) => {
    const m: Record<string, number> = {
      STABLE: 0,
      VERIFY_PRICE: 0,
      FBM_ONLY: 0,
      FBA_AMBIGUOUS: 0,
      NO_RELIABLE_PRICE: 0,
      "REDIRECT / SOURCE MISMATCH": 0,
      CHECK_FAILED: 0,
      "MISSING PRODUCT": 0,
      OTHER: 0,
    }
    for (const r of rows) {
      const label = friendlyKeepaResult(r.status, null)
      if (label in m) m[label] += n(r.c)
      else m.OTHER += n(r.c)
    }
    return m
  }
  const missingProductCount = (rows: { status: string; c: string }[]) =>
    rows.reduce((acc, r) => (r.status === "PRODUCT_NOT_RETURNED" ? acc + n(r.c) : acc), 0)

  const ex = exclusion.rows[0]
  const vb = verifyBuckets.rows[0]
  const qty0 = n(qty0Scanned.rows[0]?.c)
  const legacyDup = scannerMode === "v2" ? n(legacyJobs.rows[0]?.c) : 0
  const lastErr = lastError.rows[0]

  const historyByMin = new Map<string, { asins: number; tokens: number; tokensLeft: number | null; backlog: number | null }>()
  for (const row of historyUsage.rows) {
    const key = new Date(row.bucket).toISOString()
    historyByMin.set(key, {
      asins: n(row.asins),
      tokens: n(row.tokens),
      tokensLeft: row.tokens_left != null ? n(row.tokens_left) : null,
      backlog: null,
    })
  }
  for (const row of historySamples.rows) {
    const key = new Date(row.bucket).toISOString()
    const prev = historyByMin.get(key) ?? { asins: 0, tokens: 0, tokensLeft: null, backlog: null }
    prev.tokensLeft = row.tokens_left ?? prev.tokensLeft
    prev.backlog = row.backlog
    historyByMin.set(key, prev)
  }
  const history = [...historyByMin.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([t, v]) => ({ t, ...v }))

  const noSourceAsin = await query<{ c: string }>(
    `SELECT COUNT(*)::text AS c
     FROM store_catalog_state scs
     JOIN stores st ON st.id = scs.store_id AND st.workspace_id = scs.workspace_id
     WHERE st.status = 'active'
       AND (scs.current_status IS NULL OR scs.current_status = 'live')
       AND COALESCE(scs.ebay_quantity, 0) > 0
       AND NOT EXISTS (
         SELECT 1 FROM global_asin_consumers c WHERE c.catalog_state_id = scs.id
       )`
  ).catch(() => ({ rows: [{ c: "0" }] }))

  const storeBreakdown = await query<{ store_code: string; listings: string; asins: string }>(
    `SELECT st.store_code,
            COUNT(*) FILTER (WHERE ${GLOBAL_KEEPA_ACTIVE_CONSUMER_WHERE})::text AS listings,
            COUNT(DISTINCT g.asin) FILTER (WHERE ${GLOBAL_KEEPA_ACTIVE_CONSUMER_WHERE})::text AS asins
     FROM global_asin_consumers c
     JOIN global_amazon_asins g ON g.id = c.global_asin_id
     JOIN store_catalog_state scs ON scs.id = c.catalog_state_id
     JOIN stores st ON st.id = c.store_id AND st.workspace_id = c.workspace_id
     GROUP BY st.store_code
     ORDER BY COUNT(DISTINCT g.asin) FILTER (WHERE ${GLOBAL_KEEPA_ACTIVE_CONSUMER_WHERE}) DESC
     LIMIT 12`
  ).catch(() => ({ rows: [] }))

  const lastConnectionFail =
    lastErr &&
    (KEEPA_HARD_DOWN_STATUSES.has(String(lastErr.status).toUpperCase()) ||
      KEEPA_THROTTLE_STATUSES.has(String(lastErr.status).toUpperCase()))
      ? lastErr
      : null
  const keepaHealth = keepaApiHealth({
    lastSuccessAt: lastApiAt,
    lastFailureAt: lastConnectionFail?.created_at ?? null,
    lastFailureStatus: lastConnectionFail?.status ?? null,
    plannerActive,
    hardErrorRate1h: hardErrorRate,
    hardFailed1h,
  })

  return {
    generatedAt: new Date().toISOString(),
    telemetrySource: "keepa_platform_usage + keepa_asin_scan_events + keepa_monitor_samples",
    header: {
      keepaApi: keepaHealth,
      v2Scanner: plannerActive ? "ACTIVE" : "INACTIVE",
      planner: cfg.plannerEnabled ? "ACTIVE" : "INACTIVE",
      legacyScanner: legacyAutomatedKeepaScanBlocked(cfg) ? "BLOCKED" : "ACTIVE",
      verification: verifyCfg.verificationEnabled ? "ACTIVE" : "INACTIVE",
      extensionWorkers: n(String(verification.onlineWorkers ?? 0)),
      lastKeepaSuccessAgo: ago(lastApiAt),
      lastPlannerTickAgo: ago(lastPlannerAt),
      lastPlannerTickAt: lastPlannerAt,
      lastPlannerTickSkipped: runtime.lastPlannerTickSkipped,
      lastKeepaSuccessAt: lastApiAt,
      shadowMode: cfg.shadowMode,
    },
    tokens: {
      available: tokensLeft,
      refillRate,
      refillIn: tokenRow.rows[0]?.refill_in ?? null,
      consumptionLast1m: consume1m,
      consumptionLast5m: round1(consume5m * 5),
      consumptionLast1h: usage1h.tokensConsumed,
      consumptionLast24h: usage24h.tokensConsumed,
      consumptionPerMin1m: round1(consume1m),
      consumptionPerMin5m: round1(consume5m),
      consumptionPerMin1h: round1(consume1h),
      netPerMin: round1(net1m),
      avgTokenPerUniqueAsin: avgTok,
    },
    asins: {
      eligibleListings: n(ex?.eligible_listings),
      uniqueEligibleAsins: active.activeUniqueAsinCount,
      dueNow: due.dueUniqueAsins,
      neverScanned: n(neverScanned.rows[0]?.c),
      scannedLast1h: n(scanned1h.rows[0]?.c),
      scannedLast24h: n(scanned24h.rows[0]?.c),
      backlog: backlog,
      notDueYet: Math.max(0, active.activeUniqueAsinCount - due.dueUniqueAsins),
      qtyZeroExcluded: n(ex?.qty0),
      stockGuardOffExcluded: n(ex?.sg_off),
      endedExcluded: n(ex?.ended),
      noSourceAsinExcluded: n(noSourceAsin.rows[0]?.c),
    },
    throughput: {
      uniqueAsinPerMin1m: round1(scan1m),
      uniqueAsinPerMin5m: round1(scan5m),
      uniqueAsinPerMin1h: round1(scan1hAvg),
      peakUniqueAsinPerMin1h: n(peak1h.rows[0]?.peak),
      keepaRequestsPerMin: round1(request1m),
      asinsPerRequest: asinsPerReq != null ? round1(asinsPerReq) : null,
      tokensPerMinute: round1(consume1m > 0 ? consume1m : consume1h),
    },
    capacity: {
      theoreticalSustainableAsinPerMin: refillRate,
      actualAsinPerMin: round1(scanRate),
      utilizationPercent: util,
      utilizationStatus: utilizationLabel(util, backlog),
      eta: formatEta(backlog, scanRate),
    },
    priority: {
      sold: {
        uniqueAsins: active.soldAsins,
        dueNow: due.soldDue,
        scannedLast24h: n(scannedPriority24h.rows[0]?.sold),
        cadenceHours: cfg.soldMinRecheckHours,
      },
      clicked: {
        uniqueAsins: active.clickedAsins,
        dueNow: due.clickedDue,
        scannedLast24h: n(scannedPriority24h.rows[0]?.clicked),
        cadenceHours: cfg.clickedMinRecheckHours,
      },
      normal: {
        uniqueAsins: active.normalAsins,
        dueNow: due.normalDue,
        scannedLast24h: n(scannedPriority24h.rows[0]?.normal),
        cadenceHours: cfg.normalMinRecheckHours,
      },
    },
    results: {
      last1h: classMap(snapshot1h.rows),
      last24h: classMap(snapshot24h.rows),
    },
    errors: {
      last1h: errorMap(usageErrors1h.rows, missingProductCount(snapshot1h.rows)),
      last24h: errorMap(usageErrors24h.rows, missingProductCount(snapshot24h.rows)),
      errorRate1hPercent: errorRate,
      lastError: lastErr
        ? {
            at: lastErr.created_at,
            type: friendlyErrorType(lastErr.status),
            message: lastErr.error_message,
          }
        : null,
    },
    verification: {
      pending: n(vb?.pending),
      waitingForWorker: n(vb?.waiting),
      claimed: n(vb?.claimed),
      running: n(vb?.running),
      completedLast1h: n(vb?.completed_1h),
      failedLast24h: n(vb?.failed_24h),
      onlineWorkers: n(String(verification.onlineWorkers ?? 0)),
      oldestPendingMinutes: vb?.oldest_pending_min != null ? round1(Number(vb.oldest_pending_min)) : null,
      avgDurationSeconds: vb?.avg_sec != null ? round1(Number(vb.avg_sec)) : null,
      enabled: verifyCfg.verificationEnabled,
    },
    safety: {
      qty0ScannedLast24h: qty0,
      legacyV2DuplicateAutomatedScans: legacyDup,
      staleSourceResultRejected: n(staleRejected.rows[0]?.c),
      obsoleteSourceResult: n(obsoleteRejected.rows[0]?.c),
      technicalFailureEbayDestructive: n(techZero.rows[0]?.c),
    },
    recent: recent.rows.map(r => ({
      time: r.created_at,
      asin: r.asin,
      consumers: n(r.consumer_count),
      priority: r.priority === 0 ? "SOLD" : r.priority === 1 ? "CLICKED" : "NORMAL",
      keepaResult: friendlyKeepaResult(r.snapshot_status, r.decision_code),
      candidatePrice: r.candidate_price != null ? Number(r.candidate_price) : null,
      amazonPrice: r.amazon_price != null ? Number(r.amazon_price) : null,
      fbaCount: r.fba_count,
      fbmCount: r.fbm_count,
      decision: r.decision_code,
      tokensUsed: r.tokens_used,
      durationMs: r.duration_ms,
      verificationQueued: r.verify_queued === true,
      error: r.error_type,
    })),
    history,
    stores: storeBreakdown.rows.map(r => ({
      storeCode: r.store_code,
      eligibleListings: n(r.listings),
      uniqueAsins: n(r.asins),
    })),
    foundation,
  }
}

export async function handleGetKeepaMonitorDashboard(): Promise<{ status: number; body: unknown }> {
  try {
    return { status: 200, body: await getKeepaMonitorDashboard() }
  } catch (e) {
    return {
      status: 500,
      body: {
        error: "KeepaMonitorDashboardFailed",
        message: e instanceof Error ? e.message : String(e),
      },
    }
  }
}

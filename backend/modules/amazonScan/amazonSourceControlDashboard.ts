import { query } from "../../db/client"
import { loadOxylabsVerifyConfig } from "../oxylabsVerify/oxylabsVerifyConfig"
import { KEEPA_COLLECTOR_STALE_MS } from "./keepaCollectorDashboard"

const OXY_STALE_MS = 45_000

function n(v: unknown): number {
  const x = typeof v === "number" ? v : parseInt(String(v ?? "0"), 10)
  return Number.isFinite(x) ? x : 0
}

function iso(v: Date | string | null | undefined): string | null {
  if (v == null || v === "") return null
  const d = new Date(v)
  return Number.isFinite(d.getTime()) ? d.toISOString() : null
}

function keepaCardState(input: {
  online: boolean
  scanMode: string | null
  stallReason: string | null
}): string {
  if (!input.online) return "Çevrimdışı"
  const mode = String(input.scanMode ?? "").toUpperCase()
  if (mode === "STALLED" || input.stallReason) return "Durdu"
  if (mode === "SYNC_REPAIR" || mode === "SYNC_RECONCILE_MISMATCH") return "Senkron Onarılıyor"
  if (mode === "BACKLOG_DRAIN") return "Backlog Taranıyor"
  if (mode === "TOKEN_WAIT") return "Token Bekliyor"
  if (mode === "CADENCE_WAIT" || mode === "IDLE_NO_DUE") return "Cadence Bekliyor"
  return "Çalışıyor"
}

function keepaHint(mode: string | null, due: number): string {
  const m = String(mode ?? "").toUpperCase()
  if (m === "TOKEN_WAIT") {
    return due > 0
      ? "Token yenilenmesi bekleniyor. Token geldikçe tarama devam ediyor."
      : "Token yenilenmesi bekleniyor"
  }
  if (m === "CADENCE_WAIT" || m === "IDLE_NO_DUE") return "Sıradaki 12/24 saatlik tarama zamanı bekleniyor"
  if (m === "BACKLOG_DRAIN") return "Birikmiş ürünler taranıyor"
  if (m === "SYNC_REPAIR" || m === "SYNC_RECONCILE_MISMATCH") return "Kayıtlar otomatik eşitleniyor"
  if (m === "STALLED") return "Tarama ilerlemiyor"
  if (due === 0) return "Taranacak zamanı gelmiş ürün yok"
  return ""
}

function trKeepaEval(code: string | null | undefined): string {
  const c = String(code ?? "").toUpperCase()
  if (c === "KEEPA_SNAPSHOT_CHANGED") return "Fiyat değişikliği yakalandı"
  if (c === "BASELINE_PRICE_MISMATCH") return "Baseline fiyat uyuşmazlığı"
  if (c === "CONFIRMED_PRICE_MISMATCH") return "Onaylı kaynak fiyat uyuşmazlığı"
  if (c === "BASELINE_PRICE_CONSISTENT" || c === "PRICE_CONSISTENT") return "Fiyat eşleşiyor"
  if (c === "NO_TRUSTED_REFERENCE") return "Güvenilir referans yok"
  if (!c) return "—"
  return c
}

function trDecision(code: string | null | undefined): string {
  const c = String(code ?? "").toUpperCase()
  if (c === "SOURCE_ASIN_MISMATCH" || c === "ASIN_IDENTITY_CHANGED") return "ASIN başka ürüne yönleniyor"
  if (c === "OUT_OF_STOCK") return "Amazon’da stok yok"
  if (c === "NOT_PRIME") return "Prime uygun değil"
  if (c === "NOT_FBA") return "Amazon gönderimi değil"
  if (c === "PRICE_CHANGE") return "Fiyat değişti"
  if (c === "PRICE_MATCH" || c === "NO_BUSINESS_CHANGE") return "Fiyat eşleşiyor"
  if (c === "PRODUCT_INCONCLUSIVE") return "Kanıt yetersiz — işlem yapılmadı"
  if (!c) return "—"
  return c
}

function trEbay(action: string | null, status: string | null, target: string | null): string {
  if (!action) return "İşlem gerekmiyor"
  if (status === "RETRYABLE") return "Tekrar denenecek"
  if (status === "FAILED") return "Başarısız"
  if (action === "zero_stock") return target ? `eBay stoğu ${target}` : "eBay stoğu 0"
  if (action === "profit_protection") return "eBay fiyatı güncellendi"
  return action
}

export type OxylabsPlanSnapshot = {
  planMode: string
  monthlyLimit: number
  cycleStart: string | null
  cycleEnd: string | null
  cycleReserved: number
  cycleSuccessful: number
  remaining: number
  lifetimeReserved: number
  lifetimeSuccessful: number
  pending: number
  workerStatus: string | null
  lastProductAt: string | null
  lastError: string | null
}

export async function loadAmazonSourceControl(
  keepaSensor: Record<string, unknown>,
  plan: OxylabsPlanSnapshot,
  health: { api: string; db: string }
): Promise<Record<string, unknown>> {
  const oxyCfg = loadOxylabsVerifyConfig()
  const [
    hb,
    jobs,
    httpErr,
    dupCall,
    confirmN,
    diffs30,
    applyNow,
    apply24,
    lastApply,
    decisions,
    alerts24,
    activity,
  ] = await Promise.all([
    query<{
      worker_id: string
      status: string
      last_heartbeat_at: Date
      last_error: string | null
      current_job_id: string | null
      host_telemetry: unknown
    }>(
      `SELECT worker_id, status, last_heartbeat_at, left(COALESCE(last_error,''), 180) AS last_error,
              current_job_id::text, host_telemetry
       FROM amazon_scan_worker_heartbeat
       WHERE worker_id = 'oxylabs-product-primary-A'`
    ),
    query<{
      pending: string
      claimed: string
      completed_30m: string
      completed_24h: string
      failed_30m: string
      failed_24h: string
      expired_claimed: string
      last_claim_at: Date | null
      last_completed_at: Date | null
      oldest_pending_age_s: string | null
      product_calls_24h: string
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'PENDING')::text AS pending,
         COUNT(*) FILTER (WHERE status IN ('CLAIMED','RUNNING'))::text AS claimed,
         COUNT(*) FILTER (WHERE status = 'COMPLETED' AND completed_at >= NOW() - interval '30 minutes')::text AS completed_30m,
         COUNT(*) FILTER (WHERE status = 'COMPLETED' AND completed_at >= NOW() - interval '24 hours')::text AS completed_24h,
         COUNT(*) FILTER (WHERE status = 'FAILED' AND COALESCE(completed_at, updated_at) >= NOW() - interval '30 minutes')::text AS failed_30m,
         COUNT(*) FILTER (WHERE status = 'FAILED' AND COALESCE(completed_at, updated_at) >= NOW() - interval '24 hours')::text AS failed_24h,
         COUNT(*) FILTER (
           WHERE status IN ('CLAIMED','RUNNING')
             AND lease_expires_at IS NOT NULL
             AND lease_expires_at < NOW()
         )::text AS expired_claimed,
         MAX(claimed_at) AS last_claim_at,
         MAX(completed_at) FILTER (WHERE status = 'COMPLETED') AS last_completed_at,
         EXTRACT(EPOCH FROM (NOW() - MIN(created_at) FILTER (WHERE status = 'PENDING')))::int::text AS oldest_pending_age_s,
         COUNT(*) FILTER (WHERE claimed_at >= NOW() - interval '24 hours')::text AS product_calls_24h
       FROM amazon_scan_jobs
       WHERE kind = 'OXYLABS_PRODUCT_PRIMARY'`
    ),
    query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM amazon_scan_jobs
       WHERE kind = 'OXYLABS_PRODUCT_PRIMARY'
         AND COALESCE(completed_at, updated_at) >= NOW() - interval '24 hours'
         AND (
           COALESCE(failure_code,'') ~ '(401|403|413|429|5[0-9]{2})'
           OR COALESCE(failure_message,'') ~ '(401|403|413|429|5[0-9]{2})'
         )`
    ),
    query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM (
         SELECT job_id FROM oxylabs_verify_call_reservations
         WHERE reserved_at >= NOW() - interval '24 hours'
         GROUP BY job_id HAVING COUNT(*) > 1
       ) d`
    ),
    query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM amazon_scan_jobs WHERE kind = 'OXYLABS_PRODUCT_CONFIRM'`),
    query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM keepa_verify_candidates
       WHERE created_at >= NOW() - interval '30 minutes'
         AND COALESCE(snapshot->>'evaluationCode','') = 'KEEPA_SNAPSHOT_CHANGED'`
    ),
    query<{ status: string; n: string }>(
      `SELECT status, COUNT(*)::text AS n FROM oxylabs_apply_operations GROUP BY status`
    ),
    query<{ action: string; status: string; n: string }>(
      `SELECT action, status, COUNT(*)::text AS n
       FROM oxylabs_apply_operations
       WHERE created_at >= NOW() - interval '24 hours'
       GROUP BY action, status`
    ),
    query<{ applied: Date | null; oldest_age_s: string | null }>(
      `SELECT
         MAX(applied_at) FILTER (WHERE status = 'APPLIED') AS applied,
         EXTRACT(EPOCH FROM (NOW() - MIN(created_at) FILTER (WHERE status IN ('CLAIMED','RETRYABLE'))))::int::text AS oldest_age_s
       FROM oxylabs_apply_operations`
    ),
    query<{ code: string; n: string }>(
      `SELECT COALESCE(result_payload->'oxylabs_policy'->>'code', '(none)') AS code, COUNT(*)::text AS n
       FROM amazon_scan_jobs
       WHERE kind = 'OXYLABS_PRODUCT_PRIMARY'
         AND status = 'COMPLETED'
         AND completed_at >= NOW() - interval '24 hours'
       GROUP BY 1`
    ),
    query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM stock_review_items WHERE created_at >= NOW() - interval '24 hours'`
    ),
    query<{
      at: Date
      asin: string
      keepa_eval: string | null
      panel_cents: string | null
      code: string | null
      product_class: string | null
      job_status: string
      operation_key: string | null
      apply_action: string | null
      apply_status: string | null
      target: string | null
    }>(
      `SELECT * FROM (
         SELECT
           COALESCE(j.completed_at, j.claimed_at, j.created_at) AS at,
           j.asin,
           c.snapshot->>'evaluationCode' AS keepa_eval,
           c.snapshot->>'panelCents' AS panel_cents,
           j.result_payload->'oxylabs_policy'->>'code' AS code,
           j.result_payload->'oxylabs_policy'->>'productClass' AS product_class,
           j.status AS job_status,
           op.operation_key,
           op.action AS apply_action,
           op.status AS apply_status,
           op.target
         FROM amazon_scan_jobs j
         LEFT JOIN keepa_verify_candidates c ON c.id = j.keepa_candidate_id
         LEFT JOIN LATERAL (
           SELECT operation_key, action, status, target
           FROM oxylabs_apply_operations o
           WHERE o.job_id = j.id
           ORDER BY o.created_at DESC
           LIMIT 1
         ) op ON true
         WHERE j.kind = 'OXYLABS_PRODUCT_PRIMARY'
           AND COALESCE(j.completed_at, j.claimed_at, j.created_at) >= NOW() - interval '24 hours'
         ORDER BY COALESCE(j.completed_at, j.claimed_at, j.created_at) DESC
         LIMIT 50
       ) x`
    ),
  ])

  const hbRow = hb.rows[0]
  const hbAgeMs = hbRow?.last_heartbeat_at ? Date.now() - new Date(hbRow.last_heartbeat_at).getTime() : null
  const oxyOnline = Boolean(
    hbRow && hbAgeMs != null && hbAgeMs <= OXY_STALE_MS && String(hbRow.status).toUpperCase() === "ONLINE"
  )
  const tel =
    hbRow?.host_telemetry && typeof hbRow.host_telemetry === "object" && !Array.isArray(hbRow.host_telemetry)
      ? (hbRow.host_telemetry as Record<string, unknown>)
      : {}
  const workerVersion =
    typeof tel.workerVersion === "string"
      ? tel.workerVersion
      : typeof tel.version === "string"
        ? tel.version
        : null

  const j = jobs.rows[0]
  const pending = n(j?.pending)
  const claimed = n(j?.claimed)
  const expired = n(j?.expired_claimed)
  const applyMap: Record<string, number> = {}
  for (const r of applyNow.rows) applyMap[r.status] = n(r.n)
  let stockZero24h = 0
  let priceUpdate24h = 0
  let applyRetry24 = 0
  let applyFail24 = 0
  for (const r of apply24.rows) {
    if (r.action === "zero_stock" && r.status === "APPLIED") stockZero24h += n(r.n)
    if (r.action === "profit_protection" && r.status === "APPLIED") priceUpdate24h += n(r.n)
    if (r.status === "RETRYABLE") applyRetry24 += n(r.n)
    if (r.status === "FAILED") applyFail24 += n(r.n)
  }

  const decisionCounts: Record<string, number> = {}
  for (const r of decisions.rows) decisionCounts[r.code] = n(r.n)
  const noOp = n(decisionCounts.NO_BUSINESS_CHANGE) + n(decisionCounts.PRICE_MATCH)

  const seenKeys = new Set<string>()
  const activityRows = activity.rows.flatMap(r => {
    const key = r.operation_key || `job:${r.asin}:${iso(r.at)}`
    if (seenKeys.has(key)) return []
    seenKeys.add(key)
    let status = "İşlem gerekmiyor"
    if (r.job_status === "PENDING") status = "Doğrulama bekliyor"
    else if (r.job_status === "CLAIMED" || r.job_status === "RUNNING") status = "Doğrulama sürüyor"
    else if (r.job_status === "FAILED") status = "Başarısız"
    else if (r.apply_status === "APPLIED" && r.apply_action === "zero_stock") status = "eBay stoğu 1 → 0"
    else if (r.apply_status === "APPLIED" && r.apply_action === "profit_protection") status = "eBay fiyatı güncellendi"
    else if (r.code === "PRICE_CHANGE" && !r.apply_action) status = "Fiyat düşüşü — eBay fiyatı korunuyor"
    else if (r.job_status === "COMPLETED") status = "Doğrulama tamamlandı"
    return [
      {
        at: iso(r.at),
        asin: r.asin,
        keepaDiff: trKeepaEval(r.keepa_eval),
        previous: r.panel_cents != null && r.panel_cents !== "" ? `Panel ${r.panel_cents}¢` : "—",
        oxylabs: r.product_class || r.job_status,
        decision: trDecision(r.code),
        decisionCode: r.code,
        ebay: trEbay(r.apply_action, r.apply_status, r.target),
        status,
        operationKey: r.operation_key,
      },
    ]
  })

  const keepaOnline = String(keepaSensor.status ?? "") === "ONLINE"
  const scanMode = keepaSensor.scanMode != null ? String(keepaSensor.scanMode) : null
  const dueSold = n(keepaSensor.dueSold)
  const dueStandard = n(keepaSensor.dueStandard)
  const due = dueSold + dueStandard
  const keepaState = keepaCardState({
    online: keepaOnline,
    scanMode,
    stallReason: keepaSensor.stallReason != null ? String(keepaSensor.stallReason) : null,
  })
  const oldestPending = j?.oldest_pending_age_s != null ? n(j.oldest_pending_age_s) : 0
  const mode = String(scanMode ?? "").toUpperCase()
  const dbOk = health.db === "ok"
  const apiOk = health.api === "ok"
  let system = "Sağlıklı"
  let systemDetail = "Sağlıklı — Değişiklik bulunmadı"
  if (!dbOk || !apiOk) {
    system = "Hatalı"
    systemDetail = "Hatalı — API veya veritabanı"
  } else if (!keepaOnline || mode === "STALLED") {
    system = "Hatalı"
    systemDetail = keepaOnline ? "Hatalı — Tarama ilerlemiyor" : "Hatalı — Keepa çevrimdışı"
  } else if (!oxyOnline) {
    system = "Hatalı"
    systemDetail = "Hatalı — Oxylabs worker çevrimdışı"
  } else if (expired > 0 || oldestPending >= 1800 || (applyMap.FAILED ?? 0) > 0) {
    system = "Uyarı"
    systemDetail = expired > 0 ? "Uyarı — Süresi dolmuş CLAIMED iş" : "Uyarı"
  } else if (mode === "TOKEN_WAIT" && due > 0) {
    system = "Çalışıyor"
    systemDetail = "Çalışıyor — Token yenileniyor"
  } else if ((mode === "CADENCE_WAIT" || mode === "IDLE_NO_DUE") && due === 0) {
    system = "Beklemede"
    systemDetail = "Beklemede — Tarama zamanı bekleniyor"
  } else if (n(j?.completed_30m) > 0) {
    system = "Çalışıyor"
    systemDetail = "Doğrulama tamamlandı"
  } else if (mode === "BACKLOG_DRAIN" || mode === "SYNC_REPAIR") {
    system = "Çalışıyor"
    systemDetail = keepaHint(scanMode, due) || "Çalışıyor"
  } else if (oxyOnline && pending === 0) {
    system = "Sağlıklı"
    systemDetail = "Sağlıklı — Değişiklik bulunmadı"
  }

  const oxyReadyNote = oxyOnline && pending === 0 ? "Hazır — Değişiklik bekliyor" : null
  const ages = [
    keepaSensor.oldestDueAgeSec != null ? n(keepaSensor.oldestDueAgeSec) : null,
    j?.oldest_pending_age_s != null ? n(j.oldest_pending_age_s) : null,
    lastApply.rows[0]?.oldest_age_s != null ? n(lastApply.rows[0].oldest_age_s) : null,
  ].filter((x): x is number => x != null && x > 0)
  const oldestWaitingSec = ages.length ? Math.max(...ages) : null

  return {
    system,
    systemDetail,
    keepaCard: keepaState,
    keepaHint: keepaHint(scanMode, due),
    keepa: {
      commercialDiffs30m: n(diffs30.rows[0]?.n),
    },
    oxylabs: {
      applyProcessorEnabled: oxyCfg.applyProcessorEnabled,
      mutationsEnabled: oxyCfg.mutationsEnabled,
      workerOnline: oxyOnline,
      workerStatus: hbRow?.status ?? plan.workerStatus,
      heartbeatAgeSec: hbAgeMs != null ? Math.round(hbAgeMs / 1000) : null,
      lastHeartbeatAt: iso(hbRow?.last_heartbeat_at),
      workerVersion,
      lastClaimAt: iso(j?.last_claim_at),
      lastCompletedAt: iso(j?.last_completed_at ?? plan.lastProductAt),
      lastError: (hbRow?.last_error && hbRow.last_error.trim()) || plan.lastError || null,
      pending,
      claimed,
      completed30m: n(j?.completed_30m),
      completed24h: n(j?.completed_24h),
      failed30m: n(j?.failed_30m),
      failed24h: n(j?.failed_24h),
      expiredClaimed: expired,
      oldestPendingAgeSec: j?.oldest_pending_age_s != null ? n(j.oldest_pending_age_s) : null,
      httpError24h: n(httpErr.rows[0]?.n),
      productCalls24h: n(j?.product_calls_24h),
      duplicateProductCalls: n(dupCall.rows[0]?.n),
      pricingCalls: 0,
      confirmCalls: n(confirmN.rows[0]?.n),
      productEnabled: true,
      pricingEnabled: false,
      confirmEnabled: false,
      readyNote: oxyReadyNote,
    },
    apply: {
      lastAppliedAt: iso(lastApply.rows[0]?.applied),
      stockZero24h,
      priceUpdate24h,
      retryable: applyMap.RETRYABLE ?? 0,
      failed: applyMap.FAILED ?? 0,
      pending: applyMap.CLAIMED ?? 0,
      retryable24h: applyRetry24,
      failed24h: applyFail24,
      warning: applyRetry24 > 0 || applyFail24 > 0 || (applyMap.FAILED ?? 0) > 0 || (applyMap.RETRYABLE ?? 0) > 0,
    },
    decisions24h: {
      sourceAsinMismatch: n(decisionCounts.SOURCE_ASIN_MISMATCH),
      outOfStock: n(decisionCounts.OUT_OF_STOCK),
      notPrime: n(decisionCounts.NOT_PRIME),
      notFba: n(decisionCounts.NOT_FBA),
      priceChange: n(decisionCounts.PRICE_CHANGE),
      priceMatch: n(decisionCounts.PRICE_MATCH) + n(decisionCounts.NO_BUSINESS_CHANGE),
      inconclusive: n(decisionCounts.PRODUCT_INCONCLUSIVE),
      stockZero: stockZero24h,
      priceUpdated: priceUpdate24h,
      noAction: noOp,
      failed: n(j?.failed_24h),
    },
    stockAlerts24h: n(alerts24.rows[0]?.n),
    activity: activityRows,
    oldestWaitingSec,
    plan: {
      planMode: plan.planMode,
      monthlyLimit: plan.monthlyLimit,
      cycleStart: plan.cycleStart,
      cycleEnd: plan.cycleEnd,
      cycleReserved: plan.cycleReserved,
      cycleSuccessful: plan.cycleSuccessful,
      remaining: plan.remaining,
      hasPaidCycle: plan.planMode === "paid" && Boolean(plan.cycleStart),
    },
  }
}

export { KEEPA_COLLECTOR_STALE_MS, OXY_STALE_MS }

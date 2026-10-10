import { keepaCapacityStats, dashboardKeepaBanner, formatKeepaDurationMs, keepaScanMode, KEEPA_TOKEN_RESERVE_DEFAULT } from "../keepaSensor/keepaTokenScheduler"
import { KEEPA_COLLECTOR_VERSION } from "../keepaSensor/keepaCollectorVersion"

export const KEEPA_COLLECTOR_STALE_MS = 45_000

export function keepaCollectorDashboardFromRow(input: {
  collectorId: string
  hostname: string
  payload: Record<string, unknown>
  collectedAt: Date | string | null
  nowMs?: number
}): Record<string, unknown> {
  const now = input.nowMs ?? Date.now()
  const collectedMs = input.collectedAt ? new Date(input.collectedAt).getTime() : 0
  const ageMs = collectedMs > 0 ? Math.max(0, now - collectedMs) : null
  const online = ageMs != null && ageMs <= KEEPA_COLLECTOR_STALE_MS
  const n = (k: string): number | null => {
    const v = input.payload[k]
    const x = typeof v === "number" ? v : parseFloat(String(v ?? ""))
    return Number.isFinite(x) ? x : null
  }
  const s = (k: string): string | null => {
    const v = input.payload[k]
    return v == null || v === "" ? null : String(v)
  }
  const sold = n("registrySold") ?? 0
  const standard = n("registryStandard") ?? 0
  const cap = keepaCapacityStats({
    sold,
    standard,
    refillRate: n("refillRate") ?? 0,
    tokenFlowReduction: n("tokenFlowReduction"),
  })
  const dueSold = n("dueSold") ?? 0
  const dueStandard = n("dueStandard") ?? 0
  const dueCount = dueSold + dueStandard
  const tokensLeft = n("tokensLeft")
  const snapshotted = n("baselineCount") ?? 0
  const registryTotal = (n("registryActive") ?? 0) + (n("registryPaused") ?? 0)
  const coverage = n("baselineCoveragePct")
  const etaSec = n("queueEtaSec")
  const lastErrorCode = s("lastErrorCode")
  const reconcileMatched = input.payload.reconcileMatched
  const repairNeeded =
    lastErrorCode === "SYNC_RECONCILE_MISMATCH" ||
    lastErrorCode === "REPAIR_COMPLETE_409" ||
    reconcileMatched === false
  const registryStatusLabel = repairNeeded ? "Registry repair gerekli" : "Registry eşleşiyor"
  const tokenReserveRaw = n("tokenReserve")
  const spendableTokens =
    n("spendableTokens") ??
    (tokensLeft != null
      ? Math.max(0, Math.floor(Number(tokensLeft)) - (tokenReserveRaw ?? KEEPA_TOKEN_RESERVE_DEFAULT))
      : null)
  const tokenReserve =
    tokenReserveRaw ??
    (tokensLeft != null && spendableTokens != null ? Math.max(0, Math.floor(Number(tokensLeft)) - spendableTokens) : null)
  const scanMode = s("scanMode") ?? keepaScanMode({ dueCount, spendable: spendableTokens ?? 0 })
  const phase = s("phase")
  const baselineRunning = phase !== "COMPLETE" && registryTotal > 0 && snapshotted < registryTotal
  const banner = dashboardKeepaBanner({
    dueCount,
    tokensLeft,
    reserve: tokenReserve ?? KEEPA_TOKEN_RESERVE_DEFAULT,
    capacityShort: cap.capacityShort,
    baselineIncomplete: baselineRunning,
    queueEtaLabel: etaSec != null ? `${Math.round(etaSec / 60)} dk` : null,
  })
  return {
    collectorId: input.collectorId,
    hostname: input.hostname,
    status: online ? "ONLINE" : "OFFLINE",
    heartbeatAgeSec: ageMs != null ? Math.round(ageMs / 1000) : null,
    collectedAt: collectedMs > 0 ? new Date(collectedMs).toISOString() : null,
    collectorVersion: s("collectorVersion") ?? KEEPA_COLLECTOR_VERSION,
    phase,
    runMode: s("runMode"),
    keepaApiStatus: s("keepaApiStatus"),
    tokensLeft,
    estimatedBucketCapacity: n("estimatedBucketCapacity") ?? cap.estimatedBucketCapacity,
    refillRate: n("refillRate"),
    effectiveRefillRate: n("effectiveRefillRate") ?? cap.effectiveRefillRate,
    refillIn: n("refillIn"),
    refillInLabel: formatKeepaDurationMs(n("refillIn")),
    tokensConsumed: n("tokensConsumed"),
    tokenCostPerAsin: n("tokenCostPerAsin") ?? 1,
    tokensSpent15m: n("tokensSpent15m") ?? 0,
    tokensSpent1h: n("tokensSpent1h") ?? 0,
    tokensSpent24h: n("tokensSpent24h") ?? 0,
    scans15m: n("scans15m") ?? 0,
    scans1h: n("scans1h") ?? 0,
    scans24h: n("scans24h") ?? 0,
    parsed15m: n("parsed15m") ?? 0,
    parsed1h: n("parsed1h") ?? 0,
    parsed24h: n("parsed24h") ?? 0,
    dailyCapacity: cap.dailyCapacity,
    requiredDaily: cap.requiredDaily,
    utilizationPct: Math.round(cap.utilizationPct * 10) / 10,
    headroom: cap.headroom,
    capacityShort: cap.capacityShort,
    soldCadenceHours: 12,
    standardCadenceHours: 24,
    registryActive: n("registryActive") ?? 0,
    registryPaused: n("registryPaused") ?? 0,
    registrySold: sold,
    registryStandard: standard,
    baselineCount: snapshotted,
    baselineTotal: registryTotal,
    baselineCoveragePct: coverage,
    dueSold,
    dueStandard,
    oldestDueAgeSec: n("oldestDueAgeSec"),
    queueEtaSec: etaSec,
    candidatePending: n("candidatePending") ?? 0,
    candidateRetryable: n("candidateRetryable") ?? 0,
    candidateNoBusinessChange: n("candidateNoBusinessChange") ?? 0,
    candidateConfirmed: n("candidateConfirmed") ?? 0,
    candidateConflict: n("candidateConflict") ?? 0,
    http429: n("http429") ?? 0,
    http401: n("http401") ?? 0,
    http403: n("http403") ?? 0,
    http5xx: n("http5xx") ?? 0,
    backoffMs: n("backoffMs") ?? 0,
    lastErrorCode,
    lastKeepaAt: s("lastKeepaAt"),
    nextDueAt: s("nextDueAt"),
    lastSchedulerDecisionAt: s("lastSchedulerDecisionAt"),
    lastProgressAt: s("lastProgressAt"),
    stallReason: s("stallReason"),
    registryRepairNeeded: repairNeeded,
    registryStatusLabel,
    banner,
    scanMode,
    spendableTokens,
    tokenReserve,
    observationOutboxPending: n("observationOutboxPending") ?? 0,
    observationOutboxDelivered: n("observationOutboxDelivered") ?? 0,
    lastKeepaBatchSize: n("lastKeepaBatchSize") ?? n("requested") ?? 0,
    highTokensNotCritical: dueCount === 0,
  }
}

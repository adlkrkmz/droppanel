import os from "os"
import { KEEPA_COLLECTOR_VERSION } from "./keepaCollectorVersion"
import { keepaCapacityStats } from "./keepaTokenScheduler"

export const KEEPA_COLLECTOR_TELEMETRY_KEYS = [
  "collectorVersion",
  "collectorId",
  "hostname",
  "phase",
  "runMode",
  "enabled",
  "lastLoopAt",
  "lastKeepaAt",
  "lastSuccessAt",
  "tokensLeft",
  "refillRate",
  "refillIn",
  "tokensConsumed",
  "tokenFlowReduction",
  "estimatedBucketCapacity",
  "effectiveRefillRate",
  "registryActive",
  "registryPaused",
  "registrySold",
  "registryStandard",
  "baselineCount",
  "baselineCoveragePct",
  "dueSold",
  "dueStandard",
  "retryCount",
  "backoffMs",
  "candidatePending",
  "candidateRetryable",
  "candidateNoBusinessChange",
  "candidateConfirmed",
  "candidateConflict",
  "candidateTerminal",
  "scans15m",
  "scans1h",
  "scans24h",
  "parsed15m",
  "parsed1h",
  "parsed24h",
  "tokensSpent15m",
  "tokensSpent1h",
  "tokensSpent24h",
  "requested",
  "returned",
  "parsed",
  "errorCount",
  "http429",
  "http401",
  "http403",
  "http5xx",
  "oldestDueAgeSec",
  "queueEtaSec",
  "lastErrorCode",
  "localReconcileCount",
  "localReconcileHash",
  "keepaApiStatus",
  "tokenCostPerAsin",
  "collectedAt",
  "syncState",
  "eventsPulled",
  "eventsApplied",
  "eventsNoop",
  "localCommitted",
  "pendingAck",
  "spendableTokens",
  "scanMode",
  "nextDueAt",
  "lastSchedulerDecisionAt",
  "lastProgressAt",
  "stallReason",
  "observationOutboxPending",
  "observationOutboxDelivered",
  "lastKeepaBatchSize",
  "eventsAcked",
  "catchupRound",
  "reconcileMatched",
  "centralReconcileCount",
  "lastEventCreatedAt",
  "lastEventIdMasked",
  "added",
  "updated",
  "paused",
  "removed",
  "preserved",
  "stagingCount",
  "repairPage",
] as const

export type KeepaCollectorTelemetry = {
  [K in (typeof KEEPA_COLLECTOR_TELEMETRY_KEYS)[number]]?: string | number | boolean | null
}

const SECRET_KEY = /^(api[_-]?key|keepa[_-]?api[_-]?key|authorization|bearer|password|secret|token|refresh|database_url|ebay|credential|cookie)$/i
const SECRET_VALUE = /asin|listing|store|workspace|user|password|secret|bearer |api[_-]?key/i

export function sanitizeKeepaCollectorTelemetry(input: Record<string, unknown>): KeepaCollectorTelemetry {
  const out: KeepaCollectorTelemetry = {}
  for (const key of KEEPA_COLLECTOR_TELEMETRY_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue
    const raw = input[key]
    if (SECRET_KEY.test(key)) continue
    if (typeof raw === "string") {
      if (SECRET_VALUE.test(raw) && key !== "lastErrorCode" && key !== "localReconcileHash" && key !== "collectorId" && key !== "hostname" && key !== "phase" && key !== "runMode" && key !== "keepaApiStatus" && key !== "syncState" && key !== "lastEventIdMasked" && key !== "lastEventCreatedAt" && key !== "scanMode" && key !== "stallReason" && key !== "nextDueAt" && key !== "lastSchedulerDecisionAt" && key !== "lastProgressAt") {
        continue
      }
      if (raw.length > 200) continue
      out[key] = raw
      continue
    }
    if (typeof raw === "number" && Number.isFinite(raw)) out[key] = raw
    else if (typeof raw === "boolean") out[key] = raw
    else if (raw == null) out[key] = null
  }
  return out
}

export function telemetryContainsForbidden(payload: Record<string, unknown>): boolean {
  const json = JSON.stringify(payload).toLowerCase()
  if (json.includes("keepa_api_key") || json.includes("authorization")) return true
  if (json.includes("ebay_refresh") || json.includes("database_url")) return true
  if (/"asin"\s*:/.test(json)) return true
  return Object.keys(payload).some(k => SECRET_KEY.test(k) || k.toLowerCase() === "asin")
}

export function defaultCollectorId(env = process.env): string {
  const id = String(env.KEEPA_COLLECTOR_ID ?? "").trim()
  if (id && /^[A-Za-z0-9._:-]{1,64}$/.test(id)) return id
  const host = os.hostname().split(".")[0] ?? "keepa-collector"
  return host.slice(0, 64)
}

export function buildCapacityFields(input: {
  sold: number
  standard: number
  refillRate: number | null
  tokenFlowReduction: number | null
}): Pick<KeepaCollectorTelemetry, "estimatedBucketCapacity" | "effectiveRefillRate"> {
  const cap = keepaCapacityStats({
    sold: input.sold,
    standard: input.standard,
    refillRate: input.refillRate ?? 0,
    tokenFlowReduction: input.tokenFlowReduction,
  })
  return {
    estimatedBucketCapacity: cap.estimatedBucketCapacity,
    effectiveRefillRate: cap.effectiveRefillRate,
  }
}

export function stampTelemetry(partial: Record<string, unknown>, env = process.env): KeepaCollectorTelemetry {
  return sanitizeKeepaCollectorTelemetry({
    collectorVersion: KEEPA_COLLECTOR_VERSION,
    collectorId: defaultCollectorId(env),
    hostname: os.hostname().split(".")[0] ?? "keepa-collector",
    tokenCostPerAsin: 1,
    collectedAt: new Date().toISOString(),
    ...partial,
  })
}

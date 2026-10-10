import { countRecentDbConnectionErrors, query } from "../../db/client"
import { deliverZeroStockTelegramAlert } from "./zeroStockTelegramAdapter"

export type ZeroStockAlertEvent = {
  alertKey: string
  rule: string
  severity: "warning" | "critical"
  windowStart: Date
  windowEnd: Date
  count: number
  storeId?: number
  reason?: string
  sampleOperations: string[]
  message: string
}

type AlertCandidate = Omit<ZeroStockAlertEvent, "message"> & { cooldownMinutes: number }
type Operation = { operationKey: string; storeId: number; reason: string | null }

const fifteenMinutes = 15 * 60_000
const fiveMinutes = 5 * 60_000

export const MAINTENANCE_SUPPRESSION_SUPPORTED = false

export function buildZeroStockAlertCandidates(input: {
  now: Date
  applied: Operation[]
  failed: string[]
  dbErrorCount: number
  burstActive: boolean
}): AlertCandidate[] {
  const windowStart = new Date(input.now.getTime() - fifteenMinutes)
  const candidates: AlertCandidate[] = []
  const add = (rule: string, severity: "warning" | "critical", count: number, cooldownMinutes: number, extra: Partial<AlertCandidate> = {}) => {
    candidates.push({ alertKey: `${rule}:${extra.storeId ?? extra.reason ?? "global"}`, rule, severity, windowStart, windowEnd: input.now, count, sampleOperations: input.applied.slice(0, 5).map(x => x.operationKey), cooldownMinutes, ...extra })
  }
  if (input.applied.length >= 20) add("GLOBAL_ZERO_BURST_CRITICAL", "critical", input.applied.length, 30)
  else if (input.applied.length >= 12) add("GLOBAL_ZERO_BURST_WARNING", "warning", input.applied.length, 30)
  for (const [storeId, ops] of groupBy(input.applied, x => x.storeId)) {
    if (ops.length >= 12) add("STORE_ZERO_BURST", "warning", ops.length, 30, { storeId, sampleOperations: ops.slice(0, 5).map(x => x.operationKey) })
  }
  for (const [reason, ops] of groupBy(input.applied.filter(x => x.reason), x => x.reason!)) {
    if (ops.length >= 8 && ops.length / input.applied.length >= 0.8) add("REASON_CONCENTRATION", "warning", ops.length, 30, { reason, sampleOperations: ops.slice(0, 5).map(x => x.operationKey) })
  }
  if (input.failed.length >= 3) add("REPEATED_ZERO_STOCK_FAILURES", "critical", input.failed.length, 15, { sampleOperations: input.failed.slice(0, 5) })
  if (input.dbErrorCount >= 2 && input.burstActive) {
    candidates.push({ alertKey: "DB_INSTABILITY_DURING_ZERO_BURST:global", rule: "DB_INSTABILITY_DURING_ZERO_BURST", severity: "critical", windowStart: new Date(input.now.getTime() - fiveMinutes), windowEnd: input.now, count: input.dbErrorCount, sampleOperations: [], cooldownMinutes: 15 })
  }
  return candidates
}

function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const result = new Map<K, T[]>()
  for (const item of items) { const k = key(item); result.set(k, [...(result.get(k) ?? []), item]) }
  return result
}

export function formatZeroStockAlert(candidate: Omit<AlertCandidate, "cooldownMinutes">): string {
  const scope = candidate.storeId != null ? `\nStore: ${candidate.storeId}` : candidate.reason ? `\nReason: ${candidate.reason}` : ""
  return `[ListJetGo] ${candidate.rule.replace(/_/g, " ")} ${candidate.severity.toUpperCase()}\n${candidate.count} zero-stock operations in ${candidate.rule === "DB_INSTABILITY_DURING_ZERO_BURST" ? "5" : "15"}m${scope}\nWindow: ${candidate.windowStart.toISOString()} – ${candidate.windowEnd.toISOString()}\nALERT ONLY — mutations were not blocked.`
}

async function persistIfNotCooling(candidate: AlertCandidate): Promise<ZeroStockAlertEvent | null> {
  const metadata = JSON.stringify({ severity: candidate.severity, count: candidate.count, storeId: candidate.storeId ?? null, reason: candidate.reason ?? null, sampleOperations: candidate.sampleOperations })
  const res = await query<{ emitted: boolean }>(`
    INSERT INTO zero_stock_alert_state (alert_key, first_seen_at, last_seen_at, last_sent_at, cooldown_until, occurrence_count, metadata)
    VALUES ($1, NOW(), NOW(), NOW(), NOW() + ($2::int * interval '1 minute'), 1, $3::jsonb)
    ON CONFLICT (alert_key) DO UPDATE SET
      last_seen_at = NOW(), occurrence_count = zero_stock_alert_state.occurrence_count + 1, metadata = EXCLUDED.metadata,
      -- A missed detector interval means the condition cleared; let a later
      -- recurrence alert even if the old cooldown has not elapsed.
      last_sent_at = CASE WHEN zero_stock_alert_state.cooldown_until IS NULL OR zero_stock_alert_state.cooldown_until <= NOW() OR zero_stock_alert_state.last_seen_at < NOW() - interval '90 seconds' THEN NOW() ELSE zero_stock_alert_state.last_sent_at END,
      cooldown_until = CASE WHEN zero_stock_alert_state.cooldown_until IS NULL OR zero_stock_alert_state.cooldown_until <= NOW() OR zero_stock_alert_state.last_seen_at < NOW() - interval '90 seconds' THEN NOW() + ($2::int * interval '1 minute') ELSE zero_stock_alert_state.cooldown_until END
    RETURNING last_sent_at = NOW() AS emitted`, [candidate.alertKey, candidate.cooldownMinutes, metadata])
  if (!res.rows[0]?.emitted) return null
  const { cooldownMinutes: _unused, ...event } = candidate
  return { ...event, message: formatZeroStockAlert(event) }
}

export async function runZeroStockAnomalyDetector(now = new Date()): Promise<ZeroStockAlertEvent[]> {
  const since = new Date(now.getTime() - fifteenMinutes)
  const [applied, failed] = await Promise.all([
    query<{ operation_key: string; store_id: string; reason: string | null }>(`
      SELECT o.operation_key, scs.store_id::text, j.failure_code AS reason
      FROM oxylabs_apply_operations o JOIN store_catalog_state scs ON scs.id = o.catalog_state_id
      JOIN amazon_scan_jobs j ON j.id = o.job_id
      WHERE o.action = 'zero_stock' AND o.status = 'APPLIED' AND o.applied_at >= $1::timestamptz`, [since.toISOString()]),
    query<{ operation_key: string }>(`SELECT operation_key FROM oxylabs_apply_operations WHERE action = 'zero_stock' AND status IN ('RETRYABLE','FAILED') AND updated_at >= $1::timestamptz`, [since.toISOString()]),
  ])
  const appliedOps = applied.rows.map(row => ({ operationKey: row.operation_key, storeId: Number(row.store_id), reason: row.reason }))
  const candidates = buildZeroStockAlertCandidates({ now, applied: appliedOps, failed: failed.rows.map(r => r.operation_key), dbErrorCount: countRecentDbConnectionErrors(new Date(now.getTime() - fiveMinutes)), burstActive: appliedOps.length >= 12 })
  const emitted: ZeroStockAlertEvent[] = []
  for (const candidate of candidates) {
    const event = await persistIfNotCooling(candidate)
    if (event) {
      emitted.push(event)
      console.warn("[ZeroStockAnomaly]", event)
      await deliverZeroStockTelegramAlert(event)
    }
  }
  console.log("[ZeroStockAnomaly] cycle", {
    appliedZeroStock: appliedOps.length,
    failedZeroStock: failed.rows.length,
    candidateAlerts: candidates.length,
    emittedAlerts: emitted.length,
  })
  return emitted
}

let timer: NodeJS.Timeout | null = null
let running = false
export function startZeroStockAnomalyDetector(): void {
  if (timer) return
  const tick = async () => { if (running) return; running = true; try { await runZeroStockAnomalyDetector() } catch (error) { console.error("[ZeroStockAnomaly] tick failed", error instanceof Error ? error.message : String(error)) } finally { running = false } }
  timer = setInterval(() => { void tick() }, 60_000)
  setTimeout(() => { void tick() }, 30_000)
  console.log("[ZeroStockAnomaly] alert-only detector started (every 60000 ms)")
}

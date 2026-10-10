import assert from "node:assert/strict"
import { buildZeroStockAlertCandidates, formatZeroStockAlert } from "../modules/oxylabsVerify/zeroStockAnomalyDetector"

const now = new Date("2026-10-05T12:00:00.000Z")
const ops = (count: number, options: { storeId?: number; reason?: string } = {}) => Array.from({ length: count }, (_, i) => ({ operationKey: `op-${i}`, storeId: options.storeId ?? 1, reason: options.reason ?? "OUT_OF_STOCK" }))
const rules = (applied: ReturnType<typeof ops>, failed: string[] = [], dbErrorCount = 0, burstActive = false) => buildZeroStockAlertCandidates({ now, applied, failed, dbErrorCount, burstActive }).map(x => x.rule)

assert(!rules(ops(11)).includes("GLOBAL_ZERO_BURST_WARNING"))
assert(rules(ops(12)).includes("GLOBAL_ZERO_BURST_WARNING"))
assert(!rules(ops(19)).includes("GLOBAL_ZERO_BURST_CRITICAL"))
assert(rules(ops(20)).includes("GLOBAL_ZERO_BURST_CRITICAL"))
assert(rules(ops(12, { storeId: 7 })).includes("STORE_ZERO_BURST"))
assert(rules([...ops(8, { reason: "OUT_OF_STOCK" }), ...ops(2, { reason: "OTHER" })]).includes("REASON_CONCENTRATION"))
assert(!rules([...ops(7, { reason: "OUT_OF_STOCK" }), ...ops(3, { reason: "OTHER" })]).includes("REASON_CONCENTRATION"))
assert(rules([], ["a", "b", "c"]).includes("REPEATED_ZERO_STOCK_FAILURES"))
assert(rules(ops(12), [], 2, true).includes("DB_INSTABILITY_DURING_ZERO_BURST"))
const warningThenCritical = rules(ops(20))
assert(warningThenCritical.includes("GLOBAL_ZERO_BURST_CRITICAL"))
const message = formatZeroStockAlert(buildZeroStockAlertCandidates({ now, applied: ops(12), failed: [], dbErrorCount: 0, burstActive: true })[0])
assert.match(message, /ALERT ONLY — mutations were not blocked/)
console.log("PASS zero-stock anomaly thresholds, escalation candidate, failure, DB correlation, and alert-only message")

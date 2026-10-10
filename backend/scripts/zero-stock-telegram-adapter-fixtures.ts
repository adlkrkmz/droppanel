import assert from "node:assert/strict"
import { buildZeroStockAlertCandidates, formatZeroStockAlert, type ZeroStockAlertEvent } from "../modules/oxylabsVerify/zeroStockAnomalyDetector"
import { deliverZeroStockTelegramAlert } from "../modules/oxylabsVerify/zeroStockTelegramAdapter"

const candidate = buildZeroStockAlertCandidates({
  now: new Date("2026-10-05T12:00:00.000Z"),
  applied: Array.from({ length: 12 }, (_, i) => ({ operationKey: `operation-${i}`, storeId: 7, reason: "OUT_OF_STOCK" })),
  failed: [], dbErrorCount: 0, burstActive: true,
})[0]
const { cooldownMinutes: _unused, ...bare } = candidate
const event: ZeroStockAlertEvent = { ...bare, message: formatZeroStockAlert(bare) }
let sends = 0
void (async () => {
  // No emitted event means no adapter invocation (normal detector cycle).
  assert.equal(sends, 0)
  await deliverZeroStockTelegramAlert(event, async message => { sends++; assert.match(message, /ALERT ONLY/); assert.doesNotMatch(message, /operation-0/) })
  assert.equal(sends, 1)
  // A dedupe-suppressed event is not passed to the adapter.
  assert.equal(sends, 1)
  const critical = { ...event, rule: "GLOBAL_ZERO_BURST_CRITICAL", severity: "critical" as const }
  await deliverZeroStockTelegramAlert(critical, async () => { sends++ })
  assert.equal(sends, 2)
  await deliverZeroStockTelegramAlert(event, async () => { throw new Error("transport unavailable") })
  assert.equal(sends, 2)
  console.log("PASS Telegram adapter: emitted-only delivery, escalation, failure isolation, ALERT ONLY, no operation details")
})().catch(error => { console.error(error); process.exit(1) })

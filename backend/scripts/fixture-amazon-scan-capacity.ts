import { computeAmazonScanCapacityAdvice } from "../modules/amazonScan/amazonScanCapacity"
import {
  classifyAmazonScanWorker,
  includeActivityRow,
  mergeScraperTelemetry,
  sortAmazonScanWorkers,
} from "../modules/amazonScan/amazonScanDashboardWorkers"

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

function cap(extra: Partial<import("../modules/amazonScan/amazonScanCapacity").AmazonScanCapacityInput> = {}) {
  return {
    claimable: 38,
    maxOutstanding: 50,
    measuredPerMin: 5.667,
    completedPerMin: 5.667,
    requiredPerMin: 9.137,
    measurementWindowSec: 867,
    sampleCount: 68,
    heartbeatHealthy: true,
    telemetryReady: true,
    perWorkerPerMin: 2.8,
    dueLagSec: 0,
    onlineRoutineCount: 2,
    ...extra,
  }
}

const idleZero = computeAmazonScanCapacityAdvice(cap({
  claimable: 0, measuredPerMin: 0, completedPerMin: 0, sampleCount: 0, dueLagSec: 0,
}))
assert(idleZero.idle, "idle")
assert(idleZero.extraWorkersSuggested == null, "no extra when empty queue")
assert(idleZero.recommendation === "Talep karşılandı / idle", idleZero.recommendation)

const warmup = computeAmazonScanCapacityAdvice(cap({
  claimable: 50, measuredPerMin: 0.6, completedPerMin: 8, sampleCount: 9, telemetryReady: false, perWorkerPerMin: 0.3,
}))
assert(warmup.recommendation === "Ölçüm hazırlanıyor", warmup.recommendation)
assert(warmup.extraWorkersSuggested == null, "no extra during warmup")

const gapBelowCap = computeAmazonScanCapacityAdvice(cap({}))
assert(gapBelowCap.measurementReady, "ready")
assert(gapBelowCap.recommendation === "Ek ROUTINE worker gerekli", gapBelowCap.recommendation)
assert(gapBelowCap.extraWorkersSuggested === 2, String(gapBelowCap.extraWorkersSuggested))
assert(gapBelowCap.utilizationSeverity === "critical", gapBelowCap.utilizationSeverity)

const hostFull = computeAmazonScanCapacityAdvice(cap({ onlineRoutineCount: 4, perWorkerPerMin: 1.4 }))
assert(hostFull.extraWorkersSuggested == null, "no +N when host full")
assert(/ikinci scraper/i.test(hostFull.recommendation), hostFull.recommendation)
assert(hostFull.secondHostRecommended, "second host")

const lowQuality = computeAmazonScanCapacityAdvice(cap({
  measuredPerMin: 1.6,
  completedPerMin: 14.8,
  sampleCount: 24,
  perWorkerPerMin: 0.23,
  onlineRoutineCount: 7,
}))
assert(lowQuality.qualityWarning === "Tarama kalitesi düşük", String(lowQuality.qualityWarning))
assert(lowQuality.extraWorkersSuggested == null, "no +27")
assert(/concurrency doygunluğu/i.test(lowQuality.recommendation), lowQuality.recommendation)

const slowFull = computeAmazonScanCapacityAdvice(cap({
  claimable: 63,
  measuredPerMin: 4.53,
  completedPerMin: 5,
  requiredPerMin: 9.14,
  perWorkerPerMin: 2.26,
  dueLagSec: 120,
}))
assert(slowFull.measurementReady, "ready")
assert(slowFull.extraWorkersSuggested === 2, String(slowFull.extraWorkersSuggested))
assert(slowFull.recommendation === "Ek ROUTINE worker gerekli", slowFull.recommendation)
assert(slowFull.queuePressure, "queue pressure")

const warnUtil = computeAmazonScanCapacityAdvice(cap({
  claimable: 10,
  measuredPerMin: 10,
  completedPerMin: 10,
  requiredPerMin: 9.14,
  measurementWindowSec: 900,
  sampleCount: 80,
  perWorkerPerMin: 5,
}))
assert(warnUtil.recommendation === "Mevcut ROUTINE workerlar yeterli", warnUtil.recommendation)
assert(warnUtil.utilizationSeverity === "warning", warnUtil.utilizationSeverity)

const fast = computeAmazonScanCapacityAdvice(cap({
  claimable: 50,
  measuredPerMin: 14.21,
  completedPerMin: 14.21,
  requiredPerMin: 9.14,
  measurementWindowSec: 900,
  sampleCount: 200,
  perWorkerPerMin: 7.1,
}))
assert(fast.recommendation === "Mevcut ROUTINE workerlar yeterli", fast.recommendation)
assert(fast.extraWorkersSuggested == null, "no extra when above required")
assert(fast.utilizationSeverity === "ok", fast.utilizationSeverity)

assert(classifyAmazonScanWorker("amazon-public-browser-worker-D")?.role === "ROUTINE", "D routine")
assert(classifyAmazonScanWorker("amazon-public-browser-worker-E")?.slot === "E", "E slot")
assert(classifyAmazonScanWorker("amazon-scan-confirm-C")?.role === "CONFIRM", "C confirm")
assert(classifyAmazonScanWorker("amazon-public-browser-worker-test") == null, "unknown skipped")
assert(classifyAmazonScanWorker("listjetgo-amazon-public-worker-A") == null, "local skipped")
assert(includeActivityRow("ROUTINE", "amazon-public-browser-worker-F"), "F events")
assert(!includeActivityRow("ROUTINE", "amazon-scan-confirm-C"), "C not in routine feed")
assert(includeActivityRow("CONFIRM", "amazon-scan-confirm-C"), "C confirm events")
assert(!includeActivityRow("CONFIRM", "amazon-public-browser-worker-A"), "routine not in confirm-as-worker")
const sorted = sortAmazonScanWorkers([
  { role: "CONFIRM" as const, slot: "C" },
  { role: "ROUTINE" as const, slot: "E" },
  { role: "ROUTINE" as const, slot: "A" },
])
assert(sorted.map(w => w.slot).join("") === "AEC", sorted.map(w => w.slot).join(""))

const tel = (hostname: string, ram: number, rss: number, chrome: number, at: string) => ({
  hostname,
  ramTotalBytes: ram,
  ramUsedBytes: ram / 2,
  ramAvailableBytes: ram / 2,
  ramUsedPct: 50,
  swapTotalBytes: 0,
  swapUsedBytes: 0,
  load1: 1,
  load5: 1,
  load15: 1,
  diskUsedPct: 10,
  chromiumProcessCount: chrome,
  nodeRssBytes: rss,
  uptimeSec: 9,
  collectedAt: at,
})
const merged = mergeScraperTelemetry([
  { host_telemetry: tel("scan-host", 16_000, 100, 12, "2026-09-20T18:00:02Z") },
  { host_telemetry: tel("scan-host", 16_000, 200, 12, "2026-09-20T18:00:01Z") },
  { host_telemetry: tel("scan-host", 16_000, 300, 12, "2026-09-20T18:00:00Z") },
])
assert(merged?.ramTotalBytes === 16_000, "ram once")
assert(merged?.nodeRssBytes === 600, "rss summed")
assert(merged?.chromiumProcessCount === 12, "chrome host once")

console.log("fixture-amazon-scan-capacity ok")

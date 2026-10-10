export const BENCHMARK_VALID_PER_MIN = 14.21
export const REQUIRED_MEASUREMENT_WINDOW_SEC = 15 * 60
export const SAFE_ROUTINE_PER_HOST = 4
export const QUALITY_WARN_RATIO = 0.7
export const QUALITY_BLOCK_RATIO = 0.5

export type AmazonScanCapacityInput = {
  claimable: number
  maxOutstanding: number
  measuredPerMin: number
  completedPerMin: number
  requiredPerMin: number
  measurementWindowSec: number
  sampleCount: number
  heartbeatHealthy: boolean
  telemetryReady: boolean
  perWorkerPerMin: number
  dueLagSec: number
  onlineRoutineCount: number
  safeRoutinePerHost?: number
}

export type AmazonScanCapacityAdvice = {
  measurementReady: boolean
  idle: boolean
  idleLabel: string | null
  recommendation: string
  extraWorkersSuggested: number | null
  queueFull: boolean
  queuePressure: boolean
  queueSignal: string | null
  utilizationPct: number
  utilizationSeverity: "idle" | "warmup" | "ok" | "warning" | "critical"
  qualityRatio: number
  qualityWarning: string | null
  sameHostAddable: number
  secondHostRecommended: boolean
}

export function computeAmazonScanCapacityAdvice(input: AmazonScanCapacityInput): AmazonScanCapacityAdvice {
  const claimable = Math.max(0, input.claimable)
  const dueLagSec = Math.max(0, input.dueLagSec || 0)
  const idle = claimable <= 0 && dueLagSec <= 0
  const queueFull = claimable >= Math.max(1, input.maxOutstanding)
  const queuePressure = queueFull || dueLagSec > 0
  const measurementReady =
    input.heartbeatHealthy &&
    input.telemetryReady &&
    input.measurementWindowSec >= 10 * 60 &&
    input.sampleCount >= 24
  const live = input.measuredPerMin
  const required = input.requiredPerMin
  const completed = Math.max(0, input.completedPerMin)
  const qualityRatio = completed > 0 ? live / completed : 0
  const safeCap = input.safeRoutinePerHost ?? SAFE_ROUTINE_PER_HOST
  const sameHostAddable = Math.max(0, safeCap - Math.max(0, input.onlineRoutineCount))
  const utilizationPct = live > 0 ? (required / live) * 100 : required > 0 ? 999 : 0
  let extraWorkersSuggested: number | null = null
  let recommendation = "Ölçüm hazırlanıyor"
  let utilizationSeverity: AmazonScanCapacityAdvice["utilizationSeverity"] = "warmup"
  let qualityWarning: string | null = null
  let secondHostRecommended = false
  let queueSignal: string | null = null
  if (queueFull) queueSignal = "Claimable kuyruk tavanında — ek kritik kanıt"
  else if (dueLagSec > 0) queueSignal = `Due gecikmesi ${dueLagSec}s — ek kritik kanıt`
  else if (claimable > 0) queueSignal = `Claimable ${claimable}/${input.maxOutstanding} (tavan altı kapasite açığını gizlemez)`

  if (measurementReady && !idle && qualityRatio < QUALITY_WARN_RATIO) {
    qualityWarning = "Tarama kalitesi düşük"
  }

  if (idle) {
    recommendation = "Talep karşılandı / idle"
    utilizationSeverity = "idle"
  } else if (!measurementReady) {
    recommendation = "Ölçüm hazırlanıyor"
    utilizationSeverity = "warmup"
  } else if (qualityRatio < QUALITY_BLOCK_RATIO) {
    secondHostRecommended = true
    recommendation = "Aynı IP/host concurrency doygunluğu — ikinci scraper sunucusu öneriliyor."
  } else if (live + 0.0001 < required) {
    const needed =
      input.perWorkerPerMin > 0 ? Math.max(1, Math.ceil((required - live) / input.perWorkerPerMin)) : 1
    extraWorkersSuggested = Math.min(needed, sameHostAddable)
    if (extraWorkersSuggested <= 0) {
      extraWorkersSuggested = null
      secondHostRecommended = true
      recommendation = "Aynı IP/host concurrency doygunluğu — ikinci scraper sunucusu öneriliyor."
    } else {
      recommendation = "Ek ROUTINE worker gerekli"
    }
  } else {
    recommendation = "Mevcut ROUTINE workerlar yeterli"
  }

  if (!idle && measurementReady) {
    if (qualityRatio < QUALITY_BLOCK_RATIO || utilizationPct > 100) utilizationSeverity = "critical"
    else if (qualityRatio < QUALITY_WARN_RATIO || utilizationPct > 85) utilizationSeverity = "warning"
    else utilizationSeverity = "ok"
  }

  return {
    measurementReady,
    idle,
    idleLabel: idle ? "Talep karşılandı / idle" : null,
    recommendation,
    extraWorkersSuggested,
    queueFull,
    queuePressure,
    queueSignal,
    utilizationPct,
    utilizationSeverity,
    qualityRatio,
    qualityWarning,
    sameHostAddable,
    secondHostRecommended,
  }
}

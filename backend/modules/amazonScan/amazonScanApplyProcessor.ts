import { loadAmazonScanConfig } from "./amazonScanConfig"
import { applyCompletedScanJob } from "./amazonScanApply"
import { claimApplyOutboxRows, markApplyOutboxDone, markApplyOutboxRetry } from "./amazonScanJobQueue"

let timer: NodeJS.Timeout | null = null
let running = false

async function tick(): Promise<void> {
  const cfg = loadAmazonScanConfig()
  if (!cfg.applyProcessorEnabled) return
  const rows = await claimApplyOutboxRows(cfg.applyConcurrency)
  for (const row of rows) {
    try {
      await applyCompletedScanJob(row.jobId)
      await markApplyOutboxDone(row.id)
    } catch (e) {
      await markApplyOutboxRetry(row.id, e instanceof Error ? e.message : String(e))
    }
  }
}

export function startAmazonScanApplyProcessor(): void {
  const cfg = loadAmazonScanConfig()
  if (!cfg.applyProcessorEnabled) {
    console.log("[AmazonScanApply] disabled")
    return
  }
  if (timer) return
  timer = setInterval(() => {
    if (running) return
    running = true
    void tick().finally(() => {
      running = false
    })
  }, 2000)
  console.log("[AmazonScanApply] processor started")
}

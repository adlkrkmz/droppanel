import {
  recentOrderPollIntervalMs,
  runRecentOrderPollTick,
} from "./ebayRecentOrderPollService"

const LOG = "[EbayRecentOrderPollScheduler]"

let schedulerStarted = false

async function schedulerTick(): Promise<void> {
  try {
    await runRecentOrderPollTick()
  } catch (e) {
    console.error(`${LOG} tick error:`, e instanceof Error ? e.message : String(e))
  }
}

export function startEbayRecentOrderPollScheduler(): void {
  if (schedulerStarted) return
  schedulerStarted = true
  const intervalMs = recentOrderPollIntervalMs()
  console.log(`${LOG} started (every ${intervalMs} ms, recent orders only)`)
  setInterval(() => {
    void schedulerTick()
  }, intervalMs)
  setTimeout(() => {
    void schedulerTick()
  }, 25_000)
}

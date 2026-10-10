import { processNextThankYouSend } from "./csThankYouService"

const LOG = "[CustomerServiceSendScheduler]"

function intervalMs(): number {
  const n = Number.parseInt(process.env.CUSTOMER_SERVICE_SEND_INTERVAL_MS ?? "30000", 10)
  return Number.isFinite(n) && n >= 10_000 ? n : 30_000
}

let started = false
let tickInProgress = false

async function tick(): Promise<void> {
  if (tickInProgress) return
  tickInProgress = true
  try {
    for (let i = 0; i < 10; i++) {
      const result = await processNextThankYouSend()
      if (result === "empty") break
    }
  } catch (e) {
    console.error(`${LOG} tick error:`, e instanceof Error ? e.message : String(e))
  } finally {
    tickInProgress = false
  }
}

export function startCustomerServiceSendScheduler(): void {
  if (started) return
  started = true
  const ms = intervalMs()
  console.log(`${LOG} started (every ${ms} ms, customer service send queue)`)
  setInterval(() => { void tick() }, ms)
  setTimeout(() => { void tick() }, 40_000)
}

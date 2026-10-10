// ----------------------------------------------------------------
// soldItemAutoRestockScheduler.ts — platform-wide order sync + sold-item restock
// Cadence: every 10 minutes. Discovers all active eBay stores (no WORKSPACE_ID gate).
// ----------------------------------------------------------------

import {
  runSoldItemAutoRestock,
  runSoldItemAutoRestockAllWorkspaces,
} from "./soldItemAutoRestockService"

const LOG = "[SoldItemAutoRestockScheduler]"
const TICK_MS = 10 * 60 * 1000

let schedulerStarted = false
let tickInProgress = false

async function schedulerTick(): Promise<void> {
  if (tickInProgress) {
    console.log(`${LOG} tick skipped — previous run still in progress`)
    return
  }
  tickInProgress = true
  try {
    console.log(`${LOG} tick started (platform-wide)`)
    const result = await runSoldItemAutoRestockAllWorkspaces()
    const summary = result.stores.map((s) => ({
      workspaceId: s.workspaceId,
      storeId:  s.storeId,
      store:    s.storeCode,
      orders:   s.ordersFetched,
      restocked: s.restocked,
      skipped:  s.skipped,
      skipReason: s.skipReason,
      failed:   s.failed,
    }))
    console.log(`${LOG} tick finished stores=${summary.length}`, summary)
  } catch (e) {
    console.error(`${LOG} tick error:`, e instanceof Error ? e.message : String(e))
  } finally {
    tickInProgress = false
  }
}

/** Registers once. Platform tick — all workspaces / exact store_id. */
export function startSoldItemAutoRestockScheduler(): void {
  if (schedulerStarted) return
  schedulerStarted = true
  console.log(`${LOG} started (every ${TICK_MS / 60_000} min, all workspaces)`)

  setInterval(() => {
    void schedulerTick()
  }, TICK_MS)

  // First run shortly after startup (stagger from other schedulers).
  setTimeout(() => {
    void schedulerTick()
  }, 90_000)
}

/** Manual / admin one-shot for a single workspace (optional storeCode filter). */
export async function runSoldItemAutoRestockOnce(
  workspaceId: string,
  storeCode?:  string
) {
  return runSoldItemAutoRestock(workspaceId, storeCode)
}

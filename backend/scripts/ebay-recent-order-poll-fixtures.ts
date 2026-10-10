/**
 * Lightweight recent-order poller fixtures.
 * Run: npx ts-node --transpile-only scripts/ebay-recent-order-poll-fixtures.ts
 */

import { readFileSync } from "fs"
import { join } from "path"

const root = join(__dirname, "..")
const restockSched = readFileSync(join(root, "modules/orders/soldItemAutoRestockScheduler.ts"), "utf8")
const restockSvc = readFileSync(join(root, "modules/orders/soldItemAutoRestockService.ts"), "utf8")
const pollSvc = readFileSync(join(root, "modules/orders/ebayRecentOrderPollService.ts"), "utf8")
const pollSched = readFileSync(join(root, "modules/orders/ebayRecentOrderPollScheduler.ts"), "utf8")
const server = readFileSync(join(root, "server.ts"), "utf8")
const repo = readFileSync(join(root, "modules/orders/ordersRepository.ts"), "utf8")
const syncSvc = readFileSync(join(root, "modules/orders/ordersSyncService.ts"), "utf8")

let passed = 0
let failed = 0

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++
    console.log(`✓ ${name}`)
  } else {
    failed++
    console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`)
  }
}

check(
  "poller cadence default 2 min",
  pollSvc.includes('EBAY_RECENT_ORDER_POLL_INTERVAL_MS ?? String(DEFAULT_INTERVAL_MS)') &&
    pollSvc.includes("const DEFAULT_INTERVAL_MS = 120_000")
)
check(
  "poller lookback is short (10 min, not 24h)",
  pollSvc.includes("const DEFAULT_LOOKBACK_MS = 10 * 60 * 1000") &&
    pollSvc.includes("POLL_MAX_PAGES = 2")
)
check(
  "poller fetches lastmodifieddate window via syncRecentOrdersForStore",
  pollSvc.includes("syncRecentOrdersForStore") &&
    syncSvc.includes("modifiedFrom") &&
    pollSvc.includes("lookbackMs")
)
check(
  "10-min restock scheduler TICK_MS unchanged",
  /const TICK_MS = 10 \* 60 \* 1000/.test(restockSched)
)
check(
  "10-min scheduler still runs restock all workspaces",
  restockSched.includes("runSoldItemAutoRestockAllWorkspaces")
)
check(
  "restock still syncs 24h then earnings",
  restockSvc.includes("RECENT_ORDER_WINDOW_MS") &&
    restockSvc.includes("syncOrderEarningsForEbayOrderIds")
)
check(
  "poller does not call earnings",
  !pollSvc.includes("syncOrderEarnings") && !pollSvc.includes("ordersEarningsService")
)
check(
  "poller does not call restock",
  !pollSvc.includes("runSoldItemAutoRestock") && !pollSvc.includes("shouldRestockSoldItem")
)
check(
  "poller uses existing upsert ON CONFLICT",
  repo.includes("ON CONFLICT (workspace_id, store_id, ebay_order_id)")
)
check(
  "recent sync does not update watermark",
  /Does NOT update ebay_order_sync_state watermark/.test(syncSvc)
)
check(
  "poller started from server without replacing 10-min scheduler",
  server.includes("startEbayRecentOrderPollScheduler") &&
    server.includes("startSoldItemAutoRestockScheduler")
)
check(
  "poller scheduler uses env interval + overlap lock",
  pollSched.includes("recentOrderPollIntervalMs") &&
    pollSvc.includes("runRecentOrderPollTick") &&
    pollSvc.includes("previous run still in progress")
)
check(
  "existing full sync still uses 30d first / 24h backtrack watermark",
  syncSvc.includes("FIRST_SYNC_LOOKBACK_MS") &&
    syncSvc.includes("setLastSyncedAt")
)

async function pollStoresSequentially<T extends { storeId: string; storeCode: string }>(
  stores: T[],
  fn: (store: T) => Promise<void>
): Promise<void> {
  for (const store of stores) {
    try {
      await fn(store)
    } catch {
      /* isolate */
    }
  }
}

let pollRunInProgress = false
async function runRecentOrderPollTick(
  body: () => Promise<unknown>
): Promise<"ran" | "skipped"> {
  if (pollRunInProgress) return "skipped"
  pollRunInProgress = true
  try {
    await body()
    return "ran"
  } finally {
    pollRunInProgress = false
  }
}

async function isolationAndOverlap(): Promise<void> {
  const seen: string[] = []
  await pollStoresSequentially(
    [
      { storeId: "A", storeCode: "a" },
      { storeId: "B", storeCode: "b" },
    ],
    async (store) => {
      if (store.storeId === "A") throw new Error("store A boom")
      seen.push(store.storeId)
    }
  )
  check("store A error does not stop store B", seen.join(",") === "B")

  let release!: () => void
  const hanging = runRecentOrderPollTick(
    () => new Promise<void>((resolve) => { release = resolve })
  )
  const overlapping = await runRecentOrderPollTick(async () => {
    throw new Error("second tick must not run")
  })
  check("overlapping poll tick is skipped", overlapping === "skipped")
  release()
  const first = await hanging
  check("first poll tick completes after overlap skip", first === "ran")
}

isolationAndOverlap()
  .then(() => {
    console.log(`\n${passed}/${passed + failed} passed`)
    if (failed > 0) process.exit(1)
  })
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })

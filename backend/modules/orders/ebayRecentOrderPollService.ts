import { listAllActiveEbayStores } from "./soldItemAutoRestockRepository"
import { syncRecentOrdersForStore } from "./ordersSyncService"

const LOG = "[EbayRecentOrderPoll]"
export const POLL_MAX_PAGES = 2
const DEFAULT_INTERVAL_MS = 120_000
const DEFAULT_LOOKBACK_MS = 10 * 60 * 1000
const MIN_INTERVAL_MS = 30_000
const MIN_LOOKBACK_MS = 60_000

export function recentOrderPollIntervalMs(): number {
  const n = Number.parseInt(process.env.EBAY_RECENT_ORDER_POLL_INTERVAL_MS ?? String(DEFAULT_INTERVAL_MS), 10)
  if (!Number.isFinite(n) || n < MIN_INTERVAL_MS) return DEFAULT_INTERVAL_MS
  return n
}

export function recentOrderLookbackMs(): number {
  const n = Number.parseInt(process.env.EBAY_RECENT_ORDER_LOOKBACK_MS ?? String(DEFAULT_LOOKBACK_MS), 10)
  if (!Number.isFinite(n) || n < MIN_LOOKBACK_MS) return DEFAULT_LOOKBACK_MS
  return n
}

export async function pollStoresSequentially<T extends { storeId: number | string; storeCode: string }>(
  stores: T[],
  fn: (store: T) => Promise<void>
): Promise<void> {
  for (const store of stores) {
    try {
      await fn(store)
    } catch (e) {
      console.warn(
        `${LOG} store_id=${store.storeId} store=${store.storeCode} failed:`,
        e instanceof Error ? e.message : String(e)
      )
    }
  }
}

export async function pollRecentOrdersAllStores(): Promise<{
  stores: number
  lookbackMs: number
}> {
  const lookbackMs = recentOrderLookbackMs()
  const stores = await listAllActiveEbayStores()
  console.log(`${LOG} tick stores=${stores.length} lookbackMs=${lookbackMs}`)
  await pollStoresSequentially(stores, async (store) => {
    const outcome = await syncRecentOrdersForStore(
      store.workspaceId,
      { id: store.storeId, storeCode: store.storeCode, name: store.name },
      lookbackMs,
      POLL_MAX_PAGES
    )
    console.log(`${LOG} store_id=${store.storeId} store=${store.storeCode}`, {
      fetched: outcome.orders.length,
      upserted: outcome.upsertedOrders,
      skipped: outcome.skipped,
      skipReason: outcome.skipReason ?? null,
    })
  })
  return { stores: stores.length, lookbackMs }
}

let pollRunInProgress = false

export async function runRecentOrderPollTick(
  body: () => Promise<unknown> = pollRecentOrdersAllStores
): Promise<"ran" | "skipped"> {
  if (pollRunInProgress) {
    console.log(`${LOG} tick skipped — previous run still in progress`)
    return "skipped"
  }
  pollRunInProgress = true
  try {
    await body()
    return "ran"
  } finally {
    pollRunInProgress = false
  }
}

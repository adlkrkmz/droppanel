import "dotenv/config"
import {
  createStore,
  getStoreCapacity,
  getStoreByCode,
  listStoresByWorkspace
} from "./modules/stores/storeRepository"
import { closeDbPool } from "./db/client"

type SeedStoreInput = {
  name: string
  storeCode: string
}

const TEST_STORES: SeedStoreInput[] = [
  { name: "Test Store S1", storeCode: "S1" },
  { name: "Test Store S2", storeCode: "S2" },
  { name: "Test Store S3", storeCode: "S3" },
  { name: "Test Store S4", storeCode: "S4" }
]

async function ensureStore(workspaceId: string, store: SeedStoreInput) {
  const existing = await getStoreByCode(workspaceId, store.storeCode)

  if (existing) {
    return existing
  }

  return createStore({
    workspaceId,
    name: store.name,
    storeCode: store.storeCode,
    marketplace: "ebay",
    status: "active",
    maxActiveListings: 10000,
    targetActiveListings: 5000,
    dailyListingLimit: 250
  })
}

async function main() {
  const workspaceId = process.env.WORKSPACE_ID

  if (!workspaceId) {
    throw new Error("WORKSPACE_ID is not defined")
  }

  for (const store of TEST_STORES) {
    await ensureStore(workspaceId, store)
  }

  const stores = await listStoresByWorkspace(workspaceId)

  console.log(`\nWORKSPACE_ID: ${workspaceId}`)
  console.log("\n========== STORES ==========")

  if (stores.length === 0) {
    console.log("No stores found.")
  } else {
    console.table(
      stores.map((store: any) => ({
        id: store.id,
        name: store.name,
        store_code: store.store_code,
        marketplace: store.marketplace,
        status: store.status,
        max_active_listings: store.max_active_listings,
        target_active_listings: store.target_active_listings,
        daily_listing_limit: store.daily_listing_limit,
        health_status: store.health_status,
        sync_health: store.sync_health
      }))
    )
  }

  console.log("\n========== STORE CAPACITY ==========")

  const capacities = []
  for (const store of stores) {
    const capacity = await getStoreCapacity(store.id)
    capacities.push(capacity)
  }

  if (capacities.length === 0) {
    console.log("No capacity data found.")
  } else {
    console.table(
      capacities.map((item: any) => ({
        id: item.id,
        name: item.name,
        store_code: item.store_code,
        status: item.status,
        max_active_listings: item.max_active_listings,
        target_active_listings: item.target_active_listings,
        daily_listing_limit: item.daily_listing_limit,
        current_live_count: item.current_live_count,
        remaining_capacity: item.remaining_capacity
      }))
    )
  }
}

main()
  .catch((error) => {
    console.error("Store seed test failed:", error)
    process.exitCode = 1
  })
  .finally(async () => {
    await closeDbPool()
  })
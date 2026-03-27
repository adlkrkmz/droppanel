import "dotenv/config"
import { closeDbPool } from "./db/client"
import { getPreparedListingPayloads } from "./modules/listing/listingPreparationService"

async function main() {
  const workspaceId = process.env.WORKSPACE_ID
  const limit = Number(process.env.LISTING_PREPARATION_LIMIT ?? 100)

  if (!workspaceId) {
    throw new Error("WORKSPACE_ID is not defined")
  }

  const preparedRows = await getPreparedListingPayloads(workspaceId, limit)

  console.log(`\nWORKSPACE_ID: ${workspaceId}`)
  console.log(`LISTING_PREPARATION_LIMIT: ${limit}`)
  console.log("\n========== LISTING PREPARATION PAYLOADS ==========")

  if (preparedRows.length === 0) {
    console.log("No listing preparation records found.")
    return
  }

  console.table(
    preparedRows.map((row) => ({
      pool_id: row.poolId,
      asin_registry_id: row.asinRegistryId,
      asin: row.asin,
      assigned_store_id: row.assignedStoreId,
      store_code: row.storeCode,
      store_name: row.storeName,
      internal_sku: row.internalSku,
      listing_status: row.listingStatus
    }))
  )

  console.log(`Total prepared records: ${preparedRows.length}`)
}

main()
  .catch((error) => {
    console.error("Listing preparation test failed:", error)
    process.exitCode = 1
  })
  .finally(async () => {
    await closeDbPool()
  })
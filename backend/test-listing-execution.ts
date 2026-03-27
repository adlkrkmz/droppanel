import "dotenv/config"
import { closeDbPool, query } from "./db/client"
import { executePreparedListingsSimulation } from "./modules/listing/listingExecutionService"

type ListingHistorySummaryRow = {
  listing_history_id: number
  store_id: number | null
  asin_registry_id: number | null
  internal_sku: string | null
  ebay_item_id: string | null
  ebay_offer_id: string | null
  status: string | null
  listing_job_ref: number | null
  listed_at: string | null
}

type StoreCatalogStateSummaryRow = {
  catalog_state_id: number
  store_id: number
  asin_registry_id: number
  internal_sku: string
  ebay_item_id: string | null
  ebay_offer_id: string | null
  current_status: string
  listed_at: string | null
  last_sync_at: string | null
  source_of_truth: string | null
}

async function listInsertedListingHistory(
  workspaceId: string,
  poolIds: number[]
): Promise<ListingHistorySummaryRow[]> {
  if (poolIds.length === 0) {
    return []
  }

  const sql = `
    SELECT
      id AS listing_history_id,
      store_id,
      asin_registry_id,
      internal_sku,
      ebay_item_id,
      ebay_offer_id,
      status,
      listing_job_ref,
      listed_at
    FROM listing_history
    WHERE workspace_id = $1
      AND listing_job_ref = ANY($2::bigint[])
    ORDER BY id DESC
  `

  const result = await query<ListingHistorySummaryRow>(sql, [workspaceId, poolIds])
  return result.rows
}

async function listTouchedCatalogState(
  workspaceId: string,
  internalSkus: string[]
): Promise<StoreCatalogStateSummaryRow[]> {
  if (internalSkus.length === 0) {
    return []
  }

  const sql = `
    SELECT
      id AS catalog_state_id,
      store_id,
      asin_registry_id,
      internal_sku,
      ebay_item_id,
      ebay_offer_id,
      current_status,
      listed_at,
      last_sync_at,
      source_of_truth
    FROM store_catalog_state
    WHERE workspace_id = $1
      AND internal_sku = ANY($2::text[])
    ORDER BY id DESC
  `

  const result = await query<StoreCatalogStateSummaryRow>(sql, [workspaceId, internalSkus])
  return result.rows
}

async function main() {
  const workspaceId = process.env.WORKSPACE_ID
  const limit = Number(process.env.LISTING_EXECUTION_LIMIT ?? 100)

  if (!workspaceId) {
    throw new Error("WORKSPACE_ID is not defined")
  }

  const executionResult = await executePreparedListingsSimulation(workspaceId, limit)

  console.log(`\nWORKSPACE_ID: ${workspaceId}`)
  console.log(`LISTING_EXECUTION_LIMIT: ${limit}`)
  console.log("\n========== LISTING EXECUTION RESULT ==========")
  console.log(`Processed count: ${executionResult.processedCount}`)

  if (executionResult.rows.length === 0) {
    console.log("No prepared listings found for execution.")
    return
  }

  console.table(
    executionResult.rows.map((row) => ({
      pool_id: row.poolId,
      asin_registry_id: row.asinRegistryId,
      asin: row.asin,
      assigned_store_id: row.assignedStoreId,
      store_code: row.storeCode,
      internal_sku: row.internalSku,
      ebay_item_id: row.ebayItemId,
      ebay_offer_id: row.ebayOfferId,
      pool_status: row.poolStatus,
      listing_status: row.poolListingStatus,
      pipeline_stage: row.poolPipelineStage
    }))
  )

  const poolIds = executionResult.rows.map((row) => row.poolId)
  const internalSkus = executionResult.rows.map((row) => row.internalSku)

  const [listingHistoryRows, catalogStateRows] = await Promise.all([
    listInsertedListingHistory(workspaceId, poolIds),
    listTouchedCatalogState(workspaceId, internalSkus)
  ])

  console.log("\n========== LISTING HISTORY SUMMARY ==========")

  if (listingHistoryRows.length === 0) {
    console.log("No listing_history rows found.")
  } else {
    console.table(
      listingHistoryRows.map((row) => ({
        listing_history_id: row.listing_history_id,
        store_id: row.store_id,
        asin_registry_id: row.asin_registry_id,
        internal_sku: row.internal_sku,
        ebay_item_id: row.ebay_item_id,
        ebay_offer_id: row.ebay_offer_id,
        status: row.status,
        listing_job_ref: row.listing_job_ref,
        listed_at: row.listed_at
      }))
    )
  }

  console.log("\n========== STORE CATALOG STATE SUMMARY ==========")

  if (catalogStateRows.length === 0) {
    console.log("No store_catalog_state rows found.")
  } else {
    console.table(
      catalogStateRows.map((row) => ({
        catalog_state_id: row.catalog_state_id,
        store_id: row.store_id,
        asin_registry_id: row.asin_registry_id,
        internal_sku: row.internal_sku,
        ebay_item_id: row.ebay_item_id,
        ebay_offer_id: row.ebay_offer_id,
        current_status: row.current_status,
        listed_at: row.listed_at,
        last_sync_at: row.last_sync_at,
        source_of_truth: row.source_of_truth
      }))
    )
  }
}

main()
  .catch((error) => {
    console.error("Listing execution test failed:", error)
    process.exitCode = 1
  })
  .finally(async () => {
    await closeDbPool()
  })
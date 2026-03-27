import "dotenv/config"
import { closeDbPool } from "./db/client"
import { fetchSchedulerCandidates } from "./modules/pool/poolRepository"

async function main() {
  const workspaceId = process.env.WORKSPACE_ID
  const limit = Number(process.env.SCHEDULER_LIMIT ?? 50)

  if (!workspaceId) {
    throw new Error("WORKSPACE_ID is not defined")
  }

  const candidates = await fetchSchedulerCandidates(workspaceId, limit)

  console.log(`\nWORKSPACE_ID: ${workspaceId}`)
  console.log(`SCHEDULER_LIMIT: ${limit}`)
  console.log("\n========== SCHEDULER CANDIDATES ==========")

  if (candidates.length === 0) {
    console.log("No scheduler candidates found.")
    return
  }

  console.table(
    candidates.map((row: any) => ({
      id: row.id,
      asin_registry_id: row.asin_registry_id,
      asin: row.asin,
      global_status: row.global_status,
      status: row.status,
      pipeline_stage: row.pipeline_stage,
      priority: row.priority,
      assigned_store_id: row.assigned_store_id,
      import_batch_id: row.import_batch_id,
      scrape_status: row.scrape_status,
      ai_status: row.ai_status,
      listing_status: row.listing_status,
      created_at: row.created_at
    }))
  )

  console.log(`Total candidates: ${candidates.length}`)
}

main()
  .catch((error) => {
    console.error("Scheduler candidates test failed:", error)
    process.exitCode = 1
  })
  .finally(async () => {
    await closeDbPool()
  })
import "dotenv/config"
import { closeDbPool } from "./db/client"
import { assignValidatedPoolEntriesToStores } from "./modules/assignment/assignmentService"

async function main() {
  const workspaceId = process.env.WORKSPACE_ID
  const limit = Number(process.env.ASSIGNMENT_LIMIT ?? 100)

  if (!workspaceId) {
    throw new Error("WORKSPACE_ID is not defined")
  }

  const assignments = await assignValidatedPoolEntriesToStores(workspaceId, limit)

  console.log(`\nWORKSPACE_ID: ${workspaceId}`)
  console.log(`ASSIGNMENT_LIMIT: ${limit}`)
  console.log("\n========== STORE ASSIGNMENTS ==========")

  if (assignments.length === 0) {
    console.log("No assignments created.")
    return
  }

  console.table(
    assignments.map((row) => ({
      pool_id: row.poolId,
      asin_registry_id: row.asinRegistryId,
      asin: row.asin,
      assigned_store_id: row.assignedStoreId,
      assigned_store_code: row.assignedStoreCode,
      assigned_store_name: row.assignedStoreName
    }))
  )

  console.log(`Total assigned: ${assignments.length}`)
}

main()
  .catch((error) => {
    console.error("Store assignment test failed:", error)
    process.exitCode = 1
  })
  .finally(async () => {
    await closeDbPool()
  })
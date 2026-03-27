import "dotenv/config"
import { closeDbPool, query } from "./db/client"

type AssignmentInspectRow = {
  pool_id: number
  asin_registry_id: number
  asin: string
  assigned_store_id: number
  store_code: string
  pipeline_stage: string
  status: string
}

async function listAssignedPoolRows(workspaceId: string): Promise<AssignmentInspectRow[]> {
  const sql = `
    SELECT
      ap.id AS pool_id,
      ap.asin_registry_id,
      ar.asin,
      ap.assigned_store_id,
      s.store_code,
      ap.pipeline_stage,
      ap.status
    FROM asin_pool ap
    INNER JOIN asin_registry ar
      ON ar.id = ap.asin_registry_id
    INNER JOIN stores s
      ON s.id = ap.assigned_store_id
    WHERE ap.workspace_id = $1
      AND ap.assigned_store_id IS NOT NULL
    ORDER BY ap.id DESC
  `

  const result = await query<AssignmentInspectRow>(sql, [workspaceId])
  return result.rows
}

async function main() {
  const workspaceId = process.env.WORKSPACE_ID

  if (!workspaceId) {
    throw new Error("WORKSPACE_ID is not defined")
  }

  const rows = await listAssignedPoolRows(workspaceId)

  console.log(`\nWORKSPACE_ID: ${workspaceId}`)
  console.log("\n========== ASSIGNED POOL ROWS ==========")

  if (rows.length === 0) {
    console.log("No assigned asin_pool rows found.")
    return
  }

  console.table(
    rows.map((row) => ({
      pool_id: row.pool_id,
      asin_registry_id: row.asin_registry_id,
      asin: row.asin,
      assigned_store_id: row.assigned_store_id,
      store_code: row.store_code,
      pipeline_stage: row.pipeline_stage,
      status: row.status
    }))
  )

  console.log(`Total assigned rows: ${rows.length}`)
}

main()
  .catch((error) => {
    console.error("Assignment inspect test failed:", error)
    process.exitCode = 1
  })
  .finally(async () => {
    await closeDbPool()
  })
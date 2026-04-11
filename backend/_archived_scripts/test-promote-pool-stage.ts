import "dotenv/config"
import { closeDbPool, query } from "./db/client"

type PromotionResultRow = {
  id: number
  asin_registry_id: number
  status: string
  pipeline_stage: string
  updated_at: string
}

async function promoteReadyPoolEntriesToValidated(workspaceId: string) {
  const sql = `
    UPDATE asin_pool
    SET pipeline_stage = 'validated',
        updated_at = NOW()
    WHERE workspace_id = $1
      AND status = 'ready'
      AND pipeline_stage <> 'validated'
    RETURNING
      id,
      asin_registry_id,
      status,
      pipeline_stage,
      updated_at
  `

  const result = await query<PromotionResultRow>(sql, [workspaceId])

  return {
    updatedCount: result.rows.length,
    rows: result.rows
  }
}

async function main() {
  const workspaceId = process.env.WORKSPACE_ID

  if (!workspaceId) {
    throw new Error("WORKSPACE_ID is not defined")
  }

  const promotionResult = await promoteReadyPoolEntriesToValidated(workspaceId)

  console.log(`\nWORKSPACE_ID: ${workspaceId}`)
  console.log("\n========== POOL STAGE PROMOTION ==========")
  console.log(`Updated rows: ${promotionResult.updatedCount}`)

  if (promotionResult.rows.length === 0) {
    console.log("No eligible asin_pool rows found.")
    return
  }

  console.table(
    promotionResult.rows.map((row) => ({
      id: row.id,
      asin_registry_id: row.asin_registry_id,
      status: row.status,
      pipeline_stage: row.pipeline_stage,
      updated_at: row.updated_at
    }))
  )
}

main()
  .catch((error) => {
    console.error("Pool stage promotion test failed:", error)
    process.exitCode = 1
  })
  .finally(async () => {
    await closeDbPool()
  })
import "dotenv/config"
import { closeDbPool, query } from "./db/client"

type AsinRegistryRow = {
  id: number
  workspace_id: string
  asin: string
  brand: string | null
  title: string | null
  global_status: string
  first_seen_at: string
  created_at: string
  updated_at: string
}

type AsinPoolRow = {
  id: number
  workspace_id: string
  asin_registry_id: number
  import_batch_id: number | null
  status: string
  assigned_store_id: number | null
  scheduler_profile_id: number | null
  priority: number
  skip_reason: string | null
  scrape_status: string
  ai_status: string
  listing_status: string
  pipeline_stage: string
  created_at: string
  updated_at: string
}

type ImportBatchRow = {
  id: number
  workspace_id: string
  source_type: string | null
  source_name: string | null
  uploaded_by: string | null
  total_rows: number | null
  valid_rows: number | null
  ready_count: number | null
  duplicate_pool_count: number | null
  already_live_count: number | null
  blacklist_count: number | null
  cooldown_count: number | null
  invalid_count: number | null
  scrape_failed_count: number | null
  created_at: string
  updated_at: string
}

async function listAsinRegistry(workspaceId: string): Promise<AsinRegistryRow[]> {
  const sql = `
    SELECT
      id,
      workspace_id,
      asin,
      brand,
      title,
      global_status,
      first_seen_at,
      created_at,
      updated_at
    FROM asin_registry
    WHERE workspace_id = $1
    ORDER BY id DESC
  `

  const result = await query<AsinRegistryRow>(sql, [workspaceId])
  return result.rows
}

async function listAsinPool(workspaceId: string): Promise<AsinPoolRow[]> {
  const sql = `
    SELECT
      id,
      workspace_id,
      asin_registry_id,
      import_batch_id,
      status,
      assigned_store_id,
      scheduler_profile_id,
      priority,
      skip_reason,
      scrape_status,
      ai_status,
      listing_status,
      pipeline_stage,
      created_at,
      updated_at
    FROM asin_pool
    WHERE workspace_id = $1
    ORDER BY id DESC
  `

  const result = await query<AsinPoolRow>(sql, [workspaceId])
  return result.rows
}

async function listImportBatches(workspaceId: string): Promise<ImportBatchRow[]> {
  const sql = `
    SELECT
      id,
      workspace_id,
      source_type,
      source_name,
      uploaded_by,
      total_rows,
      valid_rows,
      ready_count,
      duplicate_pool_count,
      already_live_count,
      blacklist_count,
      cooldown_count,
      invalid_count,
      scrape_failed_count,
      created_at,
      updated_at
    FROM import_batches
    WHERE workspace_id = $1
    ORDER BY id DESC
  `

  const result = await query<ImportBatchRow>(sql, [workspaceId])
  return result.rows
}

function printSection(title: string, rows: unknown[]) {
  console.log(`\n========== ${title} ==========`)

  if (rows.length === 0) {
    console.log("No records found.")
    return
  }

  console.table(rows)
  console.log(`Total: ${rows.length}`)
}

async function main() {
  const workspaceId = process.env.WORKSPACE_ID

  if (!workspaceId) {
    throw new Error("WORKSPACE_ID is not defined")
  }

  const [registryRows, poolRows, batchRows] = await Promise.all([
    listAsinRegistry(workspaceId),
    listAsinPool(workspaceId),
    listImportBatches(workspaceId)
  ])

  console.log(`\nWORKSPACE_ID: ${workspaceId}`)

  printSection("ASIN REGISTRY", registryRows)
  printSection("ASIN POOL", poolRows)
  printSection("IMPORT BATCHES", batchRows)
}

main()
  .catch((error) => {
    console.error("Inspection failed:", error)
    process.exitCode = 1
  })
  .finally(async () => {
    await closeDbPool()
  })
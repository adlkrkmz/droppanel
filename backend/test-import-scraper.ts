import "dotenv/config"
import { closeDbPool, query } from "./db/client"
import { runAmazonScraperSimulation } from "./modules/scraper/amazonScraperService"

const TEST_WORKSPACE_ID = "00000000-0000-0000-0000-000000000001"
const TEST_POOL_ID = 1
const TEST_REGISTRY_ID = 2
const TEST_ASIN = "B0C1234567"

type PoolSeedRow = {
  id: number
}

type RegistrySeedRow = {
  id: number
}

async function ensureWorkspace(workspaceId: string): Promise<void> {
  const sql = `
    INSERT INTO workspaces (id, name, created_at, updated_at)
    VALUES ($1, 'Test Workspace', NOW(), NOW())
    ON CONFLICT (id) DO NOTHING
  `
  await query(sql, [workspaceId])
}

async function ensureRegistryEntry(): Promise<void> {
  const sql = `
    INSERT INTO asin_registry (
      id,
      workspace_id,
      asin,
      brand,
      title,
      global_status,
      first_seen_at,
      created_at,
      updated_at
    )
    VALUES (
      $1, $2, $3, NULL, NULL, 'active', NOW(), NOW(), NOW()
    )
    ON CONFLICT (id) DO UPDATE SET
      workspace_id = EXCLUDED.workspace_id,
      asin = EXCLUDED.asin,
      updated_at = NOW()
  `
  await query(sql, [TEST_REGISTRY_ID, TEST_WORKSPACE_ID, TEST_ASIN])
}

async function ensurePoolEntry(): Promise<void> {
  const sql = `
    INSERT INTO asin_pool (
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
    )
    VALUES (
      $1, $2, $3, NULL, 'ready', NULL, NULL, 0, NULL,
      'pending', 'pending', 'pending', 'validated', NOW(), NOW()
    )
    ON CONFLICT (id) DO UPDATE SET
      workspace_id = EXCLUDED.workspace_id,
      asin_registry_id = EXCLUDED.asin_registry_id,
      status = 'ready',
      scrape_status = 'pending',
      pipeline_stage = 'validated',
      updated_at = NOW()
  `
  await query(sql, [TEST_POOL_ID, TEST_WORKSPACE_ID, TEST_REGISTRY_ID])
}

async function inspectRegistry(): Promise<RegistrySeedRow | null> {
  const sql = `
    SELECT id
    FROM asin_registry
    WHERE id = $1
    LIMIT 1
  `
  const result = await query<RegistrySeedRow>(sql, [TEST_REGISTRY_ID])
  return result.rows[0] ?? null
}

async function inspectPool(): Promise<PoolSeedRow | null> {
  const sql = `
    SELECT id
    FROM asin_pool
    WHERE id = $1
    LIMIT 1
  `
  const result = await query<PoolSeedRow>(sql, [TEST_POOL_ID])
  return result.rows[0] ?? null
}

async function main(): Promise<void> {
  await ensureWorkspace(TEST_WORKSPACE_ID)
  await ensureRegistryEntry()
  await ensurePoolEntry()

  const registryRow = await inspectRegistry()
  const poolRow = await inspectPool()

  console.log("\n========== TEST FIXTURE CHECK ==========")
  console.table([
    {
      workspace_id: TEST_WORKSPACE_ID,
      registry_id_exists: Boolean(registryRow),
      pool_id_exists: Boolean(poolRow),
      test_asin: TEST_ASIN
    }
  ])

  const result = await runAmazonScraperSimulation(TEST_WORKSPACE_ID, 10)

  console.log("\n========== IMPORT SCRAPER SIMULATION RESULT ==========")
  console.log(`Processed count: ${result.processedCount}`)

  if (result.rows.length === 0) {
    console.log("No candidates processed.")
    return
  }

  console.table(
    result.rows.map((row) => ({
      pool_id: row.poolId,
      asin_registry_id: row.asinRegistryId,
      asin: row.asin,
      title: row.title,
      brand: row.brand,
      price: row.price,
      scrape_status: row.scrapeStatus,
      pipeline_stage: row.pipelineStage
    }))
  )
}

main()
  .catch((error: unknown) => {
    console.error("test-import-scraper failed:", error)
    process.exitCode = 1
  })
  .finally(async () => {
    await closeDbPool()
  })
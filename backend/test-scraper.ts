import "dotenv/config"
import { closeDbPool, query } from "./db/client"
import { runAmazonScraperSimulation } from "./modules/scraper/amazonScraperService"

const TEST_WORKSPACE_ID = "00000000-0000-0000-0000-000000000001"
const TEST_POOL_ID = 1
const TEST_REGISTRY_ID = 2
const TEST_ASIN = "B0C1234567"

type CacheInspectRow = {
  asin_registry_id: number
  title: string | null
  brand: string | null
  price: number | null
  images: unknown
  attributes: unknown
  updated_at: string
}

type PoolInspectRow = {
  id: number
  asin_registry_id: number
  scrape_status: string
  pipeline_stage: string
  updated_at: string
}

type RegistryInspectRow = {
  id: number
  asin: string
  brand: string | null
  title: string | null
  updated_at: string
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

async function listWrittenAmazonCache(
  asinRegistryIds: number[]
): Promise<CacheInspectRow[]> {
  if (asinRegistryIds.length === 0) {
    return []
  }

  const sql = `
    SELECT
      asin_registry_id,
      title,
      brand,
      price,
      images,
      attributes,
      updated_at
    FROM amazon_product_cache
    WHERE asin_registry_id = ANY($1::bigint[])
    ORDER BY asin_registry_id ASC
  `

  const result = await query<CacheInspectRow>(sql, [asinRegistryIds])
  return result.rows
}

async function listUpdatedPoolRows(poolIds: number[]): Promise<PoolInspectRow[]> {
  if (poolIds.length === 0) {
    return []
  }

  const sql = `
    SELECT
      id,
      asin_registry_id,
      scrape_status,
      pipeline_stage,
      updated_at
    FROM asin_pool
    WHERE id = ANY($1::bigint[])
    ORDER BY id ASC
  `

  const result = await query<PoolInspectRow>(sql, [poolIds])
  return result.rows
}

async function listUpdatedRegistryRows(registryIds: number[]): Promise<RegistryInspectRow[]> {
  if (registryIds.length === 0) {
    return []
  }

  const sql = `
    SELECT
      id,
      asin,
      brand,
      title,
      updated_at
    FROM asin_registry
    WHERE id = ANY($1::bigint[])
    ORDER BY id ASC
  `

  const result = await query<RegistryInspectRow>(sql, [registryIds])
  return result.rows
}

function getJsonArrayLength(value: unknown): number | null {
  if (Array.isArray(value)) {
    return value.length
  }

  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value)
      return Array.isArray(parsed) ? parsed.length : null
    } catch {
      return null
    }
  }

  return null
}

async function main(): Promise<void> {
  const workspaceId = process.env.WORKSPACE_ID ?? TEST_WORKSPACE_ID
  const limit = Number(process.env.SCRAPER_LIMIT ?? 100)

  await ensureWorkspace(TEST_WORKSPACE_ID)
  await ensureRegistryEntry()
  await ensurePoolEntry()

  const result = await runAmazonScraperSimulation(workspaceId, limit)

  console.log(`\nWORKSPACE_ID: ${workspaceId}`)
  console.log(`SCRAPER_LIMIT: ${limit}`)
  console.log("\n========== SCRAPER SIMULATION RESULT ==========")
  console.log(`Processed count: ${result.processedCount}`)

  if (result.rows.length === 0) {
    console.log("No pending scrape candidates found.")
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

  const asinRegistryIds = result.rows.map((row) => row.asinRegistryId)
  const poolIds = result.rows.map((row) => row.poolId)

  const [cacheRows, poolRows, registryRows] = await Promise.all([
    listWrittenAmazonCache(asinRegistryIds),
    listUpdatedPoolRows(poolIds),
    listUpdatedRegistryRows(asinRegistryIds)
  ])

  console.log("\n========== AMAZON PRODUCT CACHE ==========")

  if (cacheRows.length === 0) {
    console.log("No amazon_product_cache rows found.")
  } else {
    console.table(
      cacheRows.map((row) => ({
        asin_registry_id: row.asin_registry_id,
        title: row.title,
        brand: row.brand,
        price: row.price,
        image_count: getJsonArrayLength(row.images),
        attributes: typeof row.attributes === "string" ? row.attributes : JSON.stringify(row.attributes),
        updated_at: row.updated_at
      }))
    )
  }

  console.log("\n========== UPDATED ASIN POOL ROWS ==========")

  if (poolRows.length === 0) {
    console.log("No asin_pool rows found.")
  } else {
    console.table(
      poolRows.map((row) => ({
        pool_id: row.id,
        asin_registry_id: row.asin_registry_id,
        scrape_status: row.scrape_status,
        pipeline_stage: row.pipeline_stage,
        updated_at: row.updated_at
      }))
    )
  }

  console.log("\n========== UPDATED ASIN REGISTRY ROWS ==========")

  if (registryRows.length === 0) {
    console.log("No asin_registry rows found.")
  } else {
    console.table(
      registryRows.map((row) => ({
        registry_id: row.id,
        asin: row.asin,
        brand: row.brand,
        title: row.title,
        updated_at: row.updated_at
      }))
    )
  }
}

main()
  .catch((error: unknown) => {
    console.error("Scraper simulation test failed:", error)
    process.exitCode = 1
  })
  .finally(async () => {
    await closeDbPool()
  })
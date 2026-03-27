import "dotenv/config"
import { closeDbPool, query } from "./db/client"
import { runAiListingGeneration } from "./modules/ai/aiListingService"

const TEST_WORKSPACE_ID = "00000000-0000-0000-0000-000000000001"
const TEST_POOL_ID = 1
const TEST_REGISTRY_ID = 2
const TEST_ASIN = "B0C1234567"

type CacheInspectRow = {
  id: number
  workspace_id: string
  asin_registry_id: number
  title: string | null
  description: string | null
  bullets: unknown
  generated_at: string
  updated_at: string
}

type PoolInspectRow = {
  id: number
  asin_registry_id: number
  ai_status: string
  scrape_status: string
  pipeline_stage: string
  status: string
  updated_at: string
}

type QueueInspectRow = {
  pool_id: number
  asin_registry_id: number
  asin: string
  ai_status: string
  scrape_status: string
  pipeline_stage: string
  status: string
}

async function ensureWorkspace(): Promise<void> {
  const sql = `
    INSERT INTO workspaces (id, name, created_at, updated_at)
    VALUES ($1, 'Test Workspace', NOW(), NOW())
    ON CONFLICT (id) DO NOTHING
  `
  await query(sql, [TEST_WORKSPACE_ID])
}

async function ensureRegistryFixture(): Promise<void> {
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
      $1, $2, $3, 'Brand-B0C1', 'Simulated Amazon Product for B0C1234567',
      'active', NOW(), NOW(), NOW()
    )
    ON CONFLICT (id)
    DO UPDATE SET
      workspace_id = EXCLUDED.workspace_id,
      asin = EXCLUDED.asin,
      brand = EXCLUDED.brand,
      title = EXCLUDED.title,
      global_status = 'active',
      updated_at = NOW()
  `
  await query(sql, [TEST_REGISTRY_ID, TEST_WORKSPACE_ID, TEST_ASIN])
}

async function ensureAmazonCacheFixture(): Promise<void> {
  const sql = `
    INSERT INTO amazon_product_cache (
      asin_registry_id,
      title,
      brand,
      price,
      images,
      attributes,
      updated_at
    )
    VALUES (
      $1,
      'Simulated Amazon Product for B0C1234567',
      'Brand-B0C1',
      39.90,
      $2::jsonb,
      $3::jsonb,
      NOW()
    )
    ON CONFLICT (asin_registry_id)
    DO UPDATE SET
      title = EXCLUDED.title,
      brand = EXCLUDED.brand,
      price = EXCLUDED.price,
      images = EXCLUDED.images,
      attributes = EXCLUDED.attributes,
      updated_at = NOW()
  `

  const images = JSON.stringify([
    "https://example.com/images/B0C1234567-1.jpg",
    "https://example.com/images/B0C1234567-2.jpg"
  ])

  const attributes = JSON.stringify({
    asin: TEST_ASIN,
    color: "Black",
    material: "ABS",
    source: "simulation"
  })

  await query(sql, [TEST_REGISTRY_ID, images, attributes])
}

async function ensurePoolFixture(): Promise<void> {
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
      'success', 'pending', 'pending', 'scraped', NOW(), NOW()
    )
    ON CONFLICT (id)
    DO UPDATE SET
      workspace_id = EXCLUDED.workspace_id,
      asin_registry_id = EXCLUDED.asin_registry_id,
      status = 'ready',
      scrape_status = 'success',
      ai_status = 'pending',
      pipeline_stage = 'scraped',
      updated_at = NOW()
  `
  await query(sql, [TEST_POOL_ID, TEST_WORKSPACE_ID, TEST_REGISTRY_ID])
}

async function resetFixtureForSingleTest(): Promise<void> {
  await ensureWorkspace()
  await ensureRegistryFixture()
  await ensureAmazonCacheFixture()
  await ensurePoolFixture()
}

async function inspectAiListingCache(
  workspaceId: string,
  asinRegistryId: number
): Promise<CacheInspectRow | null> {
  const sql = `
    SELECT
      id,
      workspace_id,
      asin_registry_id,
      title,
      description,
      bullets,
      generated_at,
      updated_at
    FROM ai_listing_cache
    WHERE workspace_id = $1
      AND asin_registry_id = $2
    LIMIT 1
  `

  const result = await query<CacheInspectRow>(sql, [workspaceId, asinRegistryId])
  return result.rows[0] ?? null
}

async function inspectPool(poolId: number): Promise<PoolInspectRow | null> {
  const sql = `
    SELECT
      id,
      asin_registry_id,
      ai_status,
      scrape_status,
      pipeline_stage,
      status,
      updated_at
    FROM asin_pool
    WHERE id = $1
    LIMIT 1
  `

  const result = await query<PoolInspectRow>(sql, [poolId])
  return result.rows[0] ?? null
}

async function inspectAiQueueCandidates(
  workspaceId: string
): Promise<QueueInspectRow[]> {
  const sql = `
    SELECT
      ap.id AS pool_id,
      ap.asin_registry_id,
      ar.asin,
      ap.ai_status,
      ap.scrape_status,
      ap.pipeline_stage,
      ap.status
    FROM asin_pool ap
    INNER JOIN asin_registry ar
      ON ar.id = ap.asin_registry_id
    WHERE ap.workspace_id = $1
      AND ap.status = 'ready'
      AND ap.scrape_status = 'success'
    ORDER BY ap.id ASC
  `

  const result = await query<QueueInspectRow>(sql, [workspaceId])
  return result.rows
}

function stringifyBullets(value: unknown): string {
  if (Array.isArray(value)) {
    return JSON.stringify(value)
  }

  if (typeof value === "string") {
    return value
  }

  return JSON.stringify(value)
}

async function main(): Promise<void> {
  const workspaceId = process.env.WORKSPACE_ID ?? TEST_WORKSPACE_ID
  const limit = Number(process.env.AI_LIMIT ?? 100)

  await resetFixtureForSingleTest()

  const queueCandidatesBefore = await inspectAiQueueCandidates(workspaceId)

  console.log(`\nWORKSPACE_ID: ${workspaceId}`)
  console.log(`AI_LIMIT: ${limit}`)
  console.log("\n========== AI QUEUE CANDIDATES BEFORE ==========")

  if (queueCandidatesBefore.length === 0) {
    console.log("No queue candidates found before generation.")
  } else {
    console.table(
      queueCandidatesBefore.map((row) => ({
        pool_id: row.pool_id,
        asin_registry_id: row.asin_registry_id,
        asin: row.asin,
        ai_status: row.ai_status,
        scrape_status: row.scrape_status,
        pipeline_stage: row.pipeline_stage,
        status: row.status
      }))
    )
  }

  const result = await runAiListingGeneration(workspaceId, limit)

  console.log("\n========== AI GENERATION RESULT ==========")
  console.log(`Processed count: ${result.processedCount}`)

  if (result.rows.length === 0) {
    console.log("No AI candidates processed.")
  } else {
    console.table(
      result.rows.map((row) => ({
        pool_id: row.poolId,
        asin_registry_id: row.asinRegistryId,
        asin: row.asin,
        title: row.title,
        ai_status: row.aiStatus,
        pipeline_stage: row.pipelineStage
      }))
    )
  }

  const poolRow = await inspectPool(TEST_POOL_ID)
  const cacheRow = await inspectAiListingCache(TEST_WORKSPACE_ID, TEST_REGISTRY_ID)
  const queueCandidatesAfter = await inspectAiQueueCandidates(workspaceId)

  console.log("\n========== TEST POOL ROW AFTER ==========")

  if (!poolRow) {
    console.log("Pool row not found.")
  } else {
    console.table([
      {
        pool_id: poolRow.id,
        asin_registry_id: poolRow.asin_registry_id,
        ai_status: poolRow.ai_status,
        scrape_status: poolRow.scrape_status,
        pipeline_stage: poolRow.pipeline_stage,
        status: poolRow.status,
        updated_at: poolRow.updated_at
      }
    ])
  }

  console.log("\n========== AI LISTING CACHE ROW ==========")

  if (!cacheRow) {
    console.log("AI listing cache row not found.")
  } else {
    console.table([
      {
        cache_id: cacheRow.id,
        workspace_id: cacheRow.workspace_id,
        asin_registry_id: cacheRow.asin_registry_id,
        title: cacheRow.title,
        description_preview: (cacheRow.description ?? "").slice(0, 120),
        bullets: stringifyBullets(cacheRow.bullets),
        generated_at: cacheRow.generated_at,
        updated_at: cacheRow.updated_at
      }
    ])
  }

  console.log("\n========== AI QUEUE CANDIDATES AFTER ==========")

  if (queueCandidatesAfter.length === 0) {
    console.log("No queue candidates found after generation.")
  } else {
    console.table(
      queueCandidatesAfter.map((row) => ({
        pool_id: row.pool_id,
        asin_registry_id: row.asin_registry_id,
        asin: row.asin,
        ai_status: row.ai_status,
        scrape_status: row.scrape_status,
        pipeline_stage: row.pipeline_stage,
        status: row.status
      }))
    )
  }
}

main()
  .catch((error: unknown) => {
    console.error("test-ai-generator failed:", error)
    process.exitCode = 1
  })
  .finally(async () => {
    await closeDbPool()
  })
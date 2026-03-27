import { query } from "../../db/client"
import type {
  AiGenerationCandidateRow,
  GeneratedListingContent
} from "./aiTypes"

type DbClient = {
  query: <T = unknown>(
    text: string,
    params?: unknown[]
  ) => Promise<{ rows: T[]; rowCount: number | null }>
}

export async function getAiGenerationCandidates(
  workspaceId: string,
  limit: number
): Promise<AiGenerationCandidateRow[]> {
  const sql = `
    SELECT
      ap.id AS "poolId",
      ap.workspace_id AS "workspaceId",
      ap.asin_registry_id AS "asinRegistryId",
      ar.asin AS "asin",
      ar.brand AS "brand",
      ar.title AS "productTitle",
      apc.title AS "cacheTitle",
      apc.brand AS "cacheBrand",
      apc.price AS "price",
      apc.images AS "images",
      apc.attributes AS "attributes"
    FROM asin_pool ap
    INNER JOIN asin_registry ar
      ON ar.id = ap.asin_registry_id
    LEFT JOIN amazon_product_cache apc
      ON apc.asin_registry_id = ap.asin_registry_id
    WHERE ap.workspace_id = $1
      AND ap.status = 'ready'
      AND ap.scrape_status = 'success'
      AND ap.ai_status = 'pending'
      AND ap.pipeline_stage = 'scraped'
    ORDER BY ap.priority DESC, ap.id ASC
    LIMIT $2
  `

  const result = await query<AiGenerationCandidateRow>(sql, [workspaceId, limit])
  return result.rows
}

export async function getAiGenerationCandidateByPoolId(
  workspaceId: string,
  poolId: number
): Promise<AiGenerationCandidateRow | null> {
  const sql = `
    SELECT
      ap.id AS "poolId",
      ap.workspace_id AS "workspaceId",
      ap.asin_registry_id AS "asinRegistryId",
      ar.asin AS "asin",
      ar.brand AS "brand",
      ar.title AS "productTitle",
      apc.title AS "cacheTitle",
      apc.brand AS "cacheBrand",
      apc.price AS "price",
      apc.images AS "images",
      apc.attributes AS "attributes"
    FROM asin_pool ap
    INNER JOIN asin_registry ar
      ON ar.id = ap.asin_registry_id
    LEFT JOIN amazon_product_cache apc
      ON apc.asin_registry_id = ap.asin_registry_id
    WHERE ap.workspace_id = $1
      AND ap.id = $2
    LIMIT 1
  `

  const result = await query<AiGenerationCandidateRow>(sql, [workspaceId, poolId])
  return result.rows[0] ?? null
}

export async function upsertAiListingCache(
  client: DbClient,
  workspaceId: string,
  asinRegistryId: number,
  listing: GeneratedListingContent
): Promise<void> {
  const sql = `
    INSERT INTO ai_listing_cache (
      workspace_id,
      asin_registry_id,
      title,
      description,
      bullets,
      generated_at,
      created_at,
      updated_at
    )
    VALUES ($1, $2, $3, $4, $5::jsonb, NOW(), NOW(), NOW())
    ON CONFLICT (workspace_id, asin_registry_id)
    DO UPDATE SET
      title = EXCLUDED.title,
      description = EXCLUDED.description,
      bullets = EXCLUDED.bullets,
      generated_at = NOW(),
      updated_at = NOW()
  `

  await client.query(sql, [
    workspaceId,
    asinRegistryId,
    listing.title,
    listing.description,
    JSON.stringify(listing.bullets)
  ])
}

export async function markPoolAiSuccess(
  client: DbClient,
  poolId: number
): Promise<void> {
  const sql = `
    UPDATE asin_pool
    SET ai_status = 'success',
        pipeline_stage = 'ai_generated',
        updated_at = NOW()
    WHERE id = $1
  `

  await client.query(sql, [poolId])
}

export async function markPoolAiFailed(
  client: DbClient,
  poolId: number
): Promise<void> {
  const sql = `
    UPDATE asin_pool
    SET ai_status = 'failed',
        updated_at = NOW()
    WHERE id = $1
  `

  await client.query(sql, [poolId])
}
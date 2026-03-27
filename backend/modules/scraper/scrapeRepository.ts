import { query } from "../../db/client"
import {
  FakeScrapedData,
  PendingScrapeCandidateRow
} from "./scraperTypes"

type DbClient = {
  query: <T = unknown>(text: string, params?: unknown[]) => Promise<{ rows: T[]; rowCount: number | null }>
}

export async function getPendingScrapeCandidates(
  workspaceId: string,
  limit: number
): Promise<PendingScrapeCandidateRow[]> {
  const sql = `
    SELECT
      ap.id AS "poolId",
      ap.asin_registry_id AS "asinRegistryId",
      ar.asin AS "asin",
      ap.workspace_id AS "workspaceId"
    FROM asin_pool ap
    INNER JOIN asin_registry ar
      ON ar.id = ap.asin_registry_id
    WHERE ap.workspace_id = $1
      AND ap.status = 'ready'
      AND ap.pipeline_stage = 'validated'
      AND ap.scrape_status = 'pending'
    ORDER BY ap.priority DESC, ap.id ASC
    LIMIT $2
  `

  const result = await query<PendingScrapeCandidateRow>(sql, [workspaceId, limit])
  return result.rows
}

export async function getScrapeCandidateByPoolId(
  workspaceId: string,
  poolId: number
): Promise<PendingScrapeCandidateRow | null> {
  const sql = `
    SELECT
      ap.id AS "poolId",
      ap.asin_registry_id AS "asinRegistryId",
      ar.asin AS "asin",
      ap.workspace_id AS "workspaceId"
    FROM asin_pool ap
    INNER JOIN asin_registry ar
      ON ar.id = ap.asin_registry_id
    WHERE ap.workspace_id = $1
      AND ap.id = $2
    LIMIT 1
  `

  const result = await query<PendingScrapeCandidateRow>(sql, [workspaceId, poolId])
  return result.rows[0] ?? null
}

export async function upsertAmazonProductCache(
  client: DbClient,
  asinRegistryId: number,
  data: FakeScrapedData
): Promise<void> {
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
    VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, NOW())
    ON CONFLICT (asin_registry_id)
    DO UPDATE SET
      title = EXCLUDED.title,
      brand = EXCLUDED.brand,
      price = EXCLUDED.price,
      images = EXCLUDED.images,
      attributes = EXCLUDED.attributes,
      updated_at = NOW()
  `

  await client.query(sql, [
    asinRegistryId,
    data.title,
    data.brand,
    data.price,
    JSON.stringify(data.images),
    JSON.stringify(data.attributes)
  ])
}

export async function updateAsinRegistryMetadata(
  client: DbClient,
  asinRegistryId: number,
  data: Pick<FakeScrapedData, "title" | "brand">
): Promise<void> {
  const sql = `
    UPDATE asin_registry
    SET title = $2,
        brand = $3,
        updated_at = NOW()
    WHERE id = $1
  `

  await client.query(sql, [asinRegistryId, data.title, data.brand])
}

export async function markPoolAsScraped(
  client: DbClient,
  poolId: number
): Promise<void> {
  const sql = `
    UPDATE asin_pool
    SET scrape_status = 'success',
        pipeline_stage = 'scraped',
        updated_at = NOW()
    WHERE id = $1
  `

  await client.query(sql, [poolId])
}
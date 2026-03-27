import { query } from "../../db/client"

export type CreateAsinPoolInput = {
  workspaceId: string
  asinRegistryId: number
  importBatchId?: number | null
  assignedStoreId?: number | null
  schedulerProfileId?: number | null
  priority?: number
  status?: string
  scrapeStatus?: string
  aiStatus?: string
  listingStatus?: string
  pipelineStage?: string
  skipReason?: string | null
}

export async function createAsinPoolEntry(input: CreateAsinPoolInput) {
  const sql = `
    INSERT INTO asin_pool (
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
      pipeline_stage
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    RETURNING *
  `

  const result = await query(sql, [
    input.workspaceId,
    input.asinRegistryId,
    input.importBatchId ?? null,
    input.status ?? "ready",
    input.assignedStoreId ?? null,
    input.schedulerProfileId ?? null,
    input.priority ?? 0,
    input.skipReason ?? null,
    input.scrapeStatus ?? "pending",
    input.aiStatus ?? "pending",
    input.listingStatus ?? "pending",
    input.pipelineStage ?? "imported"
  ])

  return result.rows[0] ?? null
}

export async function getAsinPoolById(id: number) {
  const sql = `
    SELECT *
    FROM asin_pool
    WHERE id = $1
    LIMIT 1
  `

  const result = await query(sql, [id])
  return result.rows[0] ?? null
}

export async function listAsinPoolByWorkspace(workspaceId: string, limit = 100, offset = 0) {
  const sql = `
    SELECT *
    FROM asin_pool
    WHERE workspace_id = $1
    ORDER BY priority DESC, id ASC
    LIMIT $2 OFFSET $3
  `

  const result = await query(sql, [workspaceId, limit, offset])
  return result.rows
}

export async function updateAsinPoolStage(id: number, pipelineStage: string) {
  const sql = `
    UPDATE asin_pool
    SET pipeline_stage = $2,
        updated_at = NOW()
    WHERE id = $1
    RETURNING *
  `

  const result = await query(sql, [id, pipelineStage])
  return result.rows[0] ?? null
}

export async function updateAsinPoolStatuses(
  id: number,
  updates: {
    status?: string
    scrapeStatus?: string
    aiStatus?: string
    listingStatus?: string
    skipReason?: string | null
  }
) {
  const sql = `
    UPDATE asin_pool
    SET status = COALESCE($2, status),
        scrape_status = COALESCE($3, scrape_status),
        ai_status = COALESCE($4, ai_status),
        listing_status = COALESCE($5, listing_status),
        skip_reason = COALESCE($6, skip_reason),
        updated_at = NOW()
    WHERE id = $1
    RETURNING *
  `

  const result = await query(sql, [
    id,
    updates.status ?? null,
    updates.scrapeStatus ?? null,
    updates.aiStatus ?? null,
    updates.listingStatus ?? null,
    updates.skipReason ?? null
  ])

  return result.rows[0] ?? null
}

export async function assignPoolEntryToStore(id: number, storeId: number | null) {
  const sql = `
    UPDATE asin_pool
    SET assigned_store_id = $2,
        updated_at = NOW()
    WHERE id = $1
    RETURNING *
  `

  const result = await query(sql, [id, storeId])
  return result.rows[0] ?? null
}

export async function deleteAsinPoolEntry(id: number) {
  const sql = `
    DELETE FROM asin_pool
    WHERE id = $1
    RETURNING id
  `

  const result = await query(sql, [id])
  return result.rows[0] ?? null
}

export async function fetchSchedulerCandidates(workspaceId: string, limit: number) {
  const sql = `
    SELECT
      ap.*,
      ar.asin,
      ar.global_status
    FROM asin_pool ap
    INNER JOIN asin_registry ar
      ON ar.id = ap.asin_registry_id
    WHERE ap.workspace_id = $1
      AND ap.status = 'ready'
      AND ap.pipeline_stage IN ('validated', 'scraped', 'ai_generated')
      AND ar.global_status = 'active'
    ORDER BY ap.priority DESC, ap.id ASC
    LIMIT $2
  `

  const result = await query(sql, [workspaceId, limit])
  return result.rows
}

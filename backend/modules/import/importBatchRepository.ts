import { query } from "../../db/client"
import { ImportInputMode } from "./importTypes"

export type CreateImportBatchInput = {
  workspaceId: string
  sourceType: ImportInputMode
  sourceName?: string | null
  uploadedBy?: string | null
}

export type UpdateImportBatchSummaryInput = {
  id: number
  totalRows: number
  validRows: number
  readyCount: number
  duplicatePoolCount: number
  invalidCount: number
  blacklistCount?: number
  cooldownCount?: number
  scrapeFailedCount?: number
}

export async function createImportBatch(input: CreateImportBatchInput) {
  const sql = `
    INSERT INTO import_batches (
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
      scrape_failed_count
    )
    VALUES ($1, $2, $3, $4, 0, 0, 0, 0, 0, 0, 0, 0, 0)
    RETURNING *
  `

  const result = await query(sql, [
    input.workspaceId,
    input.sourceType,
    input.sourceName ?? null,
    input.uploadedBy ?? null
  ])

  return result.rows[0] ?? null
}

export async function updateImportBatchSummary(
  input: UpdateImportBatchSummaryInput
) {
  const sql = `
    UPDATE import_batches
    SET total_rows = $2,
        valid_rows = $3,
        ready_count = $4,
        duplicate_pool_count = $5,
        invalid_count = $6,
        blacklist_count = $7,
        cooldown_count = $8,
        scrape_failed_count = $9,
        updated_at = NOW()
    WHERE id = $1
    RETURNING *
  `

  const result = await query(sql, [
    input.id,
    input.totalRows,
    input.validRows,
    input.readyCount,
    input.duplicatePoolCount,
    input.invalidCount,
    input.blacklistCount ?? 0,
    input.cooldownCount ?? 0,
    input.scrapeFailedCount ?? 0
  ])

  return result.rows[0] ?? null
}

export async function getImportBatchById(id: number) {
  const sql = `
    SELECT *
    FROM import_batches
    WHERE id = $1
    LIMIT 1
  `

  const result = await query(sql, [id])
  return result.rows[0] ?? null
}
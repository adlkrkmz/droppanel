import { query } from "../../db/client"

export type CreateAsinRegistryInput = {
  workspaceId: string
  asin: string
  brand?: string | null
  title?: string | null
}

export async function createAsinRegistryEntry(input: CreateAsinRegistryInput) {
  const sql = `
    INSERT INTO asin_registry (
      workspace_id,
      asin,
      brand,
      title
    )
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (workspace_id, asin)
    DO UPDATE SET
      brand = COALESCE(EXCLUDED.brand, asin_registry.brand),
      title = COALESCE(EXCLUDED.title, asin_registry.title),
      updated_at = NOW()
    RETURNING *
  `

  const result = await query(sql, [
    input.workspaceId,
    input.asin,
    input.brand ?? null,
    input.title ?? null
  ])

  return result.rows[0] ?? null
}

export async function getAsinRegistryById(id: number) {
  const sql = `
    SELECT *
    FROM asin_registry
    WHERE id = $1
    LIMIT 1
  `

  const result = await query(sql, [id])
  return result.rows[0] ?? null
}

export async function getAsinRegistryByAsin(workspaceId: string, asin: string) {
  const sql = `
    SELECT *
    FROM asin_registry
    WHERE workspace_id = $1
      AND asin = $2
    LIMIT 1
  `

  const result = await query(sql, [workspaceId, asin])
  return result.rows[0] ?? null
}

export async function listAsinRegistryByWorkspace(workspaceId: string, limit = 100, offset = 0) {
  const sql = `
    SELECT *
    FROM asin_registry
    WHERE workspace_id = $1
    ORDER BY id DESC
    LIMIT $2 OFFSET $3
  `

  const result = await query(sql, [workspaceId, limit, offset])
  return result.rows
}

export async function updateAsinRegistryStatus(id: number, globalStatus: string) {
  const sql = `
    UPDATE asin_registry
    SET global_status = $2,
        updated_at = NOW()
    WHERE id = $1
    RETURNING *
  `

  const result = await query(sql, [id, globalStatus])
  return result.rows[0] ?? null
}

export async function updateAsinRegistryMetadata(
  id: number,
  updates: { brand?: string | null; title?: string | null }
) {
  const sql = `
    UPDATE asin_registry
    SET brand = COALESCE($2, brand),
        title = COALESCE($3, title),
        updated_at = NOW()
    WHERE id = $1
    RETURNING *
  `

  const result = await query(sql, [id, updates.brand ?? null, updates.title ?? null])
  return result.rows[0] ?? null
}

export async function deleteAsinRegistryEntry(id: number) {
  const sql = `
    DELETE FROM asin_registry
    WHERE id = $1
    RETURNING id
  `

  const result = await query(sql, [id])
  return result.rows[0] ?? null
}

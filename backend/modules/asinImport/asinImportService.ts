// ─────────────────────────────────────────────────────────────
// asinImportService.ts
//
// Merkezi ASIN import servisi.
// Amazon extension, scraper, manual paste — hepsi buradan geçer.
//
// Duplicate koruması:
//   1. Format kontrolü        → invalid
//   2. Pool'da zaten varsa    → skippedDuplicate
//   3. Herhangi bir mağazada
//      LISTED veya ASSIGNED   → skippedStoreConflict
//   4. Temiz → asin_registry + asin_pool insert
// ─────────────────────────────────────────────────────────────

import { query } from "../../db/client"
import type { AsinImportRequest, AsinImportResponse } from "./asinImportTypes"

// ─── ASIN PARSE & VALIDATE ────────────────────────────────────

const ASIN_REGEX = /^[A-Z0-9]{10}$/

function parseAndValidate(raw: string[]): {
  valid:   string[]
  invalid: string[]
} {
  const seen    = new Set<string>()
  const valid:   string[] = []
  const invalid: string[] = []

  for (const item of raw) {
    // Virgül, boşluk, satır sonu ile bölünmüş girdi normalize et
    const parts = item
      .split(/[\s,;]+/)
      .map(p => p.trim().toUpperCase())
      .filter(p => p.length > 0)

    for (const asin of parts) {
      if (!ASIN_REGEX.test(asin)) {
        invalid.push(asin)
        continue
      }
      if (seen.has(asin)) continue   // input içi duplicate — sessizce atla
      seen.add(asin)
      valid.push(asin)
    }
  }

  return { valid, invalid }
}

// ─── POOL'DA VAR MI? ──────────────────────────────────────────

async function fetchExistingInPool(
  workspaceId: string,
  asins:       string[]
): Promise<Set<string>> {
  if (asins.length === 0) return new Set()

  const result = await query<{ asin: string }>(
    `SELECT ar.asin
     FROM asin_pool ap
     INNER JOIN asin_registry ar ON ar.id = ap.asin_registry_id
     WHERE ap.workspace_id = $1
       AND ar.asin = ANY($2::text[])
       AND ap.status != 'completed'
     LIMIT 10000`,
    [workspaceId, asins]
  )
  return new Set(result.rows.map(r => r.asin))
}

// ─── HERHANGI BİR MAĞAZADA LİSTED/ASSIGNED MI? ───────────────
// store_catalog_state veya listing_history üzerinden kontrol

async function fetchStoreConflicts(
  workspaceId: string,
  asins:       string[]
): Promise<Set<string>> {
  if (asins.length === 0) return new Set()

  // listing_history — başarıyla listelenmiş
  const histResult = await query<{ asin: string }>(
    `SELECT ar.asin
     FROM listing_history lh
     INNER JOIN asin_registry ar ON ar.id = lh.asin_registry_id
     WHERE lh.workspace_id = $1
       AND ar.asin = ANY($2::text[])
     LIMIT 10000`,
    [workspaceId, asins]
  )

  // asin_pool — assigned_store_id dolu (mağazaya atanmış ama henüz listed olmayabilir)
  const assignedResult = await query<{ asin: string }>(
    `SELECT ar.asin
     FROM asin_pool ap
     INNER JOIN asin_registry ar ON ar.id = ap.asin_registry_id
     WHERE ap.workspace_id      = $1
       AND ar.asin              = ANY($2::text[])
       AND ap.assigned_store_id IS NOT NULL
     LIMIT 10000`,
    [workspaceId, asins]
  )

  const conflicts = new Set<string>()
  for (const r of histResult.rows)     conflicts.add(r.asin)
  for (const r of assignedResult.rows) conflicts.add(r.asin)
  return conflicts
}

// ─── REGISTRY'DE VAR MI? ──────────────────────────────────────

async function fetchExistingRegistry(
  workspaceId: string,
  asins:       string[]
): Promise<Map<string, number>> {
  if (asins.length === 0) return new Map()

  const result = await query<{ asin: string; id: number }>(
    `SELECT asin, id FROM asin_registry
     WHERE workspace_id = $1 AND asin = ANY($2::text[])`,
    [workspaceId, asins]
  )
  return new Map(result.rows.map(r => [r.asin, r.id]))
}

// ─── INSERT: asin_registry ────────────────────────────────────

async function insertRegistryBulk(
  workspaceId: string,
  asins:       string[]
): Promise<Array<{ asin: string; id: number }>> {
  if (asins.length === 0) return []

  const result = await query<{ asin: string; id: number }>(
    `INSERT INTO asin_registry (workspace_id, asin, global_status, created_at, updated_at)
     SELECT $1, u.asin, 'active', NOW(), NOW()
     FROM UNNEST($2::text[]) AS u(asin)
     ON CONFLICT (workspace_id, asin) DO NOTHING
     RETURNING asin, id`,
    [workspaceId, asins]
  )
  return result.rows
}

// ─── INSERT: asin_pool ────────────────────────────────────────

async function insertPoolBulk(
  workspaceId: string,
  asinRegistryRows: Array<{ asin: string; id: number }>
): Promise<string[]> {
  if (asinRegistryRows.length === 0) return []

  const ids = asinRegistryRows.map(r => r.id)
  const idToAsin = new Map<number, string>(asinRegistryRows.map(r => [r.id, r.asin]))

  const result = await query<{ asin_registry_id: number }>(
    `INSERT INTO asin_pool (
       workspace_id, asin_registry_id,
       status, pipeline_stage,
       scrape_status, ai_status, listing_status,
       assigned_store_id, priority,
       created_at, updated_at
     )
     SELECT
       $1::uuid,
       u.asin_registry_id,
       'ready', 'validated',
       'pending', 'pending', 'pending',
       NULL, 0,
       NOW(), NOW()
     FROM UNNEST($2::bigint[]) AS u(asin_registry_id)
     ON CONFLICT DO NOTHING
     RETURNING asin_registry_id`,
    [workspaceId, ids]
  )

  return result.rows
    .map(r => idToAsin.get(r.asin_registry_id))
    .filter((asin): asin is string => typeof asin === "string")
}

// ─── ANA FONKSİYON ────────────────────────────────────────────

export async function importAsins(
  workspaceId: string,
  req:         AsinImportRequest
): Promise<AsinImportResponse> {
  const { valid: validAsins, invalid: invalidAsins } = parseAndValidate(req.asins)

  if (validAsins.length === 0) {
    return {
      totalInput:           req.asins.length,
      valid:                0,
      inserted:             0,
      skippedDuplicate:     0,
      skippedStoreConflict: 0,
      invalid:              invalidAsins.length,
      invalidAsins,
      duplicateAsins:       [],
      conflictAsins:        [],
      insertedAsins:        [],
    }
  }

  // Paralel kontroller
  const [poolSet, conflictSet] = await Promise.all([
    fetchExistingInPool(workspaceId, validAsins),
    fetchStoreConflicts(workspaceId, validAsins),
  ])

  const duplicateAsins: string[] = []
  const conflictAsins:  string[] = []
  const toInsert:       string[] = []

  for (const asin of validAsins) {
    if (poolSet.has(asin)) {
      duplicateAsins.push(asin)
    } else if (conflictSet.has(asin)) {
      conflictAsins.push(asin)
    } else {
      toInsert.push(asin)
    }
  }

  // Insert (bulk)
  await insertRegistryBulk(workspaceId, toInsert)
  const registryMap = await fetchExistingRegistry(workspaceId, toInsert)

  // TO-DO: insertRegistryBulk RETURNING only yeni eklenenleri getirir.
  // Bu yüzden pool insert öncesi kesin olarak toInsert'in tamamı için registry id'lerini çekiyoruz.
  const missing = toInsert.filter(asin => !registryMap.has(asin))
  if (missing.length > 0) {
    console.warn(
      "[Import] Could not find registry ids for:",
      missing.slice(0, 5)
    )
  }

  const registryRows = toInsert
    .filter((asin) => registryMap.has(asin))
    .map((asin) => ({ asin, id: registryMap.get(asin)! }))
  const insertedAsins = await insertPoolBulk(workspaceId, registryRows)
  const insertedSet = new Set(insertedAsins)
  for (const asin of toInsert) {
    if (!insertedSet.has(asin)) duplicateAsins.push(asin)
  }

  return {
    totalInput:           req.asins.length,
    valid:                validAsins.length,
    inserted:             insertedAsins.length,
    skippedDuplicate:     duplicateAsins.length,
    skippedStoreConflict: conflictAsins.length,
    invalid:              invalidAsins.length,
    invalidAsins,
    duplicateAsins,
    conflictAsins,
    insertedAsins,
  }
}

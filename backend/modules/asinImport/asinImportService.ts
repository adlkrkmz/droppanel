// ─────────────────────────────────────────────────────────────
// asinImportService.ts
//
// Merkezi ASIN import servisi.
// Amazon extension, scraper, manual paste — hepsi buradan geçer.
//
// Duplicate koruması:
//   1. Format kontrolü              → invalid
//   2. Pool'da zaten varsa          → skippedDuplicate / ALREADY_IN_POOL
//   3. My Listings (store_catalog)  → skippedAlreadyListed
//   4. Mağazaya atanmış pool kaydı  → skippedStoreConflict
//   5. Temiz → asin_registry + asin_pool insert
// ─────────────────────────────────────────────────────────────

import { query } from "../../db/client"
import { addNotification } from "../notifications/notificationService"
import { findExistingListedAsins } from "./listedAsinGuard"
import type {
  AsinImportRequest,
  AsinImportResponse,
  AsinImportSkipDetail,
} from "./asinImportTypes"

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
    const parts = item
      .split(/[\s,;]+/)
      .map(p => p.trim().toUpperCase())
      .filter(p => p.length > 0)

    for (const asin of parts) {
      if (!ASIN_REGEX.test(asin)) {
        invalid.push(asin)
        continue
      }
      if (seen.has(asin)) continue
      seen.add(asin)
      valid.push(asin)
    }
  }

  return { valid, invalid }
}

// ─── POOL'DA VAR MI? (aktif aday havuzu) ─────────────────────

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
       AND ap.archived_at IS NULL
       AND ap.status != 'completed'
       AND ap.pipeline_stage != 'listed'
       AND ap.listing_status != 'success'
     LIMIT 10000`,
    [workspaceId, asins]
  )
  return new Set(result.rows.map(r => r.asin))
}

// ─── ARCHIVED POOL REACTIVATE (unique index — yeni satır açılamaz) ─

async function reactivateArchivedPoolItems(
  workspaceId: string,
  asins:       string[]
): Promise<string[]> {
  if (asins.length === 0) return []

  const result = await query<{ asin: string }>(
    `UPDATE asin_pool ap
     SET archived_at       = NULL,
         archived_by       = NULL,
         archive_reason    = NULL,
         status            = 'ready',
         pipeline_stage    = 'validated',
         scrape_status     = 'pending',
         ai_status         = 'pending',
         listing_status    = 'pending',
         assigned_store_id = NULL,
         skip_reason       = NULL,
         updated_at        = NOW()
     FROM asin_registry ar
     WHERE ap.asin_registry_id = ar.id
       AND ap.workspace_id = $1
       AND ar.asin = ANY($2::text[])
       AND ap.archived_at IS NOT NULL
     RETURNING ar.asin`,
    [workspaceId, asins]
  )
  return result.rows.map(r => r.asin)
}

// ─── MAĞAZAYA ATANMIŞ POOL (store conflict — mevcut kural) ───

async function fetchAssignedPoolConflicts(
  workspaceId: string,
  asins:       string[]
): Promise<Set<string>> {
  if (asins.length === 0) return new Set()

  const result = await query<{ asin: string }>(
    `SELECT ar.asin
     FROM asin_pool ap
     INNER JOIN asin_registry ar ON ar.id = ap.asin_registry_id
     WHERE ap.workspace_id      = $1
       AND ar.asin              = ANY($2::text[])
       AND ap.assigned_store_id IS NOT NULL
       AND ap.archived_at IS NULL
       AND ap.pipeline_stage != 'listed'
       AND ap.status != 'completed'
       AND ap.listing_status != 'success'
     LIMIT 10000`,
    [workspaceId, asins]
  )
  return new Set(result.rows.map(r => r.asin))
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
  const skipDetails: AsinImportSkipDetail[] = []

  for (const asin of invalidAsins) {
    skipDetails.push({ asin, status: "skipped", reason: "INVALID_ASIN" })
  }

  if (validAsins.length === 0) {
    return {
      totalInput:           req.asins.length,
      valid:                0,
      inserted:             0,
      skippedDuplicate:     0,
      skippedStoreConflict: 0,
      skippedAlreadyListed: 0,
      invalid:              invalidAsins.length,
      invalidAsins,
      duplicateAsins:       [],
      conflictAsins:        [],
      alreadyListedAsins:   [],
      insertedAsins:        [],
      skipDetails,
    }
  }

  const [poolSet, listedMap, assignedSet] = await Promise.all([
    fetchExistingInPool(workspaceId, validAsins),
    findExistingListedAsins(workspaceId, validAsins),
    fetchAssignedPoolConflicts(workspaceId, validAsins),
  ])

  const duplicateAsins:     string[] = []
  const alreadyListedAsins: string[] = []
  const conflictAsins:      string[] = []
  const toInsert:           string[] = []

  for (const asin of validAsins) {
    if (poolSet.has(asin)) {
      duplicateAsins.push(asin)
      skipDetails.push({ asin, status: "skipped", reason: "ALREADY_IN_POOL" })
    } else if (listedMap.has(asin)) {
      const match = listedMap.get(asin)!
      alreadyListedAsins.push(asin)
      skipDetails.push({
        asin,
        status: "skipped",
        reason: "ALREADY_LISTED_IN_STORE",
        storeCode: match.storeCode,
        ebayItemId: match.ebayItemId,
        catalogStateId: match.catalogStateId,
      })
    } else if (assignedSet.has(asin)) {
      conflictAsins.push(asin)
      skipDetails.push({ asin, status: "skipped", reason: "STORE_CONFLICT" })
    } else {
      toInsert.push(asin)
    }
  }

  await insertRegistryBulk(workspaceId, toInsert)
  const registryMap = await fetchExistingRegistry(workspaceId, toInsert)

  const missing = toInsert.filter(asin => !registryMap.has(asin))
  if (missing.length > 0) {
    console.warn("[Import] Could not find registry ids for:", missing.slice(0, 5))
  }

  const registryRows = toInsert
    .filter((asin) => registryMap.has(asin))
    .map((asin) => ({ asin, id: registryMap.get(asin)! }))
  const insertedAsins = await insertPoolBulk(workspaceId, registryRows)
  const insertedSet = new Set(insertedAsins)
  const notInserted = toInsert.filter(asin => !insertedSet.has(asin))
  const reactivatedAsins = notInserted.length > 0
    ? await reactivateArchivedPoolItems(workspaceId, notInserted)
    : []
  const reactivatedSet = new Set(reactivatedAsins)
  const finalInsertedAsins = [...insertedAsins, ...reactivatedAsins]

  for (const asin of notInserted) {
    if (reactivatedSet.has(asin)) continue
    duplicateAsins.push(asin)
    skipDetails.push({ asin, status: "skipped", reason: "ALREADY_IN_POOL" })
  }

  const response: AsinImportResponse = {
    totalInput:           req.asins.length,
    valid:                validAsins.length,
    inserted:             finalInsertedAsins.length,
    skippedDuplicate:     duplicateAsins.length,
    skippedStoreConflict: conflictAsins.length,
    skippedAlreadyListed: alreadyListedAsins.length,
    invalid:              invalidAsins.length,
    invalidAsins,
    duplicateAsins,
    conflictAsins,
    alreadyListedAsins,
    insertedAsins:        finalInsertedAsins,
    skipDetails,
  }
  try {
    await addNotification(
      workspaceId,
      "info",
      "Import Tamamlandı",
      `${response.inserted} ASIN havuza eklendi`
    )
  } catch {
    /* bildirim ana akışı bozmasın */
  }
  return response
}

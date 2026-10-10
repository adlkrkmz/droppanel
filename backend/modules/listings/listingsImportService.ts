import { query } from "../../db/client"
import type {
  ImportMatchRequest,
  ImportMatchResponse,
  ImportMatchRowResult,
  ImportMatchSummary,
  ImportMatchStatus,
} from "./listingsImportTypes"

const ASIN_REGEX = /^[A-Z0-9]{10}$/

type StoreRow = { id: number; name: string }

type CatalogHit = {
  id:               number
  storeId:          number
  ebayItemId:       string
  asinRegistryId:   number | null
  registryAsin:     string | null
  sourceUrl:        string | null
}

async function getStoreByCode(
  workspaceId: string,
  storeCode:   string
): Promise<StoreRow | null> {
  const result = await query<StoreRow>(
    `SELECT id, name FROM stores
     WHERE workspace_id = $1 AND store_code = $2 AND status = 'active'
     LIMIT 1`,
    [workspaceId, storeCode]
  )
  return result.rows[0] ?? null
}

async function ensureAsinRegistryId(
  workspaceId: string,
  asin:        string
): Promise<number> {
  const ins = await query<{ id: number }>(
    `INSERT INTO asin_registry (workspace_id, asin, global_status, created_at, updated_at)
     VALUES ($1, $2, 'active', NOW(), NOW())
     ON CONFLICT (workspace_id, asin) DO NOTHING
     RETURNING id`,
    [workspaceId, asin]
  )
  if (ins.rows[0]?.id) return ins.rows[0].id

  const existing = await query<{ id: number }>(
    `SELECT id FROM asin_registry
     WHERE workspace_id = $1 AND asin = $2
     LIMIT 1`,
    [workspaceId, asin]
  )
  const id = existing.rows[0]?.id
  if (!id) throw new Error(`Failed to resolve asin_registry for ${asin}`)
  return id
}

async function fetchCatalogByEbayIds(
  workspaceId: string,
  ebayIds:     string[]
): Promise<Map<string, CatalogHit[]>> {
  if (ebayIds.length === 0) return new Map()

  const result = await query<{
    id:                 number
    store_id:           number
    ebay_item_id:       string
    asin_registry_id:   number | null
    registry_asin:      string | null
    source_url:         string | null
  }>(
    `SELECT scs.id,
            scs.store_id,
            trim(scs.ebay_item_id) AS ebay_item_id,
            scs.asin_registry_id,
            ar.asin AS registry_asin,
            scs.source_url
     FROM store_catalog_state scs
     LEFT JOIN asin_registry ar ON ar.id = scs.asin_registry_id
     WHERE scs.workspace_id = $1
       AND scs.ebay_item_id IS NOT NULL
       AND trim(scs.ebay_item_id) = ANY($2::text[])`,
    [workspaceId, ebayIds]
  )

  const map = new Map<string, CatalogHit[]>()
  for (const r of result.rows) {
    const key = r.ebay_item_id.trim()
    const hit: CatalogHit = {
      id:             r.id,
      storeId:        r.store_id,
      ebayItemId:     key,
      asinRegistryId: r.asin_registry_id,
      registryAsin:   r.registry_asin?.trim().toUpperCase() ?? null,
      sourceUrl:      r.source_url?.trim() ?? null,
    }
    const list = map.get(key) ?? []
    list.push(hit)
    map.set(key, list)
  }
  return map
}

function amazonSourceUrl(asin: string): string {
  return `https://www.amazon.com/dp/${asin}`
}

function isAlreadyMatched(hit: CatalogHit, asin: string): boolean {
  if (hit.registryAsin === asin) return true
  const expected = amazonSourceUrl(asin)
  if (hit.sourceUrl === expected) return true
  return false
}

function emptySummary(): ImportMatchSummary {
  return {
    total:         0,
    matched:       0,
    updated:       0,
    alreadyExists: 0,
    invalidAsin:   0,
    ebayNotFound:  0,
    storeConflict: 0,
    duplicate:     0,
    failed:        0,
  }
}

function bumpSummary(summary: ImportMatchSummary, status: ImportMatchStatus): void {
  switch (status) {
    case "UPDATED":
      summary.updated++
      summary.matched++
      break
    case "ALREADY_EXISTS":
      summary.alreadyExists++
      summary.matched++
      break
    case "INVALID_ASIN":
      summary.invalidAsin++
      break
    case "EBAY_NOT_FOUND":
      summary.ebayNotFound++
      break
    case "STORE_CONFLICT":
      summary.storeConflict++
      break
    case "DUPLICATE_EBAY_ID":
      summary.duplicate++
      break
    case "DUPLICATE_ASIN_WARNING":
      summary.updated++
      summary.matched++
      break
    case "FAILED":
      summary.failed++
      break
    case "DUPLICATE_ASIN_WARNING":
      break
    default:
      break
  }
}

export async function importMatchListings(
  workspaceId: string,
  req:         ImportMatchRequest
): Promise<ImportMatchResponse> {
  const storeCode = req.storeCode?.trim()
  if (!storeCode) throw new Error("storeCode is required")

  const store = await getStoreByCode(workspaceId, storeCode)
  if (!store) throw new Error("Active store not found")

  const rawRows = Array.isArray(req.rows) ? req.rows : []
  const summary = emptySummary()
  summary.total = rawRows.length

  if (rawRows.length === 0) {
    return { ok: true, summary, results: [] }
  }

  const normalized = rawRows.map(r => ({
    ebayItemId: String(r.ebayItemId ?? "").trim(),
    asin:       String(r.asin ?? "").trim().toUpperCase(),
  }))

  const ebayIds = [...new Set(normalized.map(r => r.ebayItemId).filter(Boolean))]
  const catalogMap = await fetchCatalogByEbayIds(workspaceId, ebayIds)

  const seenEbayInRequest = new Set<string>()
  const asinCounts = new Map<string, number>()
  for (const r of normalized) {
    if (r.asin) asinCounts.set(r.asin, (asinCounts.get(r.asin) ?? 0) + 1)
  }

  const results: ImportMatchRowResult[] = []

  for (let i = 0; i < normalized.length; i++) {
    const rowNum = i + 1
    const { ebayItemId, asin } = normalized[i]!

    let duplicateAsinWarning = (asinCounts.get(asin) ?? 0) > 1

    if (!ASIN_REGEX.test(asin)) {
      const result: ImportMatchRowResult = {
        row: rowNum,
        ebayItemId,
        asin,
        status:  "INVALID_ASIN",
        message: "ASIN must be 10 alphanumeric characters",
      }
      results.push(result)
      bumpSummary(summary, result.status)
      continue
    }

    if (!ebayItemId) {
      const result: ImportMatchRowResult = {
        row: rowNum,
        ebayItemId,
        asin,
        status:  "EBAY_NOT_FOUND",
        message: "eBay ID is required",
      }
      results.push(result)
      bumpSummary(summary, result.status)
      continue
    }

    if (seenEbayInRequest.has(ebayItemId)) {
      const result: ImportMatchRowResult = {
        row: rowNum,
        ebayItemId,
        asin,
        status:  "DUPLICATE_EBAY_ID",
        message: "Duplicate eBay ID in this request — first occurrence was processed",
      }
      results.push(result)
      bumpSummary(summary, result.status)
      continue
    }
    seenEbayInRequest.add(ebayItemId)

    const hits = catalogMap.get(ebayItemId) ?? []

    if (hits.length === 0) {
      const result: ImportMatchRowResult = {
        row: rowNum,
        ebayItemId,
        asin,
        status:  "EBAY_NOT_FOUND",
        message: "No listing with this eBay ID in any store",
      }
      results.push(result)
      bumpSummary(summary, result.status)
      continue
    }

    const inSelectedStore = hits.filter(h => h.storeId === store.id)
    const inOtherStores   = hits.filter(h => h.storeId !== store.id)

    if (inSelectedStore.length === 0) {
      const result: ImportMatchRowResult = {
        row: rowNum,
        ebayItemId,
        asin,
        status:  inOtherStores.length > 0 ? "STORE_CONFLICT" : "EBAY_NOT_FOUND",
        message:
          inOtherStores.length > 0
            ? "eBay ID exists in another store — not updated"
            : "No listing with this eBay ID in selected store",
      }
      results.push(result)
      bumpSummary(summary, result.status)
      continue
    }

    const hit = inSelectedStore[0]!

    if (isAlreadyMatched(hit, asin)) {
      let message = "Listing already matched with this ASIN"
      if (duplicateAsinWarning) {
        message += " — duplicate ASIN in request (warning only)"
      }
      const result: ImportMatchRowResult = {
        row: rowNum,
        ebayItemId,
        asin,
        status:  "ALREADY_EXISTS",
        message,
      }
      results.push(result)
      bumpSummary(summary, result.status)
      continue
    }

    try {
      const { resolveListingAsin } = await import("../monitor/listingAsinResolve")
      const previousAsin = resolveListingAsin({
        registryAsin: hit.registryAsin,
        sourceUrl: hit.sourceUrl,
        internalSku: "",
      })
      const registryId = await ensureAsinRegistryId(workspaceId, asin)
      const sourceUrl = amazonSourceUrl(asin)

      const upd = await query<{ id: number }>(
        `UPDATE store_catalog_state
         SET asin_registry_id = $1,
             source_url       = $2,
             updated_at       = NOW()
         WHERE workspace_id = $3
           AND store_id     = $4
           AND id           = $5
         RETURNING id`,
        [registryId, sourceUrl, workspaceId, store.id, hit.id]
      )

      if ((upd.rowCount ?? 0) === 0) {
        throw new Error("Catalog row update returned no rows")
      }

      try {
        const { emitKeepaAsinSyncForCatalog } = await import("../keepaSensor/keepaAsinSyncOutbox")
        await emitKeepaAsinSyncForCatalog({
          workspaceId,
          storeId: store.id,
          catalogStateId: hit.id,
          previousAsins: [previousAsin],
        })
      } catch (e) {
        console.warn("[keepa-asin-sync] emit failed:", e instanceof Error ? e.message : e)
      }

      hit.asinRegistryId = registryId
      hit.registryAsin = asin
      hit.sourceUrl = sourceUrl

      let message = "Listing matched with ASIN"
      let status: ImportMatchStatus = "UPDATED"
      if (duplicateAsinWarning) {
        message += " — duplicate ASIN in request (warning only)"
        status = "DUPLICATE_ASIN_WARNING"
      }

      const result: ImportMatchRowResult = {
        row: rowNum,
        ebayItemId,
        asin,
        status,
        message,
      }
      results.push(result)
      bumpSummary(summary, status)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const isUnique =
        msg.includes("unique") ||
        msg.includes("duplicate key") ||
        msg.includes("23505")

      const result: ImportMatchRowResult = {
        row: rowNum,
        ebayItemId,
        asin,
        status:  "FAILED",
        message: isUnique
          ? "Could not link ASIN — another listing in this store may already use it"
          : msg,
      }
      results.push(result)
      bumpSummary(summary, result.status)
    }
  }

  return { ok: true, summary, results }
}

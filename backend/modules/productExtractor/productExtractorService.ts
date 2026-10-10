// ─────────────────────────────────────────────────────────────
// productExtractorService.ts
//
// Chrome Extension'dan gelen Amazon ürün verisini alır,
// asin_registry'de ASIN'i resolve eder (yoksa oluşturur),
// amazon_product_cache tablosuna upsert eder,
// ardından asin_pool'a ekler (asinImportService ile aynı kolon pattern'ı).
// ─────────────────────────────────────────────────────────────

import { query } from "../../db/client"
import { addNotification } from "../notifications/notificationService"
import type {
  ProductExtractorRequest,
  ProductExtractorResponse,
  ProductExtractorSuccessResponse,
  ProductExtractorErrorResponse,
} from "./productExtractorTypes"

const ASIN_REGEX = /^[A-Z0-9]{10}$/

function normalizeAsin(asin: string): string {
  return asin.trim().toUpperCase()
}

function isVideoThumbnailUrl(url: string): boolean {
  const u = url.toLowerCase()
  return u.includes("pkplay-button") || u.includes("play-button")
}

function upscaleAmazonImageUrl(url: string): string {
  // General rule: if URL contains "._AC_", normalize the size segment to "_AC_SL1500_"
  // Examples: _AC_US100_ / _AC_US40_ / _AC_US60_ → _AC_SL1500_
  if (url.includes("._AC_")) {
    return url.replace(/_AC_[^_]+_/g, "_AC_SL1500_")
  }

  // Some Amazon variants include "SS125_" style sizing.
  if (/SS\d+_/i.test(url)) {
    return url.replace(/SS\d+_/gi, "_AC_SL1500_")
  }

  return url
}

function sanitizeImageUrls(images: unknown): string[] {
  if (!Array.isArray(images)) return []
  return images
    .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    .map((u) => u.trim())
    .filter((u) => !isVideoThumbnailUrl(u))
    .map(upscaleAmazonImageUrl)
}

function sanitizeBrand(brand: string): string {
  let b = (brand ?? "").trim()
  if (!b) return ""

  if (b.endsWith(" Store")) {
    b = b.slice(0, -" Store".length).trim()
  }

  b = b.replace(/\s+shop$/i, "").trim()
  return b
}

/** Extension payload'ını cache satırına uygun attributes objesine dönüştürür */
function toCacheAttributes(req: ProductExtractorRequest): Record<string, unknown> {
  const attrs: Record<string, unknown> = {
    bullets:         req.bullets,
    description:     req.description,
    specs:           req.specs,
    rating:          req.rating,
    reviews:         req.reviews,
    bsr:             req.bsr,
    category:        req.category,
    isPrime:         req.isPrime === true ? true : req.isPrime === false ? false : null,
    isFreeShipping:  req.isFreeShipping,
    currency:        req.currency,
    source:          req.source ?? "extension",
  }
  if (req.availabilityText != null) attrs.availabilityText = req.availabilityText
  if (req.hasAddToCart != null) attrs.hasAddToCart = req.hasAddToCart
  if (req.hasBuyNow != null) attrs.hasBuyNow = req.hasBuyNow
  if (req.primeStatus != null) attrs.primeStatus = req.primeStatus
  if (req.primeEvidence != null) attrs.primeEvidence = req.primeEvidence
  if (req.primeCheckedAt != null) attrs.primeCheckedAt = req.primeCheckedAt
  if (req.selectedAsin != null) attrs.selectedAsin = req.selectedAsin
  if (req.pageUrlAsin != null) attrs.pageUrlAsin = req.pageUrlAsin
  if (req.stockStatus != null) attrs.stockStatus = req.stockStatus
  if (req.stockCount != null) attrs.stockCount = req.stockCount
  if (req.stockEvidence != null) attrs.stockEvidence = req.stockEvidence
  if (req.stockCheckedAt != null) attrs.stockCheckedAt = req.stockCheckedAt
  const ext = req as ProductExtractorRequest & {
    stockText?: string; primeText?: string; deliveryText?: string; capturedAt?: string; amazonUrl?: string
  }
  if (ext.stockText != null) attrs.stockText = ext.stockText
  if (ext.primeText != null) attrs.primeText = ext.primeText
  if (ext.deliveryText != null) attrs.deliveryText = ext.deliveryText
  if (ext.capturedAt != null) attrs.capturedAt = ext.capturedAt
  if (ext.amazonUrl != null) attrs.amazonUrl = ext.amazonUrl
  return attrs
}

/** workspace_id + asin ile asin_registry id bulur; yoksa null */
async function fetchRegistryId(
  workspaceId: string,
  asin:        string
): Promise<number | null> {
  const result = await query<{ id: number }>(
    `SELECT id FROM asin_registry
     WHERE workspace_id = $1 AND asin = $2
     LIMIT 1`,
    [workspaceId, asin]
  )
  return result.rows[0]?.id ?? null
}

/** asin_registry'ye yeni kayıt ekler, id döner */
async function insertRegistry(
  workspaceId: string,
  asin:        string
): Promise<number> {
  const result = await query<{ id: number }>(
    `INSERT INTO asin_registry (workspace_id, asin, global_status, created_at, updated_at)
     VALUES ($1, $2, 'active', NOW(), NOW())
     RETURNING id`,
    [workspaceId, asin]
  )
  return result.rows[0].id
}

/** amazon_product_cache'e upsert */
async function upsertCache(
  asinRegistryId: number,
  req:            ProductExtractorRequest
): Promise<boolean> {
  const attributes = toCacheAttributes(req)
  const images = sanitizeImageUrls(req.images)
  const brand = sanitizeBrand(req.brand ?? "")
  const source = req.source ?? "amazon"
  const externalId = req.external_id ?? null

  const existed = await query<{ asin_registry_id: number }>(
    `SELECT asin_registry_id FROM amazon_product_cache WHERE asin_registry_id = $1 LIMIT 1`,
    [asinRegistryId]
  )
  const wasExisting = existed.rows.length > 0

  await query(
    `INSERT INTO amazon_product_cache (
       asin_registry_id,
       title,
       brand,
       price,
       images,
       attributes,
       source,
       external_id,
       updated_at
     )
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, NOW())
     ON CONFLICT (asin_registry_id)
     DO UPDATE SET
       title = EXCLUDED.title,
       brand = EXCLUDED.brand,
       price = EXCLUDED.price,
       images = EXCLUDED.images,
       attributes = EXCLUDED.attributes,
       source = EXCLUDED.source,
       external_id = EXCLUDED.external_id,
       updated_at = NOW()`,
    [
      asinRegistryId,
      req.title ?? "",
      brand,
      req.price ?? 0,
      JSON.stringify(images),
      JSON.stringify(attributes),
      source,
      externalId,
    ]
  )
  return !wasExisting
}

async function fetchPoolId(
  workspaceId:    string,
  asinRegistryId: number
): Promise<number | null> {
  const result = await query<{ id: number }>(
    `SELECT id FROM asin_pool
     WHERE workspace_id = $1 AND asin_registry_id = $2
     LIMIT 1`,
    [workspaceId, asinRegistryId]
  )
  const raw = result.rows[0]?.id
  if (raw == null) return null
  return typeof raw === "string" ? parseInt(raw, 10) : raw
}

/** Live runner simulation cache can mark pool scraped too early — reset before real extension extract. */
async function repairPoolStageIfSimulationOnlyCache(
  workspaceId:    string,
  asinRegistryId: number
): Promise<void> {
  await query(
    `UPDATE asin_pool ap
     SET pipeline_stage = 'validated',
         scrape_status = 'pending',
         updated_at = NOW()
     FROM amazon_product_cache apc
     WHERE ap.workspace_id = $1
       AND ap.asin_registry_id = $2
       AND apc.asin_registry_id = ap.asin_registry_id
       AND ap.pipeline_stage = 'scraped'
       AND (
         apc.attributes->>'source' = 'simulation'
         OR EXISTS (
           SELECT 1 FROM jsonb_array_elements_text(apc.images) img
           WHERE img ILIKE '%example.com%'
         )
       )`,
    [workspaceId, asinRegistryId]
  )
}

/**
 * asinImportService.insertPool ile aynı kolon seti;
 * pipeline_stage: scraped, scrape_status: success (Amazon verisi yazıldı).
 */
async function insertPoolAfterScrape(
  workspaceId:    string,
  asinRegistryId: number
): Promise<void> {
  await query(
    `INSERT INTO asin_pool (
       workspace_id, asin_registry_id,
       status, pipeline_stage,
       scrape_status, ai_status, listing_status,
       assigned_store_id, priority,
       created_at, updated_at
     )
     VALUES ($1, $2,
       'ready', 'scraped',
       'success', 'pending', 'pending',
       NULL, 0,
       NOW(), NOW()
     )
     ON CONFLICT (workspace_id, asin_registry_id) DO UPDATE SET
       scrape_status     = 'success',
       status            = 'ready',
       listing_status    = 'pending',
       assigned_store_id = NULL,
       pipeline_stage = CASE
         WHEN asin_pool.pipeline_stage IN ('imported', 'validated', 'listed')
         THEN 'scraped'
         ELSE asin_pool.pipeline_stage
       END,
       updated_at = NOW()`,
    [workspaceId, asinRegistryId]
  )
}

/**
 * Extension'dan gelen tek ürünü işler: ASIN validasyonu → registry get/create →
 * amazon_product_cache upsert → asin_pool (scraped / ready, conflict yoksa).
 */
export async function extractAndSaveProduct(
  workspaceId: string,
  req:         ProductExtractorRequest
): Promise<ProductExtractorResponse> {
  console.log(`[ProductExtractor] Received: asin=${req.asin} price=${req.price} title="${(req.title ?? '').slice(0, 50)}" images=${Array.isArray(req.images) ? req.images.length : 0}`)
  const asin = normalizeAsin(req.asin ?? "")
  const source = String(req.source ?? "amazon").trim().toLowerCase()
  if (source !== "amazon" && source !== "extension") {
    return { success: false, error: "Only Amazon product extraction is supported" }
  }
  if (!asin) {
    const err: ProductExtractorErrorResponse = { success: false, error: "asin is required" }
    return err
  }
  if (!ASIN_REGEX.test(asin)) {
    const err: ProductExtractorErrorResponse = {
      success: false,
      error:   `Invalid Amazon ASIN format: ${asin}. Must be 10 alphanumeric characters.`,
    }
    return err
  }

  let asinRegistryId: number | null = await fetchRegistryId(workspaceId, asin)
  if (asinRegistryId === null) {
    try {
      asinRegistryId = await insertRegistry(workspaceId, asin)
    } catch (e) {
      console.warn(`[ProductExtractor] insertRegistry failed for ${asin}: ${e instanceof Error ? e.message : String(e)}`)
      const err: ProductExtractorErrorResponse = {
        success: false,
        error:   "Failed to create asin_registry entry (duplicate or DB error).",
      }
      return err
    }
  }

  try {
    await repairPoolStageIfSimulationOnlyCache(workspaceId, asinRegistryId)
    const cacheCreated = await upsertCache(asinRegistryId, req)
    await insertPoolAfterScrape(workspaceId, asinRegistryId)
    const poolId = await fetchPoolId(workspaceId, asinRegistryId)
    const success: ProductExtractorSuccessResponse = {
      success:         true,
      asin,
      asinRegistryId,
      poolId,
      cacheCreated,
    }
    try {
      await addNotification(
        workspaceId,
        "success",
        "Ürün Kaydedildi",
        `${asin} amazon_product_cache'e yazıldı`
      )
    } catch {
      /* bildirim ana akışı bozmasın */
    }
    return success
  } catch (e) {
    console.error("[ProductExtractor] upsertCache / pool failed:", e)
    const err: ProductExtractorErrorResponse = {
      success: false,
      error:   e instanceof Error ? e.message : String(e),
    }
    return err
  }
}

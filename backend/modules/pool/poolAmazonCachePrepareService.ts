// ----------------------------------------------------------------
// poolAmazonCachePrepareService.ts — ensure amazon_product_cache exists
// ----------------------------------------------------------------

import { query } from "../../db/client"
import { scrapeSinglePoolItemById } from "../scraper/amazonScraperService"

export type AmazonCachePrepareReason =
  | "MISSING_ASIN"
  | "PRODUCT_EXTRACT_NOT_SUPPORTED"
  | "PRODUCT_EXTRACT_FAILED"
  | "AMAZON_PRODUCT_NOT_FOUND"
  | "IMAGE_MISSING"
  | "PRICE_MISSING"

export type AmazonCachePrepareResult = {
  ok:                    boolean
  cacheReady:            boolean
  cacheBefore:           boolean
  cachePrepareAttempted: boolean
  cachePrepared:         boolean
  createdOrUpdated?:     boolean
  reason?:               AmazonCachePrepareReason | string
  message?:              string
  productExtractError?:  string
}

const AMAZON_ASIN_REGEX = /^[A-Z0-9]{10}$/

function isAmazonAsin(asin: string | null | undefined): boolean {
  return !!asin && AMAZON_ASIN_REGEX.test(asin.trim().toUpperCase())
}

async function loadPoolCacheState(
  workspaceId: string,
  poolId:      number
): Promise<{
  asin:           string | null
  asinRegistryId: number | null
  hasCache:       boolean
  hasPrice:       boolean
  hasImages:       boolean
  cacheSource:     string | null
  cacheAttributes: unknown
} | null> {
  const result = await query<{
    asin:             string | null
    asin_registry_id: number | null
    price:            number | null
    images:           unknown
    cache_source:     string | null
    cache_attributes: unknown
  }>(
    `SELECT
       ar.asin,
       ap.asin_registry_id,
       apc.price,
       apc.images,
       apc.source AS cache_source,
       apc.attributes AS cache_attributes
     FROM asin_pool ap
     LEFT JOIN asin_registry ar ON ar.id = ap.asin_registry_id
     LEFT JOIN amazon_product_cache apc ON apc.asin_registry_id = ap.asin_registry_id
     WHERE ap.workspace_id = $1 AND ap.id = $2
     LIMIT 1`,
    [workspaceId, poolId]
  )

  const row = result.rows[0]
  if (!row) return null

  const images = Array.isArray(row.images) ? row.images : []
  const hasCache = row.price != null || images.length > 0
  const hasPrice = row.price != null && Number(row.price) > 0
  const hasImages = images.length > 0

  return {
    asin:           row.asin,
    asinRegistryId: row.asin_registry_id,
    hasCache,
    hasPrice,
    hasImages,
    cacheSource: row.cache_source,
    cacheAttributes: row.cache_attributes,
  }
}

export async function ensureAmazonProductCacheForPoolItem(
  workspaceId: string,
  poolId:      number
): Promise<AmazonCachePrepareResult> {
  const state = await loadPoolCacheState(workspaceId, poolId)
  if (!state) {
    return {
      ok: false,
      cacheReady: false,
      cacheBefore: false,
      cachePrepareAttempted: false,
      cachePrepared: false,
      reason: "AMAZON_PRODUCT_NOT_FOUND",
      message: "Pool item not found",
    }
  }

  if (state.hasPrice && state.hasImages) {
    return {
      ok: true,
      cacheReady: true,
      cacheBefore: true,
      cachePrepareAttempted: false,
      cachePrepared: false,
    }
  }

  const cacheBefore = state.hasCache
  const cacheAttributes = state.cacheAttributes && typeof state.cacheAttributes === "object"
    ? state.cacheAttributes as Record<string, unknown>
    : null
  const extensionCapture = state.cacheSource === "extension" || cacheAttributes?.source === "extension"

  if (extensionCapture && !state.hasImages) {
    return {
      ok: false,
      cacheReady: false,
      cacheBefore,
      cachePrepareAttempted: false,
      cachePrepared: false,
      reason: "IMAGE_MISSING",
      message: "Extension-captured product images are missing; real images are required before publish.",
      productExtractError: "EXTENSION_IMAGES_MISSING",
    }
  }

  if (!state.asin?.trim()) {
    return {
      ok: false,
      cacheReady: false,
      cacheBefore,
      cachePrepareAttempted: false,
      cachePrepared: false,
      reason: "MISSING_ASIN",
      message: "Pool item has no ASIN",
    }
  }

  if (!isAmazonAsin(state.asin)) {
    return {
      ok: false,
      cacheReady: false,
      cacheBefore,
      cachePrepareAttempted: false,
      cachePrepared: false,
      reason: "PRODUCT_EXTRACT_NOT_SUPPORTED",
      message: "Non-Amazon pool items require extension product extract before live publish.",
    }
  }

  const scrape = await scrapeSinglePoolItemById(workspaceId, poolId, { preservePoolStage: true })
  if (!scrape.ok) {
    return {
      ok: false,
      cacheReady: false,
      cacheBefore,
      cachePrepareAttempted: true,
      cachePrepared: false,
      reason: "PRODUCT_EXTRACT_FAILED",
      message: "Amazon product data could not be prepared automatically.",
      productExtractError: scrape.message?.slice(0, 200),
    }
  }

  const after = await loadPoolCacheState(workspaceId, poolId)
  if (!after?.hasPrice || !after.hasImages) {
    const reason: AmazonCachePrepareReason = !after?.hasPrice
      ? "PRICE_MISSING"
      : "IMAGE_MISSING"
    return {
      ok: false,
      cacheReady: false,
      cacheBefore,
      cachePrepareAttempted: true,
      cachePrepared: false,
      reason,
      message: "Amazon product data could not be prepared automatically.",
      productExtractError: reason,
    }
  }

  return {
    ok: true,
    cacheReady: true,
    cacheBefore,
    cachePrepareAttempted: true,
    cachePrepared: true,
    createdOrUpdated: scrape.createdOrUpdated,
    message: cacheBefore
      ? "Amazon product cache refreshed"
      : "Amazon product cache prepared automatically",
  }
}

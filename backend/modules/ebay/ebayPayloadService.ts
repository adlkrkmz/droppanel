// ----------------------------------------------------------------
// ebayPayloadService.ts
//
// Listing payload: pricing, description template, ai_listing_cache item_specifics.
// Publish uses payload.assignedStoreId to load store_settings (policies, merchant key).
// ----------------------------------------------------------------

import { query }          from "../../db/client"
import { renderTemplate } from "../templates/templateService"

const FALLBACK_PRICE = 19.99
const EBAY_FEE_RATE = 0.23

type EbayPayloadSourceRow = {
  poolId:              number
  asinRegistryId:      number
  asin:                string
  assignedStoreId:     number
  storeCode:           string
  storeName:           string
  registryBrand:       string | null
  registryTitle:       string | null
  cacheBrand:          string | null
  cacheTitle:          string | null
  amazonPrice:         string | null
  amazonCategory:      string | null
  images:              unknown
  aiTitle:             string | null
  aiDescription:       string | null
  aiBullets:           unknown
  aiItemSpecifics:     unknown
  settingsEnabled:     boolean | null
  markupPercent:       string | null
  profitMarginPercent: string | null
  taxEstimatePercent:  string | null
  ebayFeePercent:      string | null
  templateId:          string | null
}

export type EbayListingPayload = {
  workspaceId:       string
  /** Same as assignedStoreId; matches listing_history.store_id */
  storeId:           number
  poolId:            number
  asinRegistryId:    number
  asin:              string
  assignedStoreId:   number
  storeCode:         string
  storeName:         string
  sku:               string
  title:             string
  description:       string
  brand:             string
  bullets:           string[]
  amazonCategory:   string
  price:             number
  amazonCost:        number
  pricingSource:     "calculated" | "fallback"
  templateId:        string
  descriptionLength: number
  images:            string[]
  quantity:          number
  condition:         "NEW"
  itemSpecifics:     Record<string, string>
  /** Kaynak ürün özellikleri (ör. Amazon); boyut/ağırlık parse için isteğe bağlı */
  specs?:            Record<string, string>
}

function buildSku(asin: string, storeCode: string): string {
  return `DP${asin}${storeCode}`
}

function parseImages(value: unknown): string[] {
  if (Array.isArray(value)) {
    return (value as unknown[])
      .map(v => String(v).trim())
      .filter(v => v.length > 0)
  }
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value)
      if (Array.isArray(parsed)) {
        return (parsed as unknown[])
          .map(v => String(v).trim())
          .filter(v => v.length > 0)
      }
    } catch { return [] }
  }
  return []
}

function parseBullets(value: unknown): string[] {
  if (Array.isArray(value)) {
    return (value as unknown[])
      .map(v => String(v).trim())
      .filter(v => v.length > 0)
  }
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value)
      if (Array.isArray(parsed)) {
        return (parsed as unknown[])
          .map(v => String(v).trim())
          .filter(v => v.length > 0)
      }
    } catch { return [] }
  }
  return []
}

function parseItemSpecifics(value: unknown): Record<string, string> {
  if (value === null || value === undefined) return {}
  if (typeof value === "object" && !Array.isArray(value)) {
    const o = value as Record<string, unknown>
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(o)) {
      const key = String(k).trim().slice(0, 65)
      const val = String(v ?? "").trim().slice(0, 65)
      if (key && val) out[key] = val
    }
    return out
  }
  if (typeof value === "string") {
    try {
      return parseItemSpecifics(JSON.parse(value) as unknown)
    } catch { return {} }
  }
  return {}
}

function resolveTitle(row: EbayPayloadSourceRow): string {
  return (
    row.aiTitle?.trim() ||
    row.cacheTitle?.trim() ||
    row.registryTitle?.trim() ||
    `Product Listing for ${row.asin}`
  ).slice(0, 80)
}

function resolveBrand(row: EbayPayloadSourceRow): string {
  return (
    row.cacheBrand?.trim() ||
    row.registryBrand?.trim() ||
    "Generic"
  )
}

function parseNum(val: string | null | undefined): number | null {
  if (!val) return null
  const n = parseFloat(val)
  return isFinite(n) ? n : null
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

type PriceResolution = {
  price:         number
  amazonCost:    number
  pricingSource: "calculated" | "fallback"
}

function resolveListingPrice(row: EbayPayloadSourceRow): PriceResolution {
  const amazonCost          = parseNum(row.amazonPrice)
  const settingsEnabled     = row.settingsEnabled === true
  const markupPercent       = parseNum(row.markupPercent)

  const costForFallback = (amazonCost !== null && amazonCost > 0)
    ? amazonCost
    : FALLBACK_PRICE

  if (!settingsEnabled) {
    return { price: FALLBACK_PRICE, amazonCost: costForFallback, pricingSource: "fallback" }
  }
  if (amazonCost === null || amazonCost <= 0) {
    return { price: FALLBACK_PRICE, amazonCost: costForFallback, pricingSource: "fallback" }
  }
  if (markupPercent === null || markupPercent <= 0) {
    return { price: FALLBACK_PRICE, amazonCost, pricingSource: "fallback" }
  }

  return {
    price: round2((amazonCost * (1 + markupPercent / 100)) / (1 - EBAY_FEE_RATE)),
    amazonCost,
    pricingSource: "calculated",
  }
}

type DescriptionResolution = {
  description: string
  templateId:  string
}

function resolveDescription(
  row:    EbayPayloadSourceRow,
  title:  string,
  brand:  string,
  images: string[],
  bullets: string[]
): DescriptionResolution {
  const rawTemplateId = row.templateId?.trim() ?? null
  const templateId    = rawTemplateId ?? "1"

  try {
    const result = renderTemplate(templateId, {
      title,
      brand,
      bullets:      bullets.length > 0 ? bullets : null,
      imageUrls:    images.length   > 0 ? images  : null,
      sellerNote:   null,
      shippingNote: null,
      returnNote:   null,
    })
    return { description: result.html, templateId: result.templateId }
  } catch (err) {
    console.warn(
      `[PayloadService] renderTemplate failed for ASIN=${row.asin}: ${err instanceof Error ? err.message : err}`
    )
    const fallback = row.aiDescription?.trim() || `${title}\n\nProduct prepared for ${brand}.`
    return { description: fallback, templateId: "fallback" }
  }
}

export async function buildEbayListingPayloads(
  workspaceId: string,
  limit = 100
): Promise<EbayListingPayload[]> {
  const sql = `
    SELECT
      ap.id                          AS "poolId",
      ap.asin_registry_id            AS "asinRegistryId",
      ar.asin                        AS "asin",
      ap.assigned_store_id           AS "assignedStoreId",
      s.store_code                   AS "storeCode",
      s.name                         AS "storeName",
      ar.brand                       AS "registryBrand",
      ar.title                       AS "registryTitle",
      apc.brand                      AS "cacheBrand",
      apc.title                      AS "cacheTitle",
      apc.price::text                AS "amazonPrice",
      apc.attributes->>'category'   AS "amazonCategory",
      apc.images                     AS "images",
      ailc.title                     AS "aiTitle",
      ailc.description               AS "aiDescription",
      ailc.bullets                   AS "aiBullets",
      ailc.item_specifics            AS "aiItemSpecifics",
      ss.enabled                     AS "settingsEnabled",
      ss.markup_percent::text        AS "markupPercent",
      ss.profit_margin_percent::text AS "profitMarginPercent",
      ss.tax_estimate_percent::text  AS "taxEstimatePercent",
      ss.ebay_fee_percent::text      AS "ebayFeePercent",
      ss.template_id                 AS "templateId"
    FROM asin_pool ap
    INNER JOIN asin_registry ar
      ON ar.id = ap.asin_registry_id
    INNER JOIN stores s
      ON s.id = ap.assigned_store_id
    LEFT JOIN amazon_product_cache apc
      ON apc.asin_registry_id = ap.asin_registry_id
    LEFT JOIN ai_listing_cache ailc
      ON ailc.workspace_id = ap.workspace_id
     AND ailc.asin_registry_id = ap.asin_registry_id
    LEFT JOIN store_settings ss
      ON ss.workspace_id = ap.workspace_id
     AND ss.store_id = ap.assigned_store_id
    WHERE ap.workspace_id = $1
      AND ap.status = 'ready'
      AND ap.pipeline_stage = 'ai_generated'
      AND ap.assigned_store_id IS NOT NULL
      AND s.status = 'active'
    ORDER BY ap.priority DESC, ap.id ASC
    LIMIT $2
  `

  const result = await query<EbayPayloadSourceRow>(sql, [workspaceId, limit])

  return result.rows.map(row => {
    const title  = resolveTitle(row)
    const brand  = resolveBrand(row)
    const images = parseImages(row.images)
    const bullets = parseBullets(row.aiBullets)

    const { price, amazonCost, pricingSource } = resolveListingPrice(row)
    const { description, templateId }          = resolveDescription(row, title, brand, images, bullets)

    let itemSpecifics = parseItemSpecifics(row.aiItemSpecifics)
    if (!itemSpecifics["Brand"]?.trim()) {
      itemSpecifics = { ...itemSpecifics, Brand: String(brand).trim().slice(0, 65) }
    }

    return {
      workspaceId,
      storeId:           row.assignedStoreId,
      poolId:            row.poolId,
      asinRegistryId:    row.asinRegistryId,
      asin:              row.asin,
      assignedStoreId:   row.assignedStoreId,
      storeCode:         row.storeCode,
      storeName:         row.storeName,
      sku:               buildSku(row.asin, row.storeCode),
      title,
      description,
      brand,
      bullets,
      amazonCategory: row.amazonCategory?.trim() ?? "",
      price,
      amazonCost,
      pricingSource,
      templateId,
      descriptionLength: description.length,
      images,
      quantity:          1,
      condition:         "NEW",
      itemSpecifics,
    }
  })
}

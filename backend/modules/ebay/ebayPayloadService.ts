// ----------------------------------------------------------------
// ebayPayloadService.ts
//
// Listing payload: pricing, description template, ai_listing_cache item_specifics.
// Publish uses payload.assignedStoreId to load store_settings (policies, merchant key).
// ----------------------------------------------------------------

import { query }          from "../../db/client"
import { renderTemplate } from "../templates/templateService"
import { calculateListingPrice } from "../pricing/pricingService"
import type { PricingMode, PromotionPricingContext, TieredProfitOverrides } from "../pricing/pricingTypes"
import { buildTitleBotTitle, type TitleMode } from "../titleBot/titleBotService"
import { allowsAiCache } from "../listingAiMode/listingAiModeService"
import {
  buildBulletsFromAmazon,
  buildRuleBasedItemSpecifics,
  buildTemplateDescriptionFallback,
  parseAmazonAttributes,
} from "../listingFallback/listingFallbackService"

export type { TitleMode }

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
  pricingMode:         PricingMode | null
  percentageNetProfitPercent: string | null
  tieredProfitOverrides: unknown
  profitMarginPercent: string | null
  taxEstimatePercent:  string | null
  ebayFeePercent:      string | null
  templateId:          string | null
  cacheAttributes:   unknown
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

function cacheAttRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
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

const MIN_TITLE_LEN = 3

function sanitizeListingTitle(raw: string, asin: string): string {
  const cleaned = raw.replace(/\s+/g, " ").trim().slice(0, 80)
  if (cleaned.length >= MIN_TITLE_LEN) return cleaned
  return `Product Listing for ${asin}`.slice(0, 80)
}

function amazonOriginalTitle(row: EbayPayloadSourceRow): string {
  return row.cacheTitle?.trim() || row.registryTitle?.trim() || ""
}

function resolveTitle(row: EbayPayloadSourceRow, titleMode: TitleMode = "ai"): string {
  const amazonTitle = amazonOriginalTitle(row)
  const brand = row.cacheBrand?.trim() || row.registryBrand?.trim() || null
  const fallback = sanitizeListingTitle(
    amazonTitle || `Product Listing for ${row.asin}`,
    row.asin
  )

  if (titleMode === "original") {
    return fallback
  }

  if (titleMode === "ai") {
    const ai = row.aiTitle?.trim()
    if (ai && ai.length >= MIN_TITLE_LEN) {
      return sanitizeListingTitle(ai, row.asin)
    }
    return fallback
  }

  // titlebot — fallback to Amazon original only (never AI)
  if (amazonTitle) {
    try {
      const bot = buildTitleBotTitle({ amazonTitle, brand })
      if (bot.title && bot.title.trim().length >= MIN_TITLE_LEN) {
        console.log("[TitleBot] final", JSON.stringify({
          asin:         row.asin,
          length:       bot.title.length,
          strategy:     bot.strategy ?? "titlebot",
          productType:  bot.productType ?? null,
          slots:        bot.slots ?? {},
          dropped:      bot.droppedTokens?.length ?? 0,
          qualityScore: bot.qualityScore ?? null,
          fallbackUsed: bot.fallbackUsed,
          warnings:     bot.warnings ?? [],
        }))
        return sanitizeListingTitle(bot.title, row.asin)
      }
      console.warn(`[resolveTitle] titlebot empty asin=${row.asin} fallback=amazon`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.warn(`[resolveTitle] titlebot error asin=${row.asin} fallback=amazon: ${msg}`)
    }
    return fallback
  }

  return fallback
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

function resolveListingPrice(
  row: EbayPayloadSourceRow,
  promotion?: PromotionPricingContext | null
): PriceResolution {
  const amazonCost = parseNum(row.amazonPrice)
  const settingsEnabled = row.settingsEnabled === true
  if (!settingsEnabled) {
    throw new Error(`PRICING_SETTINGS_DISABLED: store=${row.storeCode}`)
  }
  if (amazonCost === null || amazonCost <= 0) {
    throw new Error(`INVALID_AMAZON_COST: asin=${row.asin}`)
  }
  const percentage = parseNum(row.percentageNetProfitPercent)
  if (percentage === null || percentage <= 0 || !row.pricingMode) {
    throw new Error(`INVALID_PRICING_SETTINGS: store=${row.storeCode}`)
  }
  const result = calculateListingPrice({
    amazonCost,
    pricingMode: row.pricingMode,
    percentageNetProfitPercent: percentage,
    tieredProfitOverrides: row.tieredProfitOverrides as TieredProfitOverrides,
    promotion,
  })
  return {
    price: result.calculatedListingPrice,
    amazonCost,
    pricingSource: "calculated",
  }
}

type DescriptionResolution = {
  description: string
  templateId:  string
}

function resolveBullets(
  row:       EbayPayloadSourceRow,
  title:     string,
  titleMode: TitleMode
): string[] {
  const amazon = parseAmazonAttributes(row.cacheAttributes)

  if (allowsAiCache(titleMode)) {
    const fromCache = parseBullets(row.aiBullets)
    if (fromCache.length > 0) return fromCache
    return buildBulletsFromAmazon(amazon.bullets, title)
  }

  return buildBulletsFromAmazon(amazon.bullets, title)
}

function resolveItemSpecifics(
  row:       EbayPayloadSourceRow,
  brand:     string,
  titleMode: TitleMode
): Record<string, string> {
  const amazon = parseAmazonAttributes(row.cacheAttributes)
  const amazonTitle =
    row.cacheTitle?.trim() ||
    row.registryTitle?.trim() ||
    ""

  let itemSpecifics: Record<string, string>

  if (allowsAiCache(titleMode)) {
    itemSpecifics = parseItemSpecifics(row.aiItemSpecifics)
    if (Object.keys(itemSpecifics).length === 0) {
      const att = cacheAttRecord(row.cacheAttributes)
      itemSpecifics = buildRuleBasedItemSpecifics({
        asin:  row.asin,
        title: amazonTitle,
        brand,
        specs: amazon.specs,
        isPrime: att.isPrime === true,
        isFreeShipping: att.isFreeShipping === true,
      })
    }
  } else {
    const att = cacheAttRecord(row.cacheAttributes)
    itemSpecifics = buildRuleBasedItemSpecifics({
      asin:  row.asin,
      title: amazonTitle,
      brand,
      specs: amazon.specs,
      isPrime: att.isPrime === true,
      isFreeShipping: att.isFreeShipping === true,
    })
  }

  if (!itemSpecifics["Brand"]?.trim()) {
    itemSpecifics = { ...itemSpecifics, Brand: String(brand).trim().slice(0, 65) }
  }
  return itemSpecifics
}

function resolveDescription(
  row:       EbayPayloadSourceRow,
  title:     string,
  brand:     string,
  images:    string[],
  bullets:   string[],
  titleMode: TitleMode
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
    if (allowsAiCache(titleMode) && row.aiDescription?.trim()) {
      return { description: row.aiDescription.trim(), templateId: "fallback" }
    }
    return {
      description: buildTemplateDescriptionFallback(title, brand, bullets),
      templateId: "fallback",
    }
  }
}

export type BuildEbayPayloadOptions = {
  titleMode?:       TitleMode
  /** When targeting explicit pool IDs, fall back to this store if assigned_store_id is unset. */
  publishStoreId?:  number
  promotion?:       PromotionPricingContext | null
}

export async function buildEbayListingPayloads(
  workspaceId: string,
  limit = 100,
  poolIds?: number[],
  options?: BuildEbayPayloadOptions
): Promise<EbayListingPayload[]> {
  const { buildPoolEligibilityWhere } = await import("../pool/poolEligibilityService")
  const titleMode: TitleMode = options?.titleMode ?? "ai"
  const targetedPoolMode = !!(poolIds && poolIds.length > 0)
  const publishStoreId = options?.publishStoreId ?? null

  const poolFilter = targetedPoolMode
    ? `AND ap.id = ANY($3::bigint[])`
    : ""
  const eligibilityFilter = buildPoolEligibilityWhere("ap")
  const statusFilter = targetedPoolMode
    ? `ap.status IN ('ready', 'skipped')`
    : `ap.status = 'ready'`
  const storeJoin = targetedPoolMode && publishStoreId
    ? `INNER JOIN stores s ON s.id = COALESCE(ap.assigned_store_id, $4::bigint)`
    : `INNER JOIN stores s ON s.id = ap.assigned_store_id`
  const assignedStoreFilter = targetedPoolMode && publishStoreId
    ? `($4::bigint IS NOT NULL)`
    : `ap.assigned_store_id IS NOT NULL`

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
      ss.pricing_mode                AS "pricingMode",
      ss.percentage_net_profit_percent::text AS "percentageNetProfitPercent",
      ss.tiered_profit_overrides      AS "tieredProfitOverrides",
      ss.profit_margin_percent::text AS "profitMarginPercent",
      ss.tax_estimate_percent::text  AS "taxEstimatePercent",
      ss.ebay_fee_percent::text      AS "ebayFeePercent",
      ss.template_id                 AS "templateId",
      apc.attributes                     AS "cacheAttributes"
    FROM asin_pool ap
    INNER JOIN asin_registry ar
      ON ar.id = ap.asin_registry_id
    ${storeJoin}
    LEFT JOIN amazon_product_cache apc
      ON apc.asin_registry_id = ap.asin_registry_id
    LEFT JOIN ai_listing_cache ailc
      ON ailc.workspace_id = ap.workspace_id
     AND ailc.asin_registry_id = ap.asin_registry_id
    LEFT JOIN store_settings ss
      ON ss.workspace_id = ap.workspace_id
     AND ss.store_id = s.id
    WHERE ap.workspace_id = $1
      AND ${statusFilter}
      AND ap.pipeline_stage IN ('validated', 'scraped', 'ai_generated')
      AND ${assignedStoreFilter}
      AND apc.asin_registry_id IS NOT NULL
      AND s.status = 'active'
      AND ${eligibilityFilter}
      ${poolFilter}
    ORDER BY ap.priority DESC, ap.id ASC
    LIMIT $2
  `

  const params: unknown[] = targetedPoolMode && publishStoreId
    ? [workspaceId, limit, poolIds, publishStoreId]
    : targetedPoolMode
      ? [workspaceId, limit, poolIds]
      : [workspaceId, limit]

  const result = await query<EbayPayloadSourceRow>(sql, params)

  const rows = result.rows.map(row => {
    const title  = resolveTitle(row, titleMode)
    const brand  = resolveBrand(row)
    const images = parseImages(row.images)
    const bullets = resolveBullets(row, title, titleMode)

    const { price, amazonCost, pricingSource } = resolveListingPrice(row, options?.promotion)
    const { description, templateId }          = resolveDescription(
      row, title, brand, images, bullets, titleMode
    )

    const itemSpecifics = resolveItemSpecifics(row, brand, titleMode)
    const amazonParsed  = parseAmazonAttributes(row.cacheAttributes)

    const canonicalStoreId = publishStoreId ?? row.assignedStoreId

    return {
      workspaceId,
      storeId:           canonicalStoreId,
      poolId:            row.poolId,
      asinRegistryId:    row.asinRegistryId,
      asin:              row.asin,
      assignedStoreId:   canonicalStoreId,
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
      specs: amazonParsed.specs,
    }
  })

  const validRows: EbayListingPayload[] = []
  const zeropricePoolIds: number[] = []

  for (let i = 0; i < rows.length; i++) {
    const sourceRow   = result.rows[i]
    const payload     = rows[i]
    const amazonPrice = parseNum(sourceRow.amazonPrice)
    if (!amazonPrice || amazonPrice <= 0) {
      zeropricePoolIds.push(payload.poolId)
    } else {
      validRows.push(payload as EbayListingPayload)
    }
  }

  if (zeropricePoolIds.length > 0) {
    await query(
      `UPDATE asin_pool
     SET pipeline_stage = 'validated',
         ai_status = null,
         updated_at = NOW()
     WHERE id = ANY($1::bigint[])`,
      [zeropricePoolIds]
    )
    console.warn(`[PayloadBuilder] ${zeropricePoolIds.length} ürün fiyat=0, validated'a geri alındı:`, zeropricePoolIds)
  }

  return validRows
}

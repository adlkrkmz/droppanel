// ----------------------------------------------------------------
// ebayInventoryService.ts
//
// Publish: processAndUploadImages -> inventory item ->
// try ensure eBay warehouse-{storeCode} location (GET / POST, hata → log) ->
// Taxonomy getCategorySuggestions(title) -> (Gemini selectBestCategory if 2+ öneri) -> createOffer -> publishOffer
//
// "Offer entity already exists": offerId parse / getOffers(sku) ->
// updateOffer(categoryId, …) -> publishOffer.
//
// Model, MPN, UPC, Type, EAN, ISBN → her zaman "Does Not Apply" (AI/specs yok sayılır).
// Brand → itemSpecifics / payload.brand, yoksa "Unbranded"; diğer aspect’ler AI’dan gelir.
// ----------------------------------------------------------------

import { isBlockedKey, selectBestCategory } from "../aiListing/aiListingService"
import { getValidAccessToken } from "../ebayOAuth/ebayOAuthService"
import { processAndUploadImages } from "../imageProcessor/imageProcessorService"
import { warehouseMerchantLocationKey } from "../settings/settingsService"
import { getSettingsByStore } from "../storeSettings/storeSettingsRepository"
import type { StoreSettingsRow } from "../storeSettings/storeSettingsTypes"
import type { EbayMerchantLocationAddress } from "./ebayApiClient"
import { EbayApiClient } from "./ebayApiClient"
import type {
  EbayCreateOfferRequest,
  EbayInventoryItemRequest,
  InventoryFlowResult,
} from "./ebayApiTypes"
import type { EbayListingPayload } from "./ebayPayloadService"

const SETTINGS_ERROR =
  "Store settings not configured. Please set policies in Settings page."

const DEFAULT_MARKETPLACE = "EBAY_US"

const DOES_NOT_APPLY = ["Does Not Apply"] as const

/** AI/specs’ten gelen bu anahtarlar silinir; sabit "Does Not Apply" yazılır */
const ASPECT_KEYS_FORCE_DNA = [
  "Model",
  "model",
  "MPN",
  "Mpn",
  "mpn",
  "UPC",
  "Upc",
  "upc",
  "Type",
  "type",
  "EAN",
  "Ean",
  "ean",
  "ISBN",
  "Isbn",
  "isbn",
] as const

export type InventoryFlowClientOptions = {
  sandbox:        boolean
  simulationMode: boolean
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function replaceAllExact(haystack: string, needle: string, replacement: string): string {
  if (!needle) return haystack
  return haystack.replace(new RegExp(escapeRegExp(needle), "g"), replacement)
}

function rewriteDescriptionImageUrls(description: string, fromUrls: string[], toUrls: string[]): string {
  let out = description

  // Replace explicit known URLs first (most reliable)
  const n = Math.min(fromUrls.length, toUrls.length)
  for (let i = 0; i < n; i++) {
    const from = (fromUrls[i] ?? "").trim()
    const to = (toUrls[i] ?? "").trim()
    if (!from || !to) continue
    out = replaceAllExact(out, from, to)
  }

  // As a fallback, ensure the first <img src="..."> points to toUrls[0]
  const firstTo = (toUrls[0] ?? "").trim()
  if (firstTo) {
    out = out.replace(
      /<img\s+[^>]*src=(["'])([^"']+)\1([^>]*)>/i,
      (_m, quote: string, _src: string, rest: string) => `<img src=${quote}${firstTo}${quote}${rest}>`
    )
  }

  return out
}

function getWorkspaceId(): string {
  const id = process.env.WORKSPACE_ID
  if (!id) throw new Error("WORKSPACE_ID is not defined in environment")
  return id
}

function itemSpecificsToAspects(specs: Record<string, string>): Record<string, string[]> {
  const aspects: Record<string, string[]> = {}
  for (const [k, v] of Object.entries(specs)) {
    const key = k.trim()
    const val = v.trim()
    if (!key || !val) continue
    aspects[key] = [val]
  }
  return aspects
}

function cleanAspectValue(raw: string): string {
  // 1) Comma-separated values -> take only the first part
  const first = raw.split(",")[0]?.trim() ?? ""

  // 2) If empty -> Does Not Apply
  if (!first) return "Does Not Apply"

  // 3) Enforce max length 65 chars
  const trimmed = first.length > 65 ? first.slice(0, 65).trim() : first
  return trimmed.length > 0 ? trimmed : "Does Not Apply"
}

function buildProductAspects(payload: EbayListingPayload): Record<string, string[]> {
  const aspects = itemSpecificsToAspects(payload.itemSpecifics)

  // Normalize all values upfront (comma split + max length + empty fallback).
  for (const k of Object.keys(aspects)) {
    aspects[k] = aspects[k].map(v => cleanAspectValue(v))
  }

  delete aspects["brand"]

  for (const k of ASPECT_KEYS_FORCE_DNA) {
    delete aspects[k]
  }

  const normalizedKey = (k: string): string => k.toLowerCase().replace(/\s+/g, "")

  // Fields that must never be sent as-is in aspects (if they arrive, they are removed).
  const blockedNormalizedKeys = new Set([
    // ASIN / asin
    "asin",
    // Model Number / model number / item model number
    "modelnumber",
    "itemmodelnumber",
    // Recommended Uses For Product / Recommended Use
    "recommendedusesforproduct",
    "recommendeduse",
    // Manufacturer Part Number / manufacturer part number
    "manufacturerpartnumber",
    // Part Number / part number
    "partnumber",
    // Date First Available
    "datefirstavailable",
    // Target Audience
    "targetaudience",
    // Pattern / Theme / Occasion
    "pattern",
    "theme",
    "occasion",
  ])

  let manufacturerFound = false
  let featuresValue: string | null = null

  const featuresNormalizedKey = "features"
  const manufacturerNormalizedKey = "manufacturer"

  for (const k of Object.keys(aspects)) {
    const nk = normalizedKey(k)

    if (nk === manufacturerNormalizedKey) {
      manufacturerFound = true
      delete aspects[k]
      continue
    }

    if (nk === featuresNormalizedKey) {
      const v = (aspects[k]?.[0] ?? "").trim()
      delete aspects[k]

      // cleanAspectValue() converts empties into "Does Not Apply". Treat that as empty.
      if (v.length > 0 && v !== "Does Not Apply") {
        featuresValue = v
      }
      continue
    }

    if (blockedNormalizedKeys.has(nk)) {
      delete aspects[k]
    }
  }

  if (manufacturerFound) {
    aspects["Manufacturer"] = ["Does Not Apply"]
  }

  if (featuresValue && featuresValue.trim().length > 0) {
    aspects["Features"] = [featuresValue.trim()]
  } else {
    const rawFallback = payload.bullets?.[0] ?? ""
    const fallback65 = rawFallback.trim().slice(0, 65).trim()
    aspects["Features"] = [fallback65.length > 0 ? fallback65 : "Does Not Apply"]
  }

  const brandVal =
    payload.itemSpecifics["Brand"]?.trim() ||
    payload.itemSpecifics["brand"]?.trim() ||
    (aspects["Brand"]?.[0] ?? "").trim() ||
    payload.brand?.trim()
  delete aspects["Brand"]

  const brandClean = cleanAspectValue(brandVal)
  aspects["Brand"] = [brandClean]
  aspects["Model"] = [...DOES_NOT_APPLY]
  aspects["MPN"]   = [...DOES_NOT_APPLY]
  aspects["UPC"]   = [...DOES_NOT_APPLY]
  aspects["Type"]  = [...DOES_NOT_APPLY]
  aspects["EAN"]   = [...DOES_NOT_APPLY]
  aspects["ISBN"]  = [...DOES_NOT_APPLY]

  return aspects
}

function parseOfferIdFromCreateOfferError(message: string): string | null {
  const idx = message.indexOf("{")
  if (idx >= 0) {
    try {
      const o = JSON.parse(message.slice(idx)) as {
        errors?: { parameters?: { name?: string; value?: string }[] }[]
      }
      for (const err of o.errors ?? []) {
        for (const p of err.parameters ?? []) {
          const n = String(p.name ?? "").toLowerCase()
          const v = String(p.value ?? "").trim()
          if ((n === "offerid" || n === "offer_id") && v.length > 0) return v
        }
      }
    } catch {
      /* ignore */
    }
  }
  const m = message.match(/"offerId"\s*:\s*"(\d+)"/i)
  if (m?.[1]) return m[1]
  return null
}

function isOfferAlreadyExistsError(message: string): boolean {
  return /Offer entity already exists/i.test(message)
}

async function createOfferOrExisting(
  client: EbayApiClient,
  offerBody: EbayCreateOfferRequest,
  sku: string
): Promise<{ offerId: string; fromDuplicate: boolean }> {
  try {
    const r = await client.createOffer(offerBody)
    return { offerId: r.offerId, fromDuplicate: false }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (!isOfferAlreadyExistsError(msg)) throw e

    const fromErr = parseOfferIdFromCreateOfferError(msg)
    if (fromErr) {
      console.log(
        `  [InventoryFlow] createOffer duplicate — existing offerId=${fromErr} (will updateOffer)`
      )
      return { offerId: fromErr, fromDuplicate: true }
    }

    const page = await client.getOffers(sku, 20, 0)
    const offers = page.offers ?? []
    const draft = offers.find(
      o => o.sku === sku && o.offerId && (!o.listing?.listingId || o.status === "UNPUBLISHED")
    )
    const anySku = offers.find(o => o.sku === sku && o.offerId)
    const pick = draft?.offerId ?? anySku?.offerId
    if (pick) {
      console.log(
        `  [InventoryFlow] createOffer duplicate — getOffers(sku) offerId=${pick} (will updateOffer)`
      )
      return { offerId: pick, fromDuplicate: true }
    }

    throw e
  }
}

function merchantAddressFromStoreRow(row: StoreSettingsRow): EbayMerchantLocationAddress | null {
  const country = row.addressCountry?.trim()
  const city = row.addressCity?.trim()
  const state = row.addressState?.trim()
  const line1 = row.addressLine1?.trim()
  const zip = row.addressZip?.trim()
  if (!country || !city || !state || !line1 || !zip) return null
  return {
    addressLine1:    line1,
    city,
    stateOrProvince: state,
    postalCode:      zip,
    country,
  }
}

async function tryEnsureWarehouseLocation(
  client: EbayApiClient,
  storeCode: string,
  storeRow: StoreSettingsRow
): Promise<void> {
  const whKey = warehouseMerchantLocationKey(storeCode)
  const addr  = merchantAddressFromStoreRow(storeRow)
  if (!addr) {
    console.warn(
      `[InventoryFlow] Incomplete address in store_settings — skip eBay location sync for ${whKey}`
    )
    return
  }
  try {
    const res = await client.getMerchantLocation(whKey)
    if (res.kind === "error") {
      console.warn(`[InventoryFlow] getMerchantLocation(${whKey}): ${res.message}`)
      return
    }
    if (res.kind === "found") return
    await client.createMerchantLocation(whKey, addr)
    console.log(`[InventoryFlow] eBay merchant location created: ${whKey}`)
  } catch (e) {
    console.warn(
      `[InventoryFlow] merchant location ${whKey}: ${e instanceof Error ? e.message : String(e)}`
    )
  }
}

export async function runInventoryFlow(
  payload: EbayListingPayload,
  options: InventoryFlowClientOptions
): Promise<InventoryFlowResult> {
  const startTime = Date.now()
  const { poolId, asin, sku } = payload
  const whKey = warehouseMerchantLocationKey(payload.storeCode)

  const result: InventoryFlowResult = {
    poolId,
    asin,
    sku,
    inventoryItemStatus: "failed",
    offerStatus:         "failed",
    publishStatus:       "failed",
    ebayOfferId:         null,
    ebayListingId:       null,
    error:               null,
    durationMs:          0,
  }

  try {
    const workspaceId = getWorkspaceId()
    const accessToken = await getValidAccessToken(
      workspaceId,
      payload.storeCode,
      options.simulationMode
    )
    const client = new EbayApiClient({
      oauthToken:     accessToken,
      sandbox:        options.sandbox,
      simulationMode: options.simulationMode,
    })

    const storeRow = await getSettingsByStore(workspaceId, payload.assignedStoreId)
    if (!storeRow) {
      throw new Error(SETTINGS_ERROR)
    }

    const fulfillmentPolicyId = storeRow.fulfillmentPolicyId?.trim() ?? ""
    const paymentPolicyId     = storeRow.paymentPolicyId?.trim()     ?? ""
    const returnPolicyId      = storeRow.returnPolicyId?.trim()      ?? ""

    if (!fulfillmentPolicyId || !paymentPolicyId || !returnPolicyId) {
      throw new Error(SETTINGS_ERROR)
    }

    console.log(`  [InventoryFlow] Upload ${payload.images.length} image(s) to R2 for ASIN=${asin}`)
    console.log("[InventoryFlow] payload.images:", payload.images?.slice(0, 2))
    let imageUrls = await processAndUploadImages({
      imageUrls: payload.images,
      asin:      payload.asin,
    })
    console.log("[InventoryFlow] Image URLs:", imageUrls.slice(0, 2))

    if (!imageUrls || imageUrls.length === 0) {
      console.warn("[InventoryFlow] No images available, using placeholder")
      imageUrls = []
    }

    let description = rewriteDescriptionImageUrls(payload.description, payload.images, imageUrls)
    description = description.replace("HERO_IMAGE_PLACEHOLDER", imageUrls[0] || "")

    await tryEnsureWarehouseLocation(client, payload.storeCode, storeRow)

    const suggestions = await client.getCategorySuggestions(payload.title, payload.amazonCategory)
    const categoryId =
      suggestions.length > 1
        ? await selectBestCategory(payload.title, payload.itemSpecifics, suggestions)
        : suggestions[0]?.categoryId ?? "0"
    console.log(`  [InventoryFlow] categoryId=${categoryId} (taxonomy${suggestions.length > 1 ? "+gemini" : ""})`)

    {
      const raw = payload.itemSpecifics ?? {}
      const cleaned: Record<string, string> = {}
      for (const [k, v] of Object.entries(raw)) {
        if (isBlockedKey(k)) continue
        const s = String(v).trim()
        if (s.length === 0) continue
        cleaned[k] = s
      }
      payload = { ...payload, itemSpecifics: cleaned }
      console.log(
        "[InventoryFlow] itemSpecifics after sanitize:",
        JSON.stringify(payload.itemSpecifics)
      )
    }

    // Dimensions parse
    const dimSources = [
      payload.itemSpecifics?.["Product Dimensions"],
      payload.itemSpecifics?.["Item Dimensions D x W x H"],
      payload.itemSpecifics?.["Item Dimensions W x H"],
      payload.itemSpecifics?.["Item Dimensions L x W x H"],
      payload.itemSpecifics?.["Item Dimensions L x W"],
      payload.itemSpecifics?.["Item Dimensions"],
      payload.itemSpecifics?.["Size"],
    ]

    for (const dims of dimSources) {
      if (!dims || typeof dims !== "string") continue
      const cleanDims = dims.replace(/\\"/g, "").replace(/"/g, "").replace(/'/g, "").trim()
      console.log("[InventoryFlow] cleanDims:", cleanDims)

      // D x W x H
      const dwh = cleanDims.match(/([0-9.]+)\s*D\s*[xX×]\s*([0-9.]+)\s*W\s*[xX×]\s*([0-9.]+)\s*H/i)
      if (dwh) {
        console.log("[InventoryFlow] matched DWH:", dwh[1], dwh[2], dwh[3])
        if (!payload.itemSpecifics["Item Length"]) payload.itemSpecifics["Item Length"] = dwh[1] + " in"
        if (!payload.itemSpecifics["Item Width"]) payload.itemSpecifics["Item Width"] = dwh[2] + " in"
        if (!payload.itemSpecifics["Item Height"]) payload.itemSpecifics["Item Height"] = dwh[3] + " in"
        break
      }

      // L x W x H
      const lwh = cleanDims.match(/([0-9.]+)\s*L\s*[xX×]\s*([0-9.]+)\s*W\s*[xX×]\s*([0-9.]+)\s*H/i)
      if (lwh) {
        console.log("[InventoryFlow] matched LWH:", lwh[1], lwh[2], lwh[3])
        if (!payload.itemSpecifics["Item Length"]) payload.itemSpecifics["Item Length"] = lwh[1] + " in"
        if (!payload.itemSpecifics["Item Width"]) payload.itemSpecifics["Item Width"] = lwh[2] + " in"
        if (!payload.itemSpecifics["Item Height"]) payload.itemSpecifics["Item Height"] = lwh[3] + " in"
        break
      }

      // W x H
      const wh = cleanDims.match(/([0-9.]+)\s*W\s*[xX×]\s*([0-9.]+)\s*H/i)
      if (wh) {
        console.log("[InventoryFlow] matched WH:", wh[1], wh[2])
        if (!payload.itemSpecifics["Item Width"]) payload.itemSpecifics["Item Width"] = wh[1] + " in"
        if (!payload.itemSpecifics["Item Height"]) payload.itemSpecifics["Item Height"] = wh[2] + " in"
        if (!payload.itemSpecifics["Item Length"]) payload.itemSpecifics["Item Length"] = wh[1] + " in"
        break
      }

      // L x W
      const lw = cleanDims.match(/([0-9.]+)\s*L\s*[xX×]\s*([0-9.]+)\s*W/i)
      if (lw) {
        console.log("[InventoryFlow] matched LW:", lw[1], lw[2])
        if (!payload.itemSpecifics["Item Length"]) payload.itemSpecifics["Item Length"] = lw[1] + " in"
        if (!payload.itemSpecifics["Item Width"]) payload.itemSpecifics["Item Width"] = lw[2] + " in"
        if (!payload.itemSpecifics["Item Height"]) payload.itemSpecifics["Item Height"] = lw[2] + " in"
        break
      }

      // Genel N x N x N
      const nnn = cleanDims.match(/([0-9.]+)\s*[xX×]\s*([0-9.]+)\s*[xX×]\s*([0-9.]+)/)
      if (nnn) {
        console.log("[InventoryFlow] matched NNN:", nnn[1], nnn[2], nnn[3])
        if (!payload.itemSpecifics["Item Length"]) payload.itemSpecifics["Item Length"] = nnn[1] + " in"
        if (!payload.itemSpecifics["Item Width"]) payload.itemSpecifics["Item Width"] = nnn[2] + " in"
        if (!payload.itemSpecifics["Item Height"]) payload.itemSpecifics["Item Height"] = nnn[3] + " in"
        break
      }

      // Genel N x N
      const nn = cleanDims.match(/([0-9.]+)\s*[xX×]\s*([0-9.]+)/)
      if (nn) {
        console.log("[InventoryFlow] matched NN:", nn[1], nn[2])
        if (!payload.itemSpecifics["Item Width"]) payload.itemSpecifics["Item Width"] = nn[1] + " in"
        if (!payload.itemSpecifics["Item Length"]) payload.itemSpecifics["Item Length"] = nn[1] + " in"
        if (!payload.itemSpecifics["Item Height"]) payload.itemSpecifics["Item Height"] = nn[2] + " in"
        break
      }
    }

    console.log("[InventoryFlow] after dims:", JSON.stringify({
      length: payload.itemSpecifics["Item Length"],
      width: payload.itemSpecifics["Item Width"],
      height: payload.itemSpecifics["Item Height"],
    }))

    // Item Diameter -> Item Length/Width olarak kullan
    const diameter = payload.itemSpecifics?.["Item Diameter"]
    if (diameter && !payload.itemSpecifics["Item Length"]) {
      const cleanDiam = diameter.replace(/[^0-9.]/g, "").trim()
      if (cleanDiam) {
        payload.itemSpecifics["Item Length"] = cleanDiam + " in"
        payload.itemSpecifics["Item Width"] = cleanDiam + " in"
      }
    }

    const aspects = buildProductAspects(payload)

    const inventoryBody: EbayInventoryItemRequest = {
      availability: {
        shipToLocationAvailability: { quantity: payload.quantity },
      },
      condition: payload.condition,
      product: {
        title:       payload.title,
        description,
        aspects,
        imageUrls:   imageUrls.slice(0, 12),
      },
    }

    const inventoryResp = await client.createOrReplaceInventoryItem(sku, inventoryBody)
    const invOk =
      inventoryResp.statusCode === 200 ||
      inventoryResp.statusCode === 201 ||
      inventoryResp.statusCode === 204
    result.inventoryItemStatus = invOk ? "ok" : "failed"

    if (!invOk) {
      throw new Error(`createOrReplaceInventoryItem unexpected status ${inventoryResp.statusCode}`)
    }

    const offerBody: EbayCreateOfferRequest = {
      sku,
      marketplaceId:       DEFAULT_MARKETPLACE,
      format:              "FIXED_PRICE",
      availableQuantity:   payload.quantity,
      categoryId,
      listingDescription:  description,
      listingPolicies:     {
        fulfillmentPolicyId,
        paymentPolicyId,
        returnPolicyId,
      },
      merchantLocationKey: whKey,
      pricingSummary: {
        price: {
          value:    payload.price.toFixed(2),
          currency: "USD",
        },
      },
    }

    const offerResp = await createOfferOrExisting(client, offerBody, sku)

    if (!offerResp.offerId) {
      throw new Error("createOffer did not return an offerId")
    }

    if (offerResp.fromDuplicate) {
      const wh = offerBody.merchantLocationKey?.trim() ?? whKey
      await client.updateOffer(offerResp.offerId, {
        categoryId:          offerBody.categoryId,
        pricingSummary:      offerBody.pricingSummary,
        listingDescription:  offerBody.listingDescription,
        listingPolicies:     offerBody.listingPolicies,
        merchantLocationKey: wh,
      })
      console.log(
        `  [InventoryFlow] updateOffer duplicate path offerId=${offerResp.offerId} categoryId=${offerBody.categoryId}`
      )
    }

    result.offerStatus = "ok"
    result.ebayOfferId = offerResp.offerId

    const publishResp = await client.publishOffer(offerResp.offerId)

    if (!publishResp.listingId) {
      throw new Error("publishOffer did not return a listingId")
    }

    result.publishStatus = "ok"
    result.ebayListingId = publishResp.listingId
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err)
    console.error(`  [InventoryFlow] Failed: ASIN=${asin} | ${result.error}`)
  }

  result.durationMs = Date.now() - startTime
  return result
}

export type BatchFlowSummary = {
  total:     number
  succeeded: number
  failed:    number
  results:   InventoryFlowResult[]
}

export async function runInventoryFlowBatch(
  payloads: EbayListingPayload[],
  options:  InventoryFlowClientOptions,
  batchOpts: {
    delayBetweenMs?: number
  } = {}
): Promise<BatchFlowSummary> {
  const { delayBetweenMs = 1000 } = batchOpts

  console.log(`[InventoryBatch] Starting - ${payloads.length} payload`)

  const results: InventoryFlowResult[] = []
  let succeeded = 0
  let failed    = 0

  for (let i = 0; i < payloads.length; i++) {
    const payload = payloads[i]
    console.log(`  [${i + 1}/${payloads.length}] ASIN=${payload.asin} SKU=${payload.sku}`)

    const flowResult = await runInventoryFlow(payload, options)
    results.push(flowResult)

    if (
      flowResult.inventoryItemStatus === "ok" &&
      flowResult.offerStatus         === "ok" &&
      flowResult.publishStatus       === "ok"
    ) {
      succeeded++
    } else {
      failed++
    }

    if (i < payloads.length - 1 && delayBetweenMs > 0) {
      await sleep(delayBetweenMs)
    }
  }

  console.log(
    `[InventoryBatch] Done | total=${payloads.length} succeeded=${succeeded} failed=${failed}`
  )

  return { total: payloads.length, succeeded, failed, results }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

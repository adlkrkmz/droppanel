// ----------------------------------------------------------------
// ebayApiClient.ts
//
// simulationMode=false -> real eBay Inventory API calls
// simulationMode=true  -> all methods return fake data
//
// Sandbox:     https://api.sandbox.ebay.com
// Production:  https://api.ebay.com
//
// Media (EPS) upload uses apim.ebay.com (Commerce Media API).
// Taxonomy: GET /commerce/taxonomy/v1/category_tree/0/get_category_suggestions
// Offer:    PUT /sell/inventory/v1/offer/{offerId} (updateOffer)
// Offers:   GET /sell/inventory/v1/offer (fiyat + stok — getActiveListingPrices)
// Trading:  POST .../ws/api.dll GetMyeBaySelling (XML — getAllOffersForImportBulk yedeği)
// ----------------------------------------------------------------

import type {
  EbayClientConfig,
  EbayCreateOfferRequest,
  EbayCreateOfferResponse,
  EbayInventoryItemRequest,
  EbayInventoryItemResponse,
  EbayPublishOfferResponse,
  EbayUpdateOfferRequest,
} from "./ebayApiTypes"
import { alertRateLimit } from "../notifications/telegramService"
import { recordEbayMutation } from "./ebayMutationAudit"

const EBAY_PRODUCTION_BASE = "https://api.ebay.com"
const EBAY_SANDBOX_BASE    = "https://api.sandbox.ebay.com"
const EBAY_MEDIA_APIM_PROD = "https://apim.ebay.com"
const EBAY_MEDIA_APIM_SB   = "https://apim.sandbox.ebay.com"
/** Finances API uses apiz host (not api.ebay.com). */
const EBAY_FINANCES_PROD = "https://apiz.ebay.com"
const EBAY_FINANCES_SB   = "https://apiz.sandbox.ebay.com"
/** Trading API (XML) — GetMyeBaySelling vb. */
const EBAY_TRADING_DLL_PROD = "https://api.ebay.com/ws/api.dll"
const EBAY_TRADING_DLL_SB   = "https://api.sandbox.ebay.com/ws/api.dll"

/** Taxonomy öneri yok / hata → createOffer categoryId yedek */
export const EBAY_DEFAULT_CATEGORY_ID = "9355"

const EBAY_US_CATEGORY_TREE_ID = "0"
const TAXONOMY_Q_MAX_LEN       = 350

/** eBay yanıtındaki önerilerden en fazla kaç tanesi kullanılır (API'de ayrı limit parametresi yok). */
const CATEGORY_SUGGESTIONS_MAX = 5

export type EbayCategorySuggestion = {
  categoryId:              string
  categoryName:              string
  categoryTreeNodeLevel:     number
}

// ----------------------------------------------------------------
// GET RESPONSE TYPES
// ----------------------------------------------------------------

export type EbayGetInventoryItemsPage = {
  inventoryItems: {
    sku:     string
    product?: {
      title?:     string
      imageUrls?: string[]
    }
    availability?: {
      shipToLocationAvailability?: { quantity?: number }
    }
  }[]
  total:  number
  href?:  string
  next?:  string
  limit:  number
  offset: number
}

export type EbayOfferSummary = {
  sku:     string
  offerId: string
  format?: string
  pricingSummary?: {
    price?: { value: string; currency: string }
  }
  availableQuantity?: number
  listing?: { listingId: string }
  status?: string
  marketplaceId?: string
}

export type EbayTradingItemSnapshot = {
  itemId: string
  sku: string | null
  listingStatus: string | null
  startPrice: number | null
  currentPrice: number | null
  quantity: number | null
  quantityAvailable: number | null
  hasVariations: boolean
  sellerUserId: string | null
}

/** Evidence returned by one fully-read Trading ActiveList traversal. */
export type EbayCatalogPaginationReceipt = {
  expectedTotalEntries: number | null
  expectedTotalPages: number | null
  requestedPageSize: number
  pagesAttempted: number
  pagesCompleted: number
  lastCompletedPage: number
  fetchedRowCount: number
  distinctRemoteItemCount: number
  duplicateRemoteItemCount: number
  fetchErrorCount: number
  firstError: string | null
  paginationCompleted: boolean
  totalsConsistent: boolean
}

export class EbayCatalogPaginationIncompleteError extends Error {
  constructor(readonly receipt: EbayCatalogPaginationReceipt, message: string) {
    super(message)
    this.name = "EbayCatalogPaginationIncompleteError"
  }
}

export type EbayGetOffersPage = {
  offers: EbayOfferSummary[]
  total:  number
  href?:  string
  next?:  string
  limit:  number
  offset: number
}

/** Fulfillment API order line item (normalized). */
export type EbayOrderLineItem = {
  title:    string
  sku:      string | null
  quantity: number
  /** eBay lineItemId (per-order line key). */
  lineItemId?:  string | null
  /** eBay item/listing id (legacyItemId). */
  legacyItemId?: string | null
  /** eBay variation id — present on multi-variation listings. */
  legacyVariationId?: string | null
  itemPrice?:   number | null
  currency?:    string | null
  /** Raw line item JSON for persistence. */
  raw?:         Record<string, unknown>
}

/** Fulfillment API order (normalized) — GET /sell/fulfillment/v1/order. */
export type EbayOrderRow = {
  orderId:           string
  legacyOrderId:     string | null
  creationDate:      string | null
  fulfillmentStatus: string | null
  buyerUsername:     string | null
  total:             number
  currency:          string
  lineItems:         EbayOrderLineItem[]
  /** lastModifiedDate (ISO) — incremental sync. */
  lastModifiedDate?: string | null
  buyerName?:        string | null
  paymentStatus?:    string | null
  orderStatus?:      string | null
  /** Raw order JSON for persistence. */
  raw?:              Record<string, unknown>
}

/** Optional date filter for getOrders (Fulfillment API filter string). */
export type EbayOrdersFilter = {
  /** ISO date; builds `lastmodifieddate:[from..]` so updated orders are caught. */
  modifiedFrom?: string
}

/** getActiveListingPrices çıktısı — sku + fiyat + monitor için offer alanları */
export type EbayActiveListingPriceRow = {
  sku:               string
  price:             number
  offerId:           string
  listingId:         string | null
  availableQuantity: number
  currency:          string
  /** eBay offer.status (PUBLISHED, vb.) */
  offerStatus?:      string | null
  /** Trading: Item.Title */
  title?:            string | null
  /** Trading: CurrentPrice (düz metin) */
  currentPrice?:     number
  /** Trading: QuantityAvailable */
  quantityAvailable?: number
  /** Trading: PictureDetails / GalleryURL — ana görsel */
  imageUrl?:         string | null
  /** Trading: SellingStatus.QuantitySold (lifetime) */
  quantitySold?:     number | null
  /** Trading: WatchCount */
  watchCount?:       number | null
  /** Trading: ListingDetails.StartTime (ISO) */
  listedAt?:         string | null
  marketplaceId?:    string | null
}

/** Per-listing metrics from Trading GetItem / GetMyeBaySelling */
export type EbayListingMetricsRow = {
  listingId:    string
  quantitySold: number | null
  watchCount:   number | null
  listedAt:     string | null
}

export type EbayListingTrafficMetrics = {
  listingId:    string
  clicks30d:    number | null
  views30d:     number | null
  impressions30d: number | null
}

export type EbayTrafficReportResult = {
  ok:      boolean
  error?:  string
  rows:    EbayListingTrafficMetrics[]
}

export type EbayApiErrorDetail = {
  errorId:     number
  domain:      string
  category:    string
  message:     string
  longMessage?: string
  parameters?: { name: string; value: string }[]
}

export type EbayApiErrorResponse = {
  errors?: EbayApiErrorDetail[]
}

export type EbayMediaUploadResponse = {
  expirationDate?: string
  imageUrl?:      string
}

/** WAREHOUSE createInventoryLocation address (Settings → Location ile uyumlu) */
export type EbayMerchantLocationAddress = {
  addressLine1:    string
  city:            string
  stateOrProvince: string
  postalCode:      string
  country:         string
}

export type EbayTradingDiagnostic = {
  code: string | null
  severity: string | null
  classification: string | null
  shortMessage: string | null
  longMessage: string | null
  parameters: { name: string; value: string }[]
}
export type EbayTradingResponseClassification = {
  ack: string
  accepted: boolean
  warnings: EbayTradingDiagnostic[]
  errors: EbayTradingDiagnostic[]
}
export type EbayMerchantLocationGetResult =
  | { kind: "found"; data: Record<string, unknown> }
  | { kind: "not_found" }
  | { kind: "error"; message: string }

function extractPriceAndCurrency(obj: Record<string, unknown>): { value: number; currency: string } {
  const fromPriceLeaf = (node: unknown): { value: number; currency: string } | null => {
    if (!node || typeof node !== "object") return null
    const p = node as Record<string, unknown>
    const raw = p.value
    if (typeof raw === "string" || typeof raw === "number") {
      const n = typeof raw === "number" ? raw : parseFloat(String(raw))
      const c = typeof p.currency === "string" ? p.currency : "USD"
      return { value: Number.isFinite(n) ? n : 0, currency: c }
    }
    return null
  }

  const direct = fromPriceLeaf(obj.price)
  if (direct) return direct

  if (obj.pricingSummary && typeof obj.pricingSummary === "object") {
    const ps = obj.pricingSummary as Record<string, unknown>
    const inner = fromPriceLeaf(ps.price)
    if (inner) return inner
  }

  return { value: 0, currency: "USD" }
}

function pickListingIdFromRecord(r: Record<string, unknown>): string {
  if (typeof r.listingId === "string" && r.listingId.trim()) return r.listingId.trim()
  if (r.listing && typeof r.listing === "object") {
    const lid = (r.listing as Record<string, unknown>).listingId
    if (typeof lid === "string" && lid.trim()) return lid.trim()
  }
  return ""
}

function offerSummaryToActivePriceRow(o: EbayOfferSummary): EbayActiveListingPriceRow | null {
  const sku = typeof o.sku === "string" ? o.sku.trim() : ""
  if (!sku) return null
  const offerId = typeof o.offerId === "string" ? o.offerId.trim() : ""
  if (!offerId) return null

  const raw = o.pricingSummary?.price?.value
  const price =
    raw === undefined || raw === null || raw === ""
      ? NaN
      : parseFloat(String(raw))
  const currency =
    typeof o.pricingSummary?.price?.currency === "string" && o.pricingSummary.price.currency.trim()
      ? o.pricingSummary.price.currency.trim()
      : "USD"

  const listingRaw = o.listing?.listingId
  const listingId =
    typeof listingRaw === "string" && listingRaw.trim() ? listingRaw.trim() : null

  const q = o.availableQuantity
  const availableQuantity = typeof q === "number" && Number.isFinite(q) ? q : 0

  const st = o.status
  const offerStatus =
    typeof st === "string" && st.trim() ? st.trim() : null

  return {
    sku,
    price:             Number.isFinite(price) ? price : 0,
    offerId,
    listingId,
    availableQuantity,
    currency,
    offerStatus,
    marketplaceId: typeof o.marketplaceId === "string" && o.marketplaceId.trim() ? o.marketplaceId.trim() : null,
  }
}

function parseXmlMoney(block: string, tag: string): number | null {
  const raw = xmlTextContent(block, tag)
  if (!raw) return null
  const n = parseFloat(raw)
  return Number.isFinite(n) ? n : null
}

function parseTradingItemSnapshot(itemId: string, xml: string): EbayTradingItemSnapshot | null {
  const itemBlock = xml.match(/<Item>([\s\S]*?)<\/Item>/i)?.[1]
  if (!itemBlock) return null
  const selling = itemBlock.match(/<SellingStatus>([\s\S]*?)<\/SellingStatus>/i)?.[1] ?? ""
  const seller = itemBlock.match(/<Seller>([\s\S]*?)<\/Seller>/i)?.[1] ?? ""
  const qtyAvailRaw = xmlTextContent(itemBlock, "QuantityAvailable")
  const qtyRaw = xmlTextContent(itemBlock, "Quantity")
  const qtyAvail = qtyAvailRaw !== "" ? parseInt(qtyAvailRaw, 10) : NaN
  const qty = qtyRaw !== "" ? parseInt(qtyRaw, 10) : NaN
  return {
    itemId,
    sku: xmlTextContent(itemBlock, "SKU") || null,
    listingStatus: xmlTextContent(itemBlock, "ListingStatus") || null,
    startPrice: parseXmlMoney(itemBlock, "StartPrice"),
    currentPrice: parseXmlMoney(selling, "CurrentPrice") ?? parseXmlMoney(itemBlock, "CurrentPrice"),
    quantity: Number.isFinite(qty) ? qty : null,
    quantityAvailable: Number.isFinite(qtyAvail) ? qtyAvail : null,
    hasVariations: /<Variations[\s>]/i.test(itemBlock),
    sellerUserId: xmlTextContent(seller, "UserID") || null,
  }
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function xmlTextContent(block: string, tag: string): string {
  const qualified = `(?:[A-Za-z_][\\w.-]*:)?${tag}`
  const re = new RegExp(`<${qualified}\\b[^>]*>([\\s\\S]*?)</${qualified}\\s*>`, "i")
  const m = re.exec(block)
  if (!m) return ""
  let inner = m[1].trim()
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/i.exec(inner)
  if (cdata) inner = cdata[1].trim()
  return decodeXmlEntities(inner.replace(/<[^>]+>/g, "").trim())
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => {
      const n = parseInt(hex, 16)
      return Number.isFinite(n) ? String.fromCodePoint(n) : _m
    })
    .replace(/&#(\d+);/g, (_m, decimal: string) => {
      const n = parseInt(decimal, 10)
      return Number.isFinite(n) ? String.fromCodePoint(n) : _m
    })
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
}

function xmlBlocks(block: string, tag: string): string[] {
  const qualified = `(?:[A-Za-z_][\\w.-]*:)?${tag}`
  const re = new RegExp(`<${qualified}\\b[^>]*>([\\s\\S]*?)</${qualified}\\s*>`, "gi")
  return [...block.matchAll(re)].map(m => m[1])
}

export function classifyEbayTradingResponse(xml: string): EbayTradingResponseClassification {
  const ack = xmlTextContent(xml, "Ack").trim().toUpperCase()
  const diagnostics: EbayTradingDiagnostic[] = []
  for (const block of xmlBlocks(xml, "Error")) {
    const parameters = xmlBlocks(block, "ErrorParameter").map(parameter => ({
      name: xmlTextContent(parameter, "ParamID") || xmlTextContent(parameter, "Name") || "parameter",
      value: xmlTextContent(parameter, "Value") || xmlTextContent(parameter, "ParamValue"),
    }))
    diagnostics.push({
      code: xmlTextContent(block, "ErrorCode") || null,
      severity: xmlTextContent(block, "SeverityCode") || null,
      classification: xmlTextContent(block, "ErrorClassification") || null,
      shortMessage: xmlTextContent(block, "ShortMessage") || null,
      longMessage: xmlTextContent(block, "LongMessage") || null,
      parameters,
    })
  }
  const warnings = diagnostics.filter(d => /^WARNING$/i.test(d.severity ?? ""))
  const errors = diagnostics.filter(d => !/^WARNING$/i.test(d.severity ?? ""))
  const accepted = (ack === "SUCCESS" || ack === "WARNING") && errors.length === 0
  return { ack, accepted, warnings, errors }
}

export class EbayTradingApiError extends Error {
  constructor(
    message: string,
    readonly callName: string,
    readonly httpStatus: number | null,
    readonly response: EbayTradingResponseClassification | null,
  ) {
    super(message)
    this.name = "EbayTradingApiError"
  }
}

function formatTradingDiagnostic(diagnostic: EbayTradingDiagnostic): string {
  const parts = [
    diagnostic.code ? `code=${diagnostic.code}` : null,
    diagnostic.severity ? `severity=${diagnostic.severity}` : null,
    diagnostic.classification ? `classification=${diagnostic.classification}` : null,
    diagnostic.shortMessage ? `short=${diagnostic.shortMessage}` : null,
    diagnostic.longMessage ? `long=${diagnostic.longMessage}` : null,
    diagnostic.parameters.length > 0
      ? `parameters=${diagnostic.parameters.map(p => `${p.name}=${p.value}`).join(";")}`
      : null,
  ].filter(Boolean)
  return parts.join(" ") || "unspecified eBay error"
}

function formatTradingFailure(callName: string, parsed: EbayTradingResponseClassification): string {
  const diagnostics = [...parsed.errors, ...parsed.warnings]
  const details = diagnostics.length > 0
    ? diagnostics.map((d, i) => `Error[${i + 1}] ${formatTradingDiagnostic(d)}`).join(" | ")
    : "no Error element returned"
  return `${callName} failed: Ack=${parsed.ack || "missing"}; ${details}`
}
function parseTradingItemMetricsBlock(block: string): {
  quantitySold: number | null
  watchCount:   number | null
  listedAt:     string | null
} {
  const sellingBlock = block.match(/<SellingStatus>([\s\S]*?)<\/SellingStatus>/i)?.[1] ?? block
  const soldRaw = xmlTextContent(sellingBlock, "QuantitySold")
  const quantitySold =
    soldRaw !== "" && Number.isFinite(parseInt(soldRaw, 10))
      ? parseInt(soldRaw, 10)
      : null

  const watchRaw = xmlTextContent(block, "WatchCount")
  const watchCount =
    watchRaw !== "" && Number.isFinite(parseInt(watchRaw, 10))
      ? parseInt(watchRaw, 10)
      : null

  const listingDetails = block.match(/<ListingDetails>([\s\S]*?)<\/ListingDetails>/i)?.[1] ?? block
  const startRaw = xmlTextContent(listingDetails, "StartTime").trim()
  const listedAt = startRaw.length > 0 ? startRaw : null

  return { quantitySold, watchCount, listedAt }
}

function mergeListingPriceRowsBySku(rows: EbayActiveListingPriceRow[]): EbayActiveListingPriceRow[] {
  const m = new Map<string, EbayActiveListingPriceRow>()
  for (const row of rows) {
    const k = row.sku.trim()
    if (!k) continue
    m.set(k, row)
  }
  return [...m.values()]
}

function inventoryItemToActivePriceRow(
  item: EbayGetInventoryItemsPage["inventoryItems"][0]
): EbayActiveListingPriceRow | null {
  const rec = item as Record<string, unknown>
  const sku = typeof item.sku === "string" ? item.sku.trim() : ""
  if (!sku) return null
  const { value: price, currency } = extractPriceAndCurrency(rec)
  const qty = item.availability?.shipToLocationAvailability?.quantity ?? 0
  const listingIdStr = pickListingIdFromRecord(rec)
  const offerId =
    typeof rec.offerId === "string" ? rec.offerId
    : typeof rec.primaryOfferId === "string" ? rec.primaryOfferId
    : ""
  return {
    sku,
    price:             Number.isFinite(price) ? price : 0,
    offerId,
    listingId:         listingIdStr || null,
    availableQuantity: typeof qty === "number" ? qty : 0,
    currency,
  }
}

// ----------------------------------------------------------------
// CLIENT
// ----------------------------------------------------------------

export class EbayApiClient {
  private readonly baseUrl:        string
  private readonly mediaApimBase:  string
  private readonly financesBase:   string
  private readonly oauthToken:     string
  private readonly simulationMode: boolean
  private readonly isSandbox:      boolean

  constructor(config: EbayClientConfig) {
    this.oauthToken     = config.oauthToken
    this.simulationMode = config.simulationMode ?? false
    const sandbox       = config.sandbox ?? false
    this.isSandbox      = sandbox
    this.baseUrl        = sandbox ? EBAY_SANDBOX_BASE : EBAY_PRODUCTION_BASE
    this.mediaApimBase  = sandbox ? EBAY_MEDIA_APIM_SB : EBAY_MEDIA_APIM_PROD
    this.financesBase   = sandbox ? EBAY_FINANCES_SB : EBAY_FINANCES_PROD
  }

  // ----------------------------------------------------------------
  // POST Commerce Media API - upload image (multipart/form-data)
  // ----------------------------------------------------------------

  async uploadImage(imageBuffer: Buffer, fileName: string, contentType = "image/png"): Promise<string> {
    if (this.simulationMode) {
      const safe = fileName.replace(/[^a-zA-Z0-9._-]/g, "_")
      console.log(`    [eBayClient][SIM] uploadImage fileName=${safe}`)
      return `https://i.ebayimg.com/images/g/sim-${safe}-${Date.now()}.jpg`
    }

    const url =
      `${this.mediaApimBase}/commerce/media/v1_beta/image/create_image_from_file`

    const form = new FormData()
    const blob = new Blob([new Uint8Array(imageBuffer)], { type: contentType })
    const name = fileName.trim().length > 0 ? fileName : "image.png"
    form.append("image", blob, name)

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization:   `Bearer ${this.oauthToken}`,
        Accept:          "application/json",
        "Accept-Language": "en-US",
      },
      body: form,
    })

    if (res.status !== 201) {
      const text = await res.text()
      throw new Error(`uploadImage failed: HTTP ${res.status} - ${text}`)
    }

    const data = (await res.json()) as EbayMediaUploadResponse
    const imageUrl = data.imageUrl?.trim()
    if (!imageUrl) {
      throw new Error("uploadImage: response missing imageUrl")
    }
    return imageUrl
  }

  async uploadVideo(videoBuffer: Buffer, title: string): Promise<string> {
    if (this.simulationMode) {
      console.log('[eBayClient][SIM] uploadVideo title:', title)
      return 'SIM-VIDEO-ID'
    }

    // ADIM 1: Video kaynağı oluştur
    const createUrl = `https://api.ebay.com/commerce/media/v1/video`
    console.log('[eBayClient] createVideo URL:', createUrl)
    console.log('[eBayClient] createVideo headers:', JSON.stringify(this.maskHeadersForLog(this.buildAuthHeaders())))
    console.log('[eBayClient] createVideo body:', JSON.stringify({ title: title.slice(0, 80), size: videoBuffer.length, classification: ['ITEM'] }))
    const createRes = await fetch(createUrl, {
      method: 'POST',
      headers: {
        ...this.buildAuthHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: title.slice(0, 80),
        size: videoBuffer.length,
        classification: ['ITEM']
      })
    })

    if (!createRes.ok) {
      const text = await createRes.text()
      throw new Error(`createVideo failed: HTTP ${createRes.status} - ${text}`)
    }

    const createData = await createRes.json() as { videoId?: string }
    const videoId = createData.videoId
    if (!videoId) throw new Error('createVideo did not return videoId')
    console.log('[eBayClient] Video created, videoId:', videoId)

    // ADIM 2: Video dosyasını yükle
    const uploadUrl = `https://api.ebay.com/commerce/media/v1/video/${videoId}/upload`
    const uploadRes = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        ...this.buildAuthHeaders(),
        'Content-Type': 'video/mp4',
      },
      body: videoBuffer as unknown as BodyInit
    })

    if (!uploadRes.ok) {
      const text = await uploadRes.text()
      throw new Error(`uploadVideo failed: HTTP ${uploadRes.status} - ${text}`)
    }

    console.log('[eBayClient] Video uploaded successfully, videoId:', videoId)
    return videoId
  }

  // ----------------------------------------------------------------
  // PUT /sell/inventory/v1/inventory_item/{sku}
  // ----------------------------------------------------------------

  async createOrReplaceInventoryItem(
    sku:  string,
    body: EbayInventoryItemRequest
  ): Promise<EbayInventoryItemResponse> {
    if (this.simulationMode) {
      console.log(`    [eBayClient][SIM] createOrReplaceInventoryItem sku=${sku}`)
      return { sku, statusCode: 201, warnings: [] }
    }

    const normalizedBody: EbayInventoryItemRequest = {
      ...body,
      product: body.product
        ? {
            ...body.product,
            imageUrls: (body.product.imageUrls ?? [])
              .map((u) => String(u).trim())
              .filter((u) => u.length > 0)
              .map((u) => (u.startsWith("http://") ? `https://${u.slice("http://".length)}` : u)),
          }
        : body.product,
    }

    const url      = `${this.baseUrl}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`
    const response = await fetch(url, {
      method:  "PUT",
      headers: this.buildJsonHeaders(),
      body:    JSON.stringify(normalizedBody),
    })

    if (response.status === 429) {
      await alertRateLimit("eBay API", `Rate limit aşıldı. URL: ${url}`)
      throw new Error(`Rate limit: HTTP 429 - ${url}`)
    }
    if (response.status >= 500) {
      await alertRateLimit("eBay API", `eBay sunucu hatası HTTP ${response.status}. URL: ${url}`)
    }

    if (response.status !== 200 && response.status !== 201 && response.status !== 204) {
      const text = await response.text()
      throw new Error(`createOrReplaceInventoryItem failed: HTTP ${response.status} - ${text}`)
    }

    const text = await response.text()
    const data = text.length > 0
      ? (JSON.parse(text) as Partial<EbayInventoryItemResponse>)
      : {}

    return { sku, statusCode: response.status, warnings: data.warnings ?? [] }
  }

  async createOrReplaceInventoryItemGroup(
    groupKey: string,
    body: object
  ): Promise<{ statusCode: number }> {
    if (this.simulationMode) {
      console.log(`    [eBayClient][SIM] createOrReplaceInventoryItemGroup groupKey=${groupKey}`)
      return { statusCode: 201 }
    }
    const url = `${this.baseUrl}/sell/inventory/v1/inventory_item_group/${encodeURIComponent(groupKey)}`
    const response = await fetch(url, {
      method:  "PUT",
      headers: this.buildJsonHeaders(),
      body:    JSON.stringify(body),
    })
    if (response.status === 429) {
      await alertRateLimit("eBay API", `Rate limit aşıldı. URL: ${url}`)
      throw new Error(`Rate limit: HTTP 429 - ${url}`)
    }
    if (response.status >= 500) {
      await alertRateLimit("eBay API", `eBay sunucu hatası HTTP ${response.status}. URL: ${url}`)
    }
    if (response.status !== 200 && response.status !== 201 && response.status !== 204) {
      const text = await response.text()
      throw new Error(`createOrReplaceInventoryItemGroup failed: HTTP ${response.status} - ${text}`)
    }
    return { statusCode: response.status }
  }

  async publishOfferByInventoryItemGroup(
    groupKey:      string,
    marketplaceId: string
  ): Promise<{ listingId: string }> {
    if (this.simulationMode) {
      console.log(`    [eBayClient][SIM] publishOfferByInventoryItemGroup groupKey=${groupKey}`)
      return { listingId: `SIM-${groupKey}` }
    }
    const url = `${this.baseUrl}/sell/inventory/v1/offer/publish_by_inventory_item_group`
    const response = await fetch(url, {
      method:  "POST",
      headers: this.buildJsonHeaders(),
      body:    JSON.stringify({ inventoryItemGroupKey: groupKey, marketplaceId }),
    })
    if (response.status === 429) {
      await alertRateLimit("eBay API", `Rate limit aşıldı. URL: ${url}`)
      throw new Error(`Rate limit: HTTP 429 - ${url}`)
    }
    if (response.status >= 500) {
      await alertRateLimit("eBay API", `eBay sunucu hatası HTTP ${response.status}. URL: ${url}`)
    }
    if (response.status !== 200 && response.status !== 201) {
      const text = await response.text()
      throw new Error(`publishOfferByInventoryItemGroup failed: HTTP ${response.status} - ${text}`)
    }
    const data = await response.json() as { listingId?: string }
    const listingId = data.listingId ?? ""
    if (!listingId) throw new Error("publishOfferByInventoryItemGroup did not return a listingId")
    return { listingId }
  }

  // ----------------------------------------------------------------
  // GET /sell/inventory/v1/inventory_item
  // ----------------------------------------------------------------

  async getInventoryItems(
    limit  = 100,
    offset = 0
  ): Promise<EbayGetInventoryItemsPage> {
    if (this.simulationMode) {
      console.log(`    [eBayClient][SIM] getInventoryItems limit=${limit}`)
      return { inventoryItems: [], total: 0, limit, offset }
    }

    const allItems: EbayGetInventoryItemsPage["inventoryItems"] = []
    let apiReportedTotal: number | undefined
    let nextUrl: string | undefined = `${this.baseUrl}/sell/inventory/v1/inventory_item?limit=${limit}&offset=${offset}`

    while (nextUrl && allItems.length < 1000) {
      const res = await fetch(nextUrl, { headers: this.buildJsonHeaders() })
      if (!res.ok) {
        const text = await res.text()
        throw new Error(`getInventoryItems failed: HTTP ${res.status} - ${text}`)
      }
      const page = (await res.json()) as EbayGetInventoryItemsPage
      if (apiReportedTotal === undefined && typeof page.total === "number") {
        apiReportedTotal = page.total
      }
      const items = page.inventoryItems ?? []
      allItems.push(...items)

      if (!page.next || items.length === 0) {
        break
      }
      nextUrl = page.next.startsWith("http") ? page.next : `${this.baseUrl}${page.next}`
    }

    const total = apiReportedTotal ?? allItems.length
    return {
      inventoryItems: allItems,
      total,
      href: undefined,
      next: undefined,
      limit,
      offset,
    }
  }

  /**
   * GET /sell/inventory/v1/inventory_item?limit=100&offset=… — tüm sayfalar.
   * `getInventoryItems` ile aynı endpoint; 1000 kayıt üst sınırı yok (import / tam liste için).
   */
  async getAllInventoryItemsPaginated(): Promise<EbayGetInventoryItemsPage["inventoryItems"]> {
    if (this.simulationMode) {
      console.log(`    [eBayClient][SIM] getAllInventoryItemsPaginated -> []`)
      return []
    }

    const limit         = 100
    const allItems: EbayGetInventoryItemsPage["inventoryItems"] = []
    let nextUrl: string | undefined =
      `${this.baseUrl}/sell/inventory/v1/inventory_item?limit=${limit}&offset=0`
    let pageGuard = 0

    while (nextUrl && pageGuard < 500) {
      pageGuard++
      const res = await fetch(nextUrl, { headers: this.buildJsonHeaders() })

      if (res.status === 429) {
        await alertRateLimit("eBay API", `Rate limit aşıldı. URL: ${nextUrl}`)
        throw new Error(`Rate limit: HTTP 429 - ${nextUrl}`)
      }
      if (res.status >= 500) {
        await alertRateLimit("eBay API", `eBay sunucu hatası HTTP ${res.status}. URL: ${nextUrl}`)
      }

      if (!res.ok) {
        const text = await res.text()
        throw new Error(`getAllInventoryItemsPaginated failed: HTTP ${res.status} - ${text}`)
      }

      const page = (await res.json()) as EbayGetInventoryItemsPage
      allItems.push(...(page.inventoryItems ?? []))

      const curOffset = typeof page.offset === "number" ? page.offset : 0
      const pageLimit = typeof page.limit === "number" && page.limit > 0 ? page.limit : limit
      const got       = page.inventoryItems?.length ?? 0
      const total     = typeof page.total === "number" ? page.total : 0

      if (typeof page.next === "string" && page.next.trim().length > 0) {
        const raw = page.next.startsWith("http") ? page.next : `${this.baseUrl}${page.next}`
        nextUrl = raw
        continue
      }

      if (got === 0) {
        nextUrl = undefined
      } else if (total > 0 && curOffset + got < total) {
        nextUrl =
          `${this.baseUrl}/sell/inventory/v1/inventory_item?limit=${pageLimit}&offset=${curOffset + got}`
      } else if (total === 0 && got >= pageLimit) {
        nextUrl =
          `${this.baseUrl}/sell/inventory/v1/inventory_item?limit=${pageLimit}&offset=${curOffset + got}`
      } else {
        nextUrl = undefined
      }
    }

    return allItems
  }

  // ----------------------------------------------------------------
  // GET /sell/inventory/v1/inventory_item/{sku}
  // ----------------------------------------------------------------

  async getInventoryItem(sku: string, signal?: AbortSignal): Promise<EbayInventoryItemResponse & {
    availability?: { shipToLocationAvailability?: { quantity?: number } }
    product?: { title?: string; imageUrls?: string[] }
  }> {
    if (this.simulationMode) {
      console.log(`    [eBayClient][SIM] getInventoryItem sku=${sku}`)
      return { sku, statusCode: 200, warnings: [] }
    }

    const url = `${this.baseUrl}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`
    const res = await fetch(url, { headers: this.buildJsonHeaders(), signal })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`getInventoryItem failed: HTTP ${res.status} - ${text}`)
    }
    return res.json() as Promise<EbayInventoryItemResponse & {
      availability?: { shipToLocationAvailability?: { quantity?: number } }
      product?: { title?: string; imageUrls?: string[] }
    }>
  }

  async getInventoryItemOrNull(sku: string, signal?: AbortSignal): Promise<{
    sku: string
    availability?: { shipToLocationAvailability?: { quantity?: number } }
  } | null> {
    if (this.simulationMode) {
      console.log(`    [eBayClient][SIM] getInventoryItemOrNull sku=${sku}`)
      return null
    }
    const clean = sku?.trim() ?? ""
    if (!clean) return null
    const url = `${this.baseUrl}/sell/inventory/v1/inventory_item/${encodeURIComponent(clean)}`
    const res = await fetch(url, { headers: this.buildJsonHeaders(), signal })
    if (res.status === 404) return null
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`getInventoryItem failed: HTTP ${res.status} - ${text}`)
    }
    return res.json() as Promise<{
      sku: string
      availability?: { shipToLocationAvailability?: { quantity?: number } }
    }>
  }

  async getTradingItemSnapshot(itemId: string, signal?: AbortSignal): Promise<EbayTradingItemSnapshot | null> {
    if (this.simulationMode) return null
    const id = itemId.trim()
    if (!id) return null
    const token = escapeXml(this.oauthToken)
    const body =
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">` +
      `<RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>` +
      `<ItemID>${escapeXml(id)}</ItemID>` +
      `<DetailLevel>ReturnAll</DetailLevel>` +
      `</GetItemRequest>`
    const xml = await this.postTradingApi("GetItem", body, signal)
    return parseTradingItemSnapshot(id, xml)
  }

  // ----------------------------------------------------------------
  // GET /sell/inventory/v1/location/{merchantLocationKey}
  // ----------------------------------------------------------------

  async getMerchantLocation(merchantLocationKey: string): Promise<EbayMerchantLocationGetResult> {
    if (this.simulationMode) {
      console.log(`    [eBayClient][SIM] getMerchantLocation key=${merchantLocationKey}`)
      return { kind: "found", data: {} }
    }

    const key = merchantLocationKey.trim()
    const url = `${this.baseUrl}/sell/inventory/v1/location/${encodeURIComponent(key)}`
    const res = await fetch(url, {
      method:  "GET",
      headers: {
        Authorization:   `Bearer ${this.oauthToken}`,
        Accept:          "application/json",
        "Accept-Language": "en-US",
      },
    })

    if (res.status === 200) {
      try {
        const data = (await res.json()) as Record<string, unknown>
        return { kind: "found", data }
      } catch {
        return { kind: "found", data: {} }
      }
    }
    if (res.status === 404) return { kind: "not_found" }
    const text = await res.text()
    return { kind: "error", message: `HTTP ${res.status} ${text}` }
  }

  // ----------------------------------------------------------------
  // POST /sell/inventory/v1/location/{merchantLocationKey}
  // ----------------------------------------------------------------

  async createMerchantLocation(
    merchantLocationKey: string,
    address:             EbayMerchantLocationAddress
  ): Promise<void> {
    if (this.simulationMode) {
      console.log(`    [eBayClient][SIM] createMerchantLocation key=${merchantLocationKey}`)
      return
    }

    const key = merchantLocationKey.trim()
    const body = {
      location: {
        address: {
          addressLine1:    address.addressLine1.trim(),
          city:            address.city.trim(),
          stateOrProvince: address.stateOrProvince.trim(),
          postalCode:      address.postalCode.trim(),
          country:         address.country.trim(),
        },
      },
      locationTypes: ["WAREHOUSE"] as const,
      name:          key,
    }

    const url = `${this.baseUrl}/sell/inventory/v1/location/${encodeURIComponent(key)}`
    const res = await fetch(url, {
      method:  "POST",
      headers: this.buildJsonHeaders(),
      body:    JSON.stringify(body),
    })

    if (res.status === 204 || res.status === 201) return
    if (res.status === 409) return
    const text = await res.text()
    throw new Error(`createMerchantLocation failed: HTTP ${res.status} - ${text}`)
  }

  // ----------------------------------------------------------------
  // POST /sell/inventory/v1/location/{merchantLocationKey}/update_location_details
  // ----------------------------------------------------------------

  async updateMerchantLocation(
    merchantLocationKey: string,
    address:             EbayMerchantLocationAddress
  ): Promise<void> {
    if (this.simulationMode) {
      console.log(`    [eBayClient][SIM] updateMerchantLocation key=${merchantLocationKey}`)
      return
    }

    const key = merchantLocationKey.trim()
    const body = {
      location: {
        address: {
          addressLine1:    address.addressLine1.trim(),
          city:            address.city.trim(),
          stateOrProvince: address.stateOrProvince.trim(),
          postalCode:      address.postalCode.trim(),
          country:         address.country.trim(),
        },
      },
      locationTypes: ["WAREHOUSE"] as const,
      name:          key,
    }

    const url =
      `${this.baseUrl}/sell/inventory/v1/location/${encodeURIComponent(key)}/update_location_details`
    const res = await fetch(url, {
      method:  "POST",
      headers: this.buildJsonHeaders(),
      body:    JSON.stringify(body),
    })

    if (res.status === 204) return
    const text = await res.text()
    throw new Error(`updateMerchantLocation failed: HTTP ${res.status} - ${text}`)
  }

  // ----------------------------------------------------------------
  // GET Commerce Taxonomy — category suggestions (EBAY_US tree id 0)
  // ----------------------------------------------------------------

  /**
   * Başlığa göre taxonomy önerileri (en fazla CATEGORY_SUGGESTIONS_MAX adet).
   * Hata / boş / sandbox sorununda tek elemanlı yedek liste (EBAY_DEFAULT_CATEGORY_ID).
   */
  async getCategorySuggestions(
    title: string,
    amazonCategory?: string
  ): Promise<EbayCategorySuggestion[]> {
    const fallbackList = (): EbayCategorySuggestion[] => [
      {
        categoryId:          EBAY_DEFAULT_CATEGORY_ID,
        categoryName:        "Default",
        categoryTreeNodeLevel: 0,
      },
    ]

    if (this.simulationMode) {
      console.log(`    [eBayClient][SIM] getCategorySuggestions -> [${EBAY_DEFAULT_CATEGORY_ID}]`)
      return fallbackList()
    }

    const titleTrimmed = title.trim()
    const catTrimmed = (amazonCategory ?? "").trim()
    const qSource = [titleTrimmed, catTrimmed].filter(Boolean).join(" ")
    const q = qSource.slice(0, TAXONOMY_Q_MAX_LEN)
    if (!q) return fallbackList()

    try {
      const url =
        `${this.baseUrl}/commerce/taxonomy/v1/category_tree/${EBAY_US_CATEGORY_TREE_ID}` +
        `/get_category_suggestions?q=${encodeURIComponent(q)}`
      const res = await fetch(url, {
        method:  "GET",
        headers: {
          Authorization:    `Bearer ${this.oauthToken}`,
          Accept:           "application/json",
          "Accept-Language": "en-US",
        },
      })

      if (!res.ok) {
        console.warn(
          `[eBayClient] getCategorySuggestions HTTP ${res.status} — fallback ${EBAY_DEFAULT_CATEGORY_ID}`
        )
        return fallbackList()
      }

      const data = (await res.json()) as {
        categorySuggestions?: {
          category?:               { categoryId?: string; categoryName?: string }
          categoryTreeNodeLevel?:   number
        }[]
      }
      const raw = data.categorySuggestions ?? []
      const out: EbayCategorySuggestion[] = []
      for (const s of raw.slice(0, CATEGORY_SUGGESTIONS_MAX)) {
        const id = s.category?.categoryId?.trim()
        if (!id) continue
        const name = (s.category?.categoryName ?? "").trim() || id
        const level =
          typeof s.categoryTreeNodeLevel === "number" && Number.isFinite(s.categoryTreeNodeLevel)
            ? s.categoryTreeNodeLevel
            : 0
        out.push({ categoryId: id, categoryName: name, categoryTreeNodeLevel: level })
      }
      if (out.length === 0) return fallbackList()
      return out
    } catch (e) {
      console.warn(
        `[eBayClient] getCategorySuggestions: ${e instanceof Error ? e.message : String(e)} — fallback ${EBAY_DEFAULT_CATEGORY_ID}`
      )
      return fallbackList()
    }
  }

  // ----------------------------------------------------------------
  // GET Item Aspects for given category
  // ----------------------------------------------------------------
  async getCategoryAspects(
    categoryId: string,
    accessToken: string
  ): Promise<{ name: string; required: boolean }[]> {
    if (this.simulationMode) return []

    try {
      const url =
        `${this.baseUrl}/commerce/taxonomy/v1/category_tree/${EBAY_US_CATEGORY_TREE_ID}` +
        `/get_item_aspects_for_category?category_id=${encodeURIComponent(categoryId)}`

      const res = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept:        "application/json",
          "Accept-Language": "en-US",
        },
      })

      if (!res.ok) return []

      const data = (await res.json()) as {
        aspects?: {
          localizedAspectName?: string
          aspectConstraint?: { aspectRequired?: boolean }
        }[]
      }
      const aspects = Array.isArray(data.aspects) ? data.aspects : []

      return aspects
        .map((a) => ({
          name: typeof a.localizedAspectName === "string" ? a.localizedAspectName.trim() : "",
          required: a.aspectConstraint?.aspectRequired === true,
        }))
        .filter((a) => a.name.length > 0)
    } catch {
      return []
    }
  }

  /**
   * Zorunlu item aspects + taxonomy’deki izin verilen değer örnekleri (publish öncesi doldurma).
   * simulationMode bile olsa Taxonomy çağrısı denenir (test yolu).
   */
  async getRequiredAspectsForCategory(
    categoryId: string
  ): Promise<Array<{ name: string; required: boolean; values: string[] }>> {
    const id = categoryId.trim()
    if (!id) return []

    type AspectVal = { localizedValue?: string }
    type AspectRow = {
      localizedAspectName?: string
      aspectConstraint?: { aspectRequired?: boolean; aspectMode?: string }
      aspectValues?: AspectVal[]
    }

    const url =
      `${this.baseUrl}/commerce/taxonomy/v1/category_tree/${EBAY_US_CATEGORY_TREE_ID}` +
      `/get_item_aspects_for_category?category_id=${encodeURIComponent(id)}`

    try {
      const response = await fetch(url, {
        method:  "GET",
        headers: {
          Authorization:     `Bearer ${this.oauthToken}`,
          Accept:            "application/json",
          "Accept-Language": "en-US",
        },
      })

      if (!response.ok) {
        console.warn(`[EbayAPI] getRequiredAspects failed: ${response.status}`)
        return []
      }

      const data = (await response.json()) as { aspects?: AspectRow[] }
      const aspects = Array.isArray(data.aspects) ? data.aspects : []

      return aspects
        .filter((a) => a.aspectConstraint?.aspectRequired === true)
        .map((a) => {
          const name =
            typeof a.localizedAspectName === "string" ? a.localizedAspectName.trim() : ""
          const values = (Array.isArray(a.aspectValues) ? a.aspectValues : [])
            .map((v) => (typeof v?.localizedValue === "string" ? v.localizedValue.trim() : ""))
            .filter((v) => v.length > 0)
          return {
            name,
            required: true as const,
            values,
            acceptsFreeText: a.aspectConstraint?.aspectMode !== "SELECTION_ONLY",
          }
        })
        .filter((a) => a.name.length > 0)
    } catch (e) {
      console.warn(
        `[EbayAPI] getRequiredAspects error:`,
        e instanceof Error ? e.message : e
      )
      return []
    }
  }

  // ----------------------------------------------------------------
  // POST /sell/inventory/v1/offer
  // ----------------------------------------------------------------

  async createOffer(body: EbayCreateOfferRequest): Promise<EbayCreateOfferResponse> {
    if (this.simulationMode) {
      const simulatedOfferId = `SIM-OFFER-${body.sku}-${Date.now()}`
      console.log(`    [eBayClient][SIM] createOffer sku=${body.sku} offerId=${simulatedOfferId}`)
      return { offerId: simulatedOfferId, warnings: [] }
    }

    const url      = `${this.baseUrl}/sell/inventory/v1/offer`
    const response = await fetch(url, {
      method:  "POST",
      headers: this.buildJsonHeaders(),
      body:    JSON.stringify(body),
    })

    if (response.status === 429) {
      await alertRateLimit("eBay API", `Rate limit aşıldı. URL: ${url}`)
      throw new Error(`Rate limit: HTTP 429 - ${url}`)
    }
    if (response.status >= 500) {
      await alertRateLimit("eBay API", `eBay sunucu hatası HTTP ${response.status}. URL: ${url}`)
    }

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`createOffer failed: HTTP ${response.status} - ${text}`)
    }

    return response.json() as Promise<EbayCreateOfferResponse>
  }

  // ----------------------------------------------------------------
  // PUT /sell/inventory/v1/offer/{offerId}
  // ----------------------------------------------------------------

  async updateOffer(offerId: string, body: EbayUpdateOfferRequest): Promise<void> {
    if (this.simulationMode) {
      console.log(
        `    [eBayClient][SIM] updateOffer offerId=${offerId} categoryId=${body.categoryId}`
      )
      return
    }

    const url = `${this.baseUrl}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`
    const res = await fetch(url, {
      method:  "PUT",
      headers: this.buildJsonHeaders(),
      body:    JSON.stringify(body),
    })

    if (res.status === 429) {
      await alertRateLimit("eBay API", `Rate limit aşıldı. URL: ${url}`)
      throw new Error(`Rate limit: HTTP 429 - ${url}`)
    }
    if (res.status >= 500) {
      await alertRateLimit("eBay API", `eBay sunucu hatası HTTP ${res.status}. URL: ${url}`)
    }

    if (res.status !== 200 && res.status !== 204) {
      const text = await res.text()
      throw new Error(`updateOffer failed: HTTP ${res.status} - ${text}`)
    }
  }

  // ----------------------------------------------------------------
  // GET /sell/inventory/v1/offer
  // ----------------------------------------------------------------

  async getOffers(
    sku?:   string,
    limit  = 100,
    offset = 0
  ): Promise<EbayGetOffersPage> {
    if (this.simulationMode) {
      console.log(`    [eBayClient][SIM] getOffers sku=${sku ?? "all"}`)
      return { offers: [], total: 0, limit, offset }
    }

    const url = sku && sku.trim().length > 0
      ? `${this.baseUrl}/sell/inventory/v1/offer?limit=${limit}&offset=${offset}&sku=${encodeURIComponent(sku)}&marketplace_id=EBAY_US`
      : `${this.baseUrl}/sell/inventory/v1/offer?limit=${limit}&offset=${offset}`
    const res = await fetch(url, { headers: this.buildJsonHeaders() })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`getOffers failed: HTTP ${res.status} - ${text}`)
    }
    return res.json() as Promise<EbayGetOffersPage>
  }

  async listOffersPage(limit = 100, offset = 0): Promise<EbayGetOffersPage> {
    if (this.simulationMode) {
      return { offers: [], total: 0, limit, offset }
    }
    const url = `${this.baseUrl}/sell/inventory/v1/offer?limit=${limit}&offset=${offset}`
    const res = await fetch(url, { headers: this.buildJsonHeaders() })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`listOffersPage failed: HTTP ${res.status} - ${text}`)
    }
    return res.json() as Promise<EbayGetOffersPage>
  }

  // ----------------------------------------------------------------
  // GET /sell/fulfillment/v1/order — store orders (basic, single page)
  // ----------------------------------------------------------------

  /**
   * Bağlı eBay mağazasının siparişleri (Fulfillment API).
   * simulationMode -> [] (mock/empty state). Tek sayfa (limit/offset).
   * filter verilirse `lastmodifieddate:[from..]` uygulanır (incremental sync).
   */
  async getOrders(
    limit = 50,
    offset = 0,
    filter?: EbayOrdersFilter
  ): Promise<EbayOrderRow[]> {
    if (this.simulationMode) {
      console.log(`    [eBayClient][SIM] getOrders -> []`)
      return []
    }

    const safeLimit  = Math.max(1, Math.min(200, limit))
    const safeOffset = Math.max(0, offset)
    const params = new URLSearchParams()
    params.set("limit", String(safeLimit))
    params.set("offset", String(safeOffset))
    const modifiedFrom = filter?.modifiedFrom?.trim()
    if (modifiedFrom) {
      params.set("filter", `lastmodifieddate:[${modifiedFrom}..]`)
    }
    const url = `${this.baseUrl}/sell/fulfillment/v1/order?${params.toString()}`

    const res = await fetch(url, { headers: this.buildJsonHeaders() })

    if (res.status === 429) {
      await alertRateLimit("eBay API", `Rate limit aşıldı. URL: ${url}`)
      throw new Error(`Rate limit: HTTP 429 - ${url}`)
    }
    if (res.status >= 500) {
      await alertRateLimit("eBay API", `eBay sunucu hatası HTTP ${res.status}. URL: ${url}`)
    }

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`getOrders failed: HTTP ${res.status} - ${text}`)
    }

    type RawLineItem = {
      lineItemId?:  string
      legacyItemId?: string
      legacyVariationId?: string
      title?:       string
      sku?:         string
      quantity?:    number | string
      lineItemCost?: { value?: string | number; currency?: string }
    }
    type RawShipTo = { fullName?: string }
    type RawOrder = {
      orderId?:                string
      legacyOrderId?:          string
      creationDate?:           string
      lastModifiedDate?:       string
      orderFulfillmentStatus?: string
      orderPaymentStatus?:     string
      buyer?:                  { username?: string }
      pricingSummary?:         { total?: { value?: string | number; currency?: string } }
      lineItems?:              RawLineItem[]
      fulfillmentStartInstructions?: Array<{ shippingStep?: { shipTo?: RawShipTo } }>
    }

    const parseNum = (v: string | number | undefined | null): number | null => {
      if (v === undefined || v === null || v === "") return null
      const n = typeof v === "number" ? v : parseFloat(String(v))
      return Number.isFinite(n) ? n : null
    }

    const data = (await res.json()) as { orders?: RawOrder[] }
    const rawOrders = Array.isArray(data.orders) ? data.orders : []

    const out: EbayOrderRow[] = []
    for (const raw of rawOrders) {
      const orderId = (raw.orderId ?? raw.legacyOrderId ?? "").trim()
      if (!orderId) continue

      const lineItems: EbayOrderLineItem[] = (Array.isArray(raw.lineItems) ? raw.lineItems : [])
        .map((li) => {
          const qtyRaw = li.quantity
          const qty =
            typeof qtyRaw === "number"
              ? qtyRaw
              : parseInt(String(qtyRaw ?? "0"), 10) || 0
          return {
            title:        (li.title ?? "").trim(),
            sku:          (li.sku ?? "").trim() || null,
            quantity:     qty > 0 ? qty : 0,
            lineItemId:   li.lineItemId?.trim() || null,
            legacyItemId: li.legacyItemId?.trim() || null,
            legacyVariationId: li.legacyVariationId?.trim() || null,
            itemPrice:    parseNum(li.lineItemCost?.value),
            currency:     li.lineItemCost?.currency?.trim() || null,
            raw:          li as Record<string, unknown>,
          }
        })

      const total = parseNum(raw.pricingSummary?.total?.value) ?? 0
      const currency = raw.pricingSummary?.total?.currency?.trim() || "USD"
      const buyerName =
        raw.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo?.fullName?.trim() || null

      out.push({
        orderId,
        legacyOrderId:     raw.legacyOrderId?.trim() || null,
        creationDate:      raw.creationDate?.trim() || null,
        lastModifiedDate:  raw.lastModifiedDate?.trim() || null,
        fulfillmentStatus: raw.orderFulfillmentStatus?.trim() || null,
        paymentStatus:     raw.orderPaymentStatus?.trim() || null,
        orderStatus:       raw.orderFulfillmentStatus?.trim() || null,
        buyerUsername:     raw.buyer?.username?.trim() || null,
        buyerName,
        total,
        currency,
        lineItems,
        raw:               raw as Record<string, unknown>,
      })
    }

    return out
  }

  /** GET /sell/fulfillment/v1/order/{orderId}/shipping_fulfillment */
  async getShippingFulfillments(orderId: string): Promise<{
    trackingNumber: string | null
    carrier: string | null
    shippedAt: string | null
    shipmentStatus: string | null
  } | null> {
    const clean = orderId.trim()
    if (!clean || this.simulationMode) return null
    const url = `${this.baseUrl}/sell/fulfillment/v1/order/${encodeURIComponent(clean)}/shipping_fulfillment`
    const res = await fetch(url, { headers: this.buildJsonHeaders() })
    if (res.status === 404 || res.status === 204) return null
    if (!res.ok) return null
    const data = (await res.json()) as {
      fulfillments?: Array<{
        shipmentTrackingNumber?: string
        shippingCarrierCode?: string
        shippedDate?: string
        shippingStatus?: string
      }>
    }
    const f = (data.fulfillments ?? []).find(x => x.shipmentTrackingNumber || x.shippingCarrierCode)
      ?? (data.fulfillments ?? [])[0]
    if (!f) return null
    return {
      trackingNumber: f.shipmentTrackingNumber?.trim() || null,
      carrier: f.shippingCarrierCode?.trim() || null,
      shippedAt: f.shippedDate?.trim() || null,
      shipmentStatus: f.shippingStatus?.trim() || null,
    }
  }

  /**
   * GET /sell/inventory/v1/offer?sku={sku}
   * İlk dönen offer kaydının offerId değeri (yoksa null).
   */
  async getOfferId(sku: string, signal?: AbortSignal): Promise<string | null> {
    if (this.simulationMode) {
      console.log(`    [eBayClient][SIM] getOfferId sku=${sku}`)
      return null
    }

    const clean = sku?.trim() ?? ""
    if (!clean) return null

    const url = `${this.baseUrl}/sell/inventory/v1/offer?sku=${encodeURIComponent(clean)}&marketplace_id=EBAY_US`
    const res = await fetch(url, { headers: this.buildJsonHeaders(), signal })

    if (res.status === 429) {
      await alertRateLimit("eBay API", `Rate limit aşıldı. URL: ${url}`)
      throw new Error(`Rate limit: HTTP 429 - ${url}`)
    }
    if (res.status >= 500) {
      await alertRateLimit("eBay API", `eBay sunucu hatası HTTP ${res.status}. URL: ${url}`)
    }

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`getOfferId failed: HTTP ${res.status} - ${text}`)
    }

    const page = (await res.json()) as EbayGetOffersPage
    const id   = page.offers?.[0]?.offerId?.trim()
    return id && id.length > 0 ? id : null
  }

  /**
   * Published offer lookup by eBay listing (item) ID — paginates GET /offer when SKU lookup fails.
   */
  async getOfferIdByListingId(listingId: string): Promise<string | null> {
    if (this.simulationMode) {
      console.log(`    [eBayClient][SIM] getOfferIdByListingId listingId=${listingId}`)
      return null
    }

    const target = listingId?.trim() ?? ""
    if (!target) return null

    const limit = 100
    let offset = 0
    const maxPages = 30

    for (let pageNum = 0; pageNum < maxPages; pageNum++) {
      const page = await this.getOffers(undefined, limit, offset)
      for (const o of page.offers ?? []) {
        const lid = o.listing?.listingId?.trim()
        if (lid === target) {
          const id = o.offerId?.trim()
          return id && id.length > 0 ? id : null
        }
      }

      const got = page.offers?.length ?? 0
      const total = typeof page.total === "number" ? page.total : 0
      if (got === 0) return null
      if (total > 0 && offset + got >= total) return null
      if (got < limit) return null
      offset += got
    }

    return null
  }

  /**
   * GET /sell/inventory/v1/offer/{offerId}
   * Tek offer kaydı — fiyat / stok; monitor için EbayActiveListingPriceRow.
   */
  async getOfferById(offerId: string, signal?: AbortSignal): Promise<EbayActiveListingPriceRow | null> {
    if (this.simulationMode) {
      console.log(`    [eBayClient][SIM] getOfferById offerId=${offerId}`)
      return null
    }

    const clean = offerId?.trim()
    if (!clean) return null

    const url = `${this.baseUrl}/sell/inventory/v1/offer/${encodeURIComponent(clean)}`
    const res = await fetch(url, { headers: this.buildJsonHeaders(), signal })

    if (res.status === 429) {
      await alertRateLimit("eBay API", `Rate limit aşıldı. URL: ${url}`)
      throw new Error(`Rate limit: HTTP 429 - ${url}`)
    }
    if (res.status >= 500) {
      await alertRateLimit("eBay API", `eBay sunucu hatası HTTP ${res.status}. URL: ${url}`)
    }

    if (res.status === 404) return null
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`getOfferById failed: HTTP ${res.status} - ${text}`)
    }

    const data = (await res.json()) as EbayOfferSummary
    return offerSummaryToActivePriceRow(data)
  }

  /**
   * PUT /sell/inventory/v1/offer/{offerId}
   * Aktif ilan stok miktarı (listing quantity) için offer güncellemesi.
   */
  async updateOfferQuantity(offerId: string, quantity: number, signal?: AbortSignal): Promise<void> {
    if (this.simulationMode) {
      console.log(`    [eBayClient][SIM] updateOfferQuantity offerId=${offerId} qty=${quantity}`)
      return
    }

    const url = `${this.baseUrl}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`
    const res = await fetch(url, {
      method:  "PUT",
      headers: this.buildJsonHeaders(),
      body:    JSON.stringify({ availableQuantity: quantity }),
      signal,
    })

    if (res.status === 429) {
      await alertRateLimit("eBay API", `Rate limit aşıldı. URL: ${url}`)
      throw new Error(`Rate limit: HTTP 429 - ${url}`)
    }
    if (res.status >= 500) {
      await alertRateLimit("eBay API", `eBay sunucu hatası HTTP ${res.status}. URL: ${url}`)
    }

    if (res.status !== 200 && res.status !== 204) {
      const text = await res.text()
      throw new Error(`updateOfferQuantity failed: HTTP ${res.status} - ${text}`)
    }
  }

  /**
   * Tüm offer listesi — SKU filtresi yok; yalnızca limit & offset.
   */
  private offerListUrl(limit: number, offset: number): string {
    return `${this.baseUrl}/sell/inventory/v1/offer?limit=${limit}&offset=${offset}`
  }

  /**
   * eBay `next` href'inden limit/offset okur; sku ve diğer sorgu parametrelerini kullanmaz.
   */
  private offerListUrlFromPaginationHref(
    href: string,
    fallbackLimit: number,
    fallbackOffset: number
  ): string {
    try {
      const u = new URL(href, this.baseUrl)
      if (!u.pathname.endsWith("/sell/inventory/v1/offer")) {
        return this.offerListUrl(fallbackLimit, fallbackOffset)
      }
      const limParsed = Number.parseInt(u.searchParams.get("limit") ?? "", 10)
      const offParsed = Number.parseInt(u.searchParams.get("offset") ?? "", 10)
      const lim = Number.isFinite(limParsed) && limParsed > 0 ? limParsed : fallbackLimit
      const off = Number.isFinite(offParsed) ? offParsed : fallbackOffset
      return this.offerListUrl(lim, off)
    } catch {
      return this.offerListUrl(fallbackLimit, fallbackOffset)
    }
  }

  /**
   * Toplu offer çekimi:
   * 1) GET /sell/inventory/v1/offer?limit=100&offset=… (SKU parametresi yok)
   * 2) İlk istek HTTP 400 dönerse (ör. invalid SKU) → Trading GetMyeBaySelling
   */
  async getAllOffersForImportBulk(): Promise<EbayActiveListingPriceRow[]> {
    if (this.simulationMode) {
      console.log(`    [eBayClient][SIM] getAllOffersForImportBulk -> []`)
      return []
    }

    const limit   = 100
    const collected: EbayActiveListingPriceRow[] = []
    let nextUrl: string | undefined = this.offerListUrl(limit, 0)
    let pageGuard   = 0
    let isFirstPage = true

    while (nextUrl && pageGuard < 500) {
      pageGuard++
      const res = await fetch(nextUrl, { headers: this.buildJsonHeaders() })

      if (res.status === 429) {
        await alertRateLimit("eBay API", `Rate limit aşıldı. URL: ${nextUrl}`)
        throw new Error(`Rate limit: HTTP 429 - ${nextUrl}`)
      }
      if (res.status >= 500) {
        await alertRateLimit("eBay API", `eBay sunucu hatası HTTP ${res.status}. URL: ${nextUrl}`)
      }

      if (res.status === 400 && isFirstPage) {
        const text = await res.text()
        console.warn(
          "[getAllOffersForImportBulk] GET /sell/inventory/v1/offer HTTP 400 → GetMyeBaySelling:",
          text.slice(0, 280)
        )
        return await this.fetchGetMyeBaySellingAllPages()
      }

      if (!res.ok) {
        const text = await res.text()
        throw new Error(`getAllOffersForImportBulk failed: HTTP ${res.status} - ${text}`)
      }

      isFirstPage = false
      const page = (await res.json()) as EbayGetOffersPage
      for (const o of page.offers ?? []) {
        const row = offerSummaryToActivePriceRow(o)
        if (row) collected.push(row)
      }

      const curOffset = typeof page.offset === "number" ? page.offset : 0
      const pageLimit = typeof page.limit === "number" && page.limit > 0 ? page.limit : limit
      const got       = page.offers?.length ?? 0
      const total     = typeof page.total === "number" ? page.total : 0

      if (typeof page.next === "string" && page.next.trim().length > 0) {
        const raw = page.next.startsWith("http") ? page.next : `${this.baseUrl}${page.next}`
        nextUrl = this.offerListUrlFromPaginationHref(raw, pageLimit, curOffset + got)
        continue
      }

      if (got === 0) {
        nextUrl = undefined
      } else if (total > 0 && curOffset + got < total) {
        nextUrl = this.offerListUrl(pageLimit, curOffset + got)
      } else if (total === 0 && got >= pageLimit) {
        nextUrl = this.offerListUrl(pageLimit, curOffset + got)
      } else {
        nextUrl = undefined
      }
    }

    return collected
  }

  private buildGetMyeBaySellingXml(pageNumber: number): string {
    const token = escapeXml(this.oauthToken)
    return (
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">` +
      `<RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>` +
      `<DetailLevel>ReturnAll</DetailLevel>` +
      `<ActiveList><Include>true</Include>` +
      `<Pagination><EntriesPerPage>100</EntriesPerPage><PageNumber>${pageNumber}</PageNumber></Pagination>` +
      `</ActiveList></GetMyeBaySellingRequest>`
    )
  }

  private parseTradingActiveItems(xml: string): EbayActiveListingPriceRow[] {
    const rows: EbayActiveListingPriceRow[] = []
    const listStart = xml.indexOf("<ItemArray>")
    const listEnd   = xml.indexOf("</ItemArray>")
    const slice =
      listStart >= 0 && listEnd > listStart
        ? xml.slice(listStart, listEnd + "</ItemArray>".length)
        : xml

    const itemRe = /<Item>([\s\S]*?)<\/Item>/gi
    let m: RegExpExecArray | null
    while ((m = itemRe.exec(slice)) !== null) {
      const block = m[1]

      const itemId = (xmlTextContent(block, "ItemID") ?? "").trim()
      const skuTag = (xmlTextContent(block, "SKU") ?? "").trim()
      const customLabel = (xmlTextContent(block, "CustomLabel") ?? "").trim()
      const sku = (skuTag || customLabel || itemId).trim()
      if (!sku) continue

      const title = xmlTextContent(block, "Title")
      const quantity = parseInt(xmlTextContent(block, "QuantityAvailable") || "0", 10) || 0
      let currentPrice = parseFloat(xmlTextContent(block, "CurrentPrice") || "0")
      if (!Number.isFinite(currentPrice)) {
        const curFull = block.match(
          /<CurrentPrice\s+[^>]*currencyID="([^"]+)"[^>]*>([\d.]+)<\/CurrentPrice>/i
        )
        const curSimple = block.match(/<CurrentPrice[^>]*>([\d.]+)<\/CurrentPrice>/i)
        currentPrice = parseFloat(curFull?.[2] ?? curSimple?.[1] ?? "0")
      }
      if (!Number.isFinite(currentPrice)) currentPrice = 0

      const curFull = block.match(
        /<CurrentPrice\s+[^>]*currencyID="([^"]+)"[^>]*>([\d.]+)<\/CurrentPrice>/i
      )
      const currency = curFull?.[1] ?? "USD"

      const imageUrlRaw = xmlTextContent(block, "GalleryURL")
      const imageUrlTrim = imageUrlRaw.trim()
      const imageUrl = imageUrlTrim.length > 0 ? imageUrlTrim : null
      const metrics = parseTradingItemMetricsBlock(block)

      rows.push({
        sku,
        price:             currentPrice,
        offerId:           "",
        listingId:         itemId || null,
        availableQuantity: quantity,
        currency,
        offerStatus:       null,
        title:             title.trim() ? title.trim() : null,
        currentPrice,
        quantityAvailable: quantity,
        imageUrl,
        quantitySold:      metrics.quantitySold,
        watchCount:        metrics.watchCount,
        listedAt:          metrics.listedAt,
      })
    }

    return rows
  }

  /**
   * Progressive Trading ActiveList pages. Caller persists each page before the next fetch.
   * Does not rewrite eBay request/response parsing — only yields pages.
   */
  async forEachGetMyeBaySellingPage(
    onPage: (
      pageRows: EbayActiveListingPriceRow[],
      meta: { pageNum: number; totalPages: number; totalEntries: string | undefined }
    ) => Promise<void>
  ): Promise<EbayCatalogPaginationReceipt> {
    const tradingUrl = this.isSandbox ? EBAY_TRADING_DLL_SB : EBAY_TRADING_DLL_PROD
    const siteId = (process.env.EBAY_SITE_ID ?? "0").trim()
    const remoteIds = new Set<string>()
    const receipt: EbayCatalogPaginationReceipt = {
      expectedTotalEntries: null, expectedTotalPages: null, requestedPageSize: 100,
      pagesAttempted: 0, pagesCompleted: 0, lastCompletedPage: 0, fetchedRowCount: 0,
      distinctRemoteItemCount: 0, duplicateRemoteItemCount: 0, fetchErrorCount: 0,
      firstError: null, paginationCompleted: false, totalsConsistent: false,
    }
    const fail = (message: string): never => {
      receipt.fetchErrorCount += 1
      receipt.firstError ??= message.slice(0, 1000)
      throw new EbayCatalogPaginationIncompleteError(receipt, message)
    }

    for (let pageNum = 1; pageNum <= 500; pageNum++) {
      receipt.pagesAttempted += 1
      const body = this.buildGetMyeBaySellingXml(pageNum)
      const res  = await fetch(tradingUrl, {
        method:  "POST",
        headers: {
          "Content-Type":                 "text/xml",
          "X-EBAY-API-CALL-NAME":         "GetMyeBaySelling",
          "X-EBAY-API-SITEID":            siteId,
          "X-EBAY-API-COMPATIBILITY-LEVEL": "1225",
        },
        body,
      })

      if (!res.ok) {
        const t = await res.text()
        fail(`Trading GetMyeBaySelling HTTP ${res.status}: ${t.slice(0, 400)}`)
      }

      const xml = await res.text()
      if (!/<Ack>(Success|Warning)<\/Ack>/i.test(xml)) {
        const short =
          xml.match(/<ShortMessage>([^<]*)<\/ShortMessage>/i)?.[1]?.trim() ??
          xml.match(/<LongMessage>([^<]*)<\/LongMessage>/i)?.[1]?.trim() ??
          xml.slice(0, 300)
        fail(`GetMyeBaySelling failed: ${short}`)
      }

      const pageRows = this.parseTradingActiveItems(xml)
      const totalPages = parseInt(
        xml.match(/<TotalNumberOfPages>(\d+)<\/TotalNumberOfPages>/i)?.[1] || "1",
        10
      )
      const totalEntries =
        xml.match(/<TotalNumberOfEntries>(\d+)<\/TotalNumberOfEntries>/i)?.[1]

      const parsedEntries = totalEntries == null ? NaN : parseInt(totalEntries, 10)
      if (!Number.isFinite(totalPages) || totalPages < 1 || !Number.isFinite(parsedEntries) || parsedEntries < 0) {
        fail(`GetMyeBaySelling returned invalid pagination metadata on page ${pageNum}`)
      }
      if ((receipt.expectedTotalPages != null && receipt.expectedTotalPages !== totalPages) ||
          (receipt.expectedTotalEntries != null && receipt.expectedTotalEntries !== parsedEntries)) {
        fail(`GetMyeBaySelling pagination metadata changed on page ${pageNum}`)
      }
      receipt.expectedTotalPages = totalPages
      receipt.expectedTotalEntries = parsedEntries

      console.log(`[Trading] page=${pageNum} rows=${pageRows.length}`)
      console.log(`[Trading] totalPages=${totalPages} totalEntries=${totalEntries}`)

      if (pageRows.length === 0 && pageNum < totalPages) {
        fail(`GetMyeBaySelling returned an unexpected empty page ${pageNum} of ${totalPages}`)
      }

      receipt.pagesCompleted += 1
      receipt.lastCompletedPage = pageNum
      receipt.fetchedRowCount += pageRows.length
      for (const row of pageRows) {
        const id = row.listingId?.trim()
        if (!id) continue
        if (remoteIds.has(id)) receipt.duplicateRemoteItemCount += 1
        remoteIds.add(id)
      }
      receipt.distinctRemoteItemCount = remoteIds.size
      await onPage(pageRows, { pageNum, totalPages, totalEntries })

      if (pageNum >= totalPages) break
      if (pageNum === 500) fail("GetMyeBaySelling exceeded the 500-page safety limit")
    }

    receipt.paginationCompleted = receipt.expectedTotalPages !== null && receipt.lastCompletedPage >= receipt.expectedTotalPages
    receipt.totalsConsistent = receipt.paginationCompleted && receipt.fetchErrorCount === 0 &&
      receipt.expectedTotalEntries === receipt.fetchedRowCount &&
      receipt.expectedTotalEntries === receipt.distinctRemoteItemCount && receipt.duplicateRemoteItemCount === 0
    if (!receipt.totalsConsistent) fail("GetMyeBaySelling completed with inconsistent row totals")
    console.log(`[getAllOffersForImportBulk] Trading API rows=${receipt.fetchedRowCount} pages=${receipt.pagesCompleted}`)
    return receipt
  }

  async fetchGetMyeBaySellingAllPages(): Promise<EbayActiveListingPriceRow[]> {
    const collected: EbayActiveListingPriceRow[] = []
    await this.forEachGetMyeBaySellingPage(async pageRows => {
      collected.push(...pageRows)
    })
    return collected
  }

  private async postTradingApi(callName: string, body: string, signal?: AbortSignal): Promise<string> {
    const tradingUrl = this.isSandbox ? EBAY_TRADING_DLL_SB : EBAY_TRADING_DLL_PROD
    const siteId = (process.env.EBAY_SITE_ID ?? "0").trim()
    const res = await fetch(tradingUrl, {
      method:  "POST",
      headers: {
        "Content-Type":                   "text/xml",
        "X-EBAY-API-CALL-NAME":           callName,
        "X-EBAY-API-SITEID":              siteId,
        "X-EBAY-API-COMPATIBILITY-LEVEL": "1225",
      },
      body,
      signal,
    })
    if (!res.ok) {
      const t = await res.text()
      let parsed: EbayTradingResponseClassification | null = null
      try {
        parsed = classifyEbayTradingResponse(t)
      } catch {
        parsed = null
      }
      const detail = parsed && (parsed.ack || parsed.errors.length > 0 || parsed.warnings.length > 0)
        ? formatTradingFailure(callName, parsed)
        : t.slice(0, 400)
      throw new EbayTradingApiError(
        `Trading ${callName} HTTP ${res.status}: ${detail}`,
        callName,
        res.status,
        parsed,
      )
    }
    const xml = await res.text()
    const parsed = classifyEbayTradingResponse(xml)
    if (!parsed.accepted) {
      throw new EbayTradingApiError(
        formatTradingFailure(callName, parsed).replace(
          `${callName} failed: `,
          `${callName} failed: HTTP ${res.status}; `,
        ),
        callName,
        res.status,
        parsed,
      )
    }
    return xml
  }

  /**
   * Seller → buyer message.
   * Primary: Commerce Message API POST /commerce/message/v1/send_message
   * Fallback: Trading AddMemberMessageAAQToPartner (existing Trading XML client).
   */
  async sendBuyerMessage(input: {
    buyerUsername: string
    body: string
    itemId?: string | null
    preferRest: boolean
    messageMedia?: Array<{ mediaName: string; mediaType: string; mediaUrl: string }>
    bodyWithoutMedia?: string
    allowTradingFallback?: boolean
  }): Promise<{
    messageId: string | null
    via: "commerce.message" | "trading"
    mediaIncluded: boolean
    mediaResult: string
  }> {
    const buyer = input.buyerUsername.trim()
    const text = input.body.trim()
    const itemId = input.itemId?.trim() || null
    const media = (input.messageMedia ?? []).filter(
      m => m.mediaUrl.trim() && m.mediaType.trim() && m.mediaName.trim()
    )
    const allowTrading = input.allowTradingFallback !== false
    if (!buyer) throw new Error("buyerUsername is required")
    if (!text) throw new Error("message body is required")
    if (this.simulationMode) {
      return {
        messageId: `SIM_MSG_${Date.now()}`,
        via: input.preferRest ? "commerce.message" : "trading",
        mediaIncluded: media.length > 0,
        mediaResult: media.length > 0 ? "simulated_included" : "none",
      }
    }

    if (input.preferRest) {
      try {
        const messageId = await this.sendCommerceMessage(buyer, text, itemId, media)
        return {
          messageId,
          via: "commerce.message",
          mediaIncluded: media.length > 0,
          mediaResult: media.length > 0 ? "included" : "none",
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        const definiteClientReject = /HTTP (400|422)\b/.test(msg)
        if (media.length > 0 && definiteClientReject) {
          const textOnlyBody = input.bodyWithoutMedia?.trim()
          if (!textOnlyBody) throw e
          const messageId = await this.sendCommerceMessage(buyer, textOnlyBody, itemId, [])
          return {
            messageId,
            via: "commerce.message",
            mediaIncluded: false,
            mediaResult: "media_rejected_text_only",
          }
        }
        if (allowTrading && /403|401|insufficient|invalid_scope|scope/i.test(msg) && itemId) {
          const messageId = await this.sendTradingMemberMessage(buyer, text, itemId, media)
          return {
            messageId,
            via: "trading",
            mediaIncluded: media.length > 0,
            mediaResult: media.length > 0 ? "trading_eps_included" : "trading_text_only",
          }
        }
        throw e
      }
    }

    if (!allowTrading) {
      throw new Error("Trading fallback disabled for this send")
    }
    if (!itemId) throw new Error("itemId is required for Trading AddMemberMessageAAQToPartner")
    const messageId = await this.sendTradingMemberMessage(buyer, text, itemId, media)
    return {
      messageId,
      via: "trading",
      mediaIncluded: media.length > 0,
      mediaResult: media.length > 0 ? "trading_eps_included" : "trading_text_only",
    }
  }

  /**
   * Message API GET /commerce/message/v1/conversation
   * conversation_type is required. Buyer inbox uses FROM_MEMBERS.
   */
  async getMessageConversations(input: {
    conversationType: "FROM_MEMBERS" | "FROM_EBAY"
    limit?: number
    offset?: number
  }): Promise<unknown> {
    const limit = Math.max(1, Math.min(50, input.limit ?? 25))
    const offset = Math.max(0, input.offset ?? 0)
    const params = new URLSearchParams()
    params.set("conversation_type", input.conversationType)
    params.set("limit", String(limit))
    params.set("offset", String(offset))
    const url = `${this.baseUrl}/commerce/message/v1/conversation?${params.toString()}`
    if (this.simulationMode) {
      return { conversations: [], limit, offset, total: 0 }
    }
    const res = await fetch(url, { headers: this.buildJsonHeaders() })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`commerce.message getConversations failed: HTTP ${res.status} - ${text.slice(0, 400)}`)
    }
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new Error("commerce.message getConversations: invalid JSON")
    }
  }

  /**
   * Message API GET /commerce/message/v1/conversation/{conversation_id}
   * conversation_type query is required.
   */
  async getMessageConversation(input: {
    conversationId: string
    conversationType: "FROM_MEMBERS" | "FROM_EBAY"
    limit?: number
    offset?: number
  }): Promise<unknown> {
    const id = input.conversationId.trim()
    if (!id) throw new Error("conversationId is required")
    const limit = Math.max(1, Math.min(50, input.limit ?? 25))
    const offset = Math.max(0, input.offset ?? 0)
    const params = new URLSearchParams()
    params.set("conversation_type", input.conversationType)
    params.set("limit", String(limit))
    params.set("offset", String(offset))
    const url = `${this.baseUrl}/commerce/message/v1/conversation/${encodeURIComponent(id)}?${params.toString()}`
    if (this.simulationMode) {
      return { conversationType: input.conversationType, messages: [], limit, offset, total: 0 }
    }
    const res = await fetch(url, { headers: this.buildJsonHeaders() })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`commerce.message getConversation failed: HTTP ${res.status} - ${text.slice(0, 400)}`)
    }
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new Error("commerce.message getConversation: invalid JSON")
    }
  }

  /**
   * Message API POST /commerce/message/v1/send_message
   * Reply to an existing conversation uses conversationId (not otherPartyUsername).
   */
  async sendConversationMessage(input: {
    conversationId: string
    messageText: string
  }): Promise<{ messageId: string | null }> {
    const conversationId = input.conversationId.trim()
    const messageText = input.messageText.trim()
    if (!conversationId) throw new Error("conversationId is required")
    if (!messageText) throw new Error("messageText is required")
    if (this.simulationMode) {
      return { messageId: `SIM_MSG_${Date.now()}` }
    }
    const url = `${this.baseUrl}/commerce/message/v1/send_message`
    const res = await fetch(url, {
      method: "POST",
      headers: this.buildJsonHeaders(),
      body: JSON.stringify({
        conversationId,
        messageText: messageText.slice(0, 2000),
      }),
    })
    const text = await res.text()
    if (!res.ok && res.status !== 201) {
      throw new Error(`commerce.message send_message failed: HTTP ${res.status} - ${text.slice(0, 400)}`)
    }
    try {
      const data = JSON.parse(text) as { messageId?: string }
      return { messageId: data.messageId?.trim() || null }
    } catch {
      return { messageId: null }
    }
  }

  /** Message API POST /commerce/message/v1/update_conversation — mark read. */
  async markConversationRead(input: {
    conversationId: string
    conversationType: "FROM_MEMBERS" | "FROM_EBAY"
  }): Promise<void> {
    const conversationId = input.conversationId.trim()
    if (!conversationId || this.simulationMode) return
    const url = `${this.baseUrl}/commerce/message/v1/update_conversation`
    const res = await fetch(url, {
      method: "POST",
      headers: this.buildJsonHeaders(),
      body: JSON.stringify({
        conversationId,
        conversationType: input.conversationType,
        read: true,
      }),
    })
    if (res.status === 204 || res.ok) return
    const text = await res.text()
    throw new Error(`commerce.message update_conversation failed: HTTP ${res.status} - ${text.slice(0, 400)}`)
  }

  private async sendCommerceMessage(
    buyerUsername: string,
    body: string,
    itemId: string | null,
    messageMedia: Array<{ mediaName: string; mediaType: string; mediaUrl: string }> = []
  ): Promise<string | null> {
    const url = `${this.baseUrl}/commerce/message/v1/send_message`
    const payload: Record<string, unknown> = {
      messageText: body.slice(0, 2000),
      otherPartyUsername: buyerUsername,
    }
    if (itemId) {
      payload.reference = { referenceType: "LISTING", referenceId: itemId }
    }
    if (messageMedia.length > 0) {
      payload.messageMedia = messageMedia.slice(0, 1).map(m => ({
        mediaName: m.mediaName.slice(0, 100),
        mediaType: m.mediaType,
        mediaUrl: m.mediaUrl,
      }))
    }
    const res = await fetch(url, {
      method: "POST",
      headers: this.buildJsonHeaders(),
      body: JSON.stringify(payload),
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`commerce.message send_message failed: HTTP ${res.status} - ${text.slice(0, 400)}`)
    }
    try {
      const data = JSON.parse(text) as { messageId?: string; conversationId?: string }
      return data.messageId?.trim() || data.conversationId?.trim() || null
    } catch {
      return null
    }
  }

  private async sendTradingMemberMessage(
    buyerUsername: string,
    body: string,
    itemId: string,
    messageMedia: Array<{ mediaName: string; mediaType: string; mediaUrl: string }> = []
  ): Promise<string | null> {
    const token = escapeXml(this.oauthToken)
    const xmlBody =
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<AddMemberMessageAAQToPartnerRequest xmlns="urn:ebay:apis:eBLBaseComponents">` +
      `<RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>` +
      `<ItemID>${escapeXml(itemId)}</ItemID>` +
      `<MemberMessage>` +
      `<Subject>Thank you for your order</Subject>` +
      `<Body>${escapeXml(body.slice(0, 2000))}</Body>` +
      `<QuestionType>General</QuestionType>` +
      `<RecipientID>${escapeXml(buyerUsername)}</RecipientID>` +
      `<EmailCopyToSender>false</EmailCopyToSender>` +
      messageMedia.slice(0, 5).map(m =>
        `<MessageMedia><MediaName>${escapeXml(m.mediaName.slice(0, 100))}</MediaName>` +
        `<MediaURL>${escapeXml(m.mediaUrl.slice(0, 200))}</MediaURL></MessageMedia>`
      ).join("") +
      `</MemberMessage>` +
      `</AddMemberMessageAAQToPartnerRequest>`
    const xml = await this.postTradingApi("AddMemberMessageAAQToPartner", xmlBody)
    return xmlTextContent(xml, "MessageID") || null
  }

  /** Trading GetItem — QuantityAvailable for a single listing (minimal read). */
  async getItemQuantityAvailable(itemId: string, signal?: AbortSignal): Promise<number | null> {
    if (this.simulationMode) return null
    const id = itemId.trim()
    if (!id) return null

    const token = escapeXml(this.oauthToken)
    const body =
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">` +
      `<RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>` +
      `<ItemID>${escapeXml(id)}</ItemID>` +
      `<DetailLevel>ReturnAll</DetailLevel>` +
      `</GetItemRequest>`

    const xml = await this.postTradingApi("GetItem", body, signal)
    const itemBlock = xml.match(/<Item>([\s\S]*?)<\/Item>/i)?.[1]
    if (!itemBlock) return null

    const qty = parseInt(xmlTextContent(itemBlock, "QuantityAvailable") || "0", 10)
    return Number.isFinite(qty) ? qty : null
  }

  /** Trading GetItem — tek listing için QuantitySold / WatchCount / StartTime */
  async fetchGetItemListingMetrics(itemId: string): Promise<EbayListingMetricsRow | null> {
    if (this.simulationMode) return null
    const id = itemId.trim()
    if (!id) return null

    const token = escapeXml(this.oauthToken)
    const body =
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">` +
      `<RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>` +
      `<ItemID>${escapeXml(id)}</ItemID>` +
      `<DetailLevel>ReturnAll</DetailLevel>` +
      `</GetItemRequest>`

    const xml = await this.postTradingApi("GetItem", body)
    const itemBlock = xml.match(/<Item>([\s\S]*?)<\/Item>/i)?.[1]
    if (!itemBlock) return null

    const metrics = parseTradingItemMetricsBlock(itemBlock)
    return {
      listingId:    id,
      quantitySold: metrics.quantitySold,
      watchCount:   metrics.watchCount,
      listedAt:     metrics.listedAt,
    }
  }

  /** Trading ReviseFixedPriceItem — update StartPrice by ItemID (legacy / fallback). */
  async reviseFixedPriceItemPrice(itemId: string, price: number): Promise<{ warnings: EbayTradingDiagnostic[] }> {
    if (this.simulationMode) {
      console.log(`    [eBayClient][SIM] reviseFixedPriceItemPrice itemId=${itemId} price=${price}`)
      return { warnings: [] }
    }
    const id = itemId.trim()
    if (!id) throw new Error("itemId is required")
    if (!Number.isFinite(price) || price <= 0) throw new Error("price must be > 0")

    const token = escapeXml(this.oauthToken)
    const priceStr = price.toFixed(2)
    const body =
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">` +
      `<RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>` +
      `<Item>` +
      `<ItemID>${escapeXml(id)}</ItemID>` +
      `<StartPrice>${priceStr}</StartPrice>` +
      `</Item>` +
      `</ReviseFixedPriceItemRequest>`

    console.log(`[eBayClient][ReviseFixedPriceItem] itemId=${id} price=${priceStr}`)
    const xml = await this.postTradingApi("ReviseFixedPriceItem", body)
    const parsed = classifyEbayTradingResponse(xml)
    console.log(`[eBayClient][ReviseFixedPriceItem] price success itemId=${id} ack=${parsed.ack}${parsed.warnings.length ? ` warnings=${parsed.warnings.length}` : ""}`)
    return { warnings: parsed.warnings }
  }

  /** GET /sell/inventory/v1/offer/{offerId} — raw JSON for offer PUT (price updates). */
  async getOfferRecordById(offerId: string): Promise<Record<string, unknown>> {
    if (this.simulationMode) {
      return {
        offerId,
        sku: "SIM-SKU",
        categoryId: "0",
        marketplaceId: "EBAY_US",
        merchantLocationKey: "default",
        listingPolicies: {},
        listingDescription: "Listing",
      }
    }
    const id = offerId.trim()
    if (!id) throw new Error("offerId is required")
    const url = `${this.baseUrl}/sell/inventory/v1/offer/${encodeURIComponent(id)}`
    const res = await fetch(url, { headers: this.buildJsonHeaders() })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`getOffer failed: HTTP ${res.status} - ${text}`)
    }
    return res.json() as Promise<Record<string, unknown>>
  }

  private buildOfferPriceUpdateBody(
    raw: Record<string, unknown>,
    newPrice: number,
    fallback?: {
      categoryId?: string
      merchantLocationKey?: string
      listingDescription?: string
      listingPolicies?: {
        fulfillmentPolicyId: string
        paymentPolicyId: string
        returnPolicyId: string
      }
    }
  ): EbayUpdateOfferRequest {
    const categoryId = String(raw.categoryId ?? fallback?.categoryId ?? "").trim()
    const merchantLocationKey = String(
      raw.merchantLocationKey ?? fallback?.merchantLocationKey ?? ""
    ).trim()
    const lp = raw.listingPolicies
    let fulfillmentPolicyId = ""
    let paymentPolicyId = ""
    let returnPolicyId = ""
    if (lp && typeof lp === "object") {
      const policies = lp as Record<string, unknown>
      fulfillmentPolicyId = String(policies.fulfillmentPolicyId ?? "").trim()
      paymentPolicyId = String(policies.paymentPolicyId ?? "").trim()
      returnPolicyId = String(policies.returnPolicyId ?? "").trim()
    }
    if (fallback?.listingPolicies) {
      fulfillmentPolicyId =
        fulfillmentPolicyId || fallback.listingPolicies.fulfillmentPolicyId.trim()
      paymentPolicyId =
        paymentPolicyId || fallback.listingPolicies.paymentPolicyId.trim()
      returnPolicyId = returnPolicyId || fallback.listingPolicies.returnPolicyId.trim()
    }
    if (!categoryId || !merchantLocationKey || !fulfillmentPolicyId || !paymentPolicyId || !returnPolicyId) {
      throw new Error("getOffer returned incomplete offer — cannot update price")
    }
    const ps = raw.pricingSummary as { price?: { currency?: string } } | undefined
    const currency = ps?.price?.currency?.trim() || "USD"
    return {
      categoryId,
      listingPolicies: { fulfillmentPolicyId, paymentPolicyId, returnPolicyId },
      merchantLocationKey,
      pricingSummary: {
        price: { value: newPrice.toFixed(2), currency },
      },
    }
  }

  /** Inventory offer price update — partial PUT first, full offer body fallback on 400. */
  async updateOfferPriceById(
    offerId: string,
    newPrice: number,
    fallback?: {
      categoryId?: string
      merchantLocationKey?: string
      listingDescription?: string
      listingPolicies?: {
        fulfillmentPolicyId: string
        paymentPolicyId: string
        returnPolicyId: string
      }
    }
  ): Promise<void> {
    if (this.simulationMode) {
      recordEbayMutation("price", "simulated")
      console.log(`    [eBayClient][SIM] updateOfferPriceById offerId=${offerId} price=${newPrice}`)
      return
    }
    recordEbayMutation("price", "real")
    const id = offerId.trim()
    if (!id) throw new Error("offerId is required")
    if (!Number.isFinite(newPrice) || newPrice <= 0) throw new Error("price must be > 0")

    const raw = await this.getOfferRecordById(id)
    const ps = raw.pricingSummary as { price?: { currency?: string } } | undefined
    const currency = ps?.price?.currency?.trim() || "USD"


    const url = `${this.baseUrl}/sell/inventory/v1/offer/${encodeURIComponent(id)}`
    const partialBody: Record<string, unknown> = {
      pricingSummary: {
        price: { value: newPrice.toFixed(2), currency },
      },
    }
    const partialRes = await fetch(url, {
      method:  "PUT",
      headers: this.buildJsonHeaders(),
      body:    JSON.stringify(partialBody),
    })

    if (partialRes.status === 429) {
      await alertRateLimit("eBay API", `Rate limit aşıldı. URL: ${url}`)
      throw new Error(`Rate limit: HTTP 429 - ${url}`)
    }
    if (partialRes.status >= 500) {
      await alertRateLimit("eBay API", `eBay sunucu hatası HTTP ${partialRes.status}. URL: ${url}`)
    }

    if (partialRes.status === 200 || partialRes.status === 204) {
      return
    }

    if (partialRes.status === 400) {
      const fullBody = this.buildOfferPriceUpdateBody(raw, newPrice, fallback)
      await this.updateOffer(id, fullBody)
      return
    }

    const text = await partialRes.text()
    throw new Error(`updateOfferPriceById failed: HTTP ${partialRes.status} - ${text}`)
  }

  /** Trading ReviseFixedPriceItem — set quantity on fixed-price listing by ItemID */
  async reviseFixedPriceItemQuantity(itemId: string, quantity: number, signal?: AbortSignal): Promise<void> {
    if (this.simulationMode) {
      recordEbayMutation("quantity", "simulated")
      console.log(`    [eBayClient][SIM] reviseFixedPriceItemQuantity itemId=${itemId} qty=${quantity}`)
      return
    }
    recordEbayMutation("quantity", "real")
    const id = itemId.trim()
    if (!id) throw new Error("itemId is required")
    if (quantity < 0) throw new Error("quantity must be >= 0")

    const token = escapeXml(this.oauthToken)
    const body =
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">` +
      `<RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>` +
      `<Item>` +
      `<ItemID>${escapeXml(id)}</ItemID>` +
      `<Quantity>${quantity}</Quantity>` +
      `</Item>` +
      `</ReviseFixedPriceItemRequest>`

    console.log(`[eBayClient][ReviseFixedPriceItem] itemId=${id} qty=${quantity}`)
    await this.postTradingApi("ReviseFixedPriceItem", body, signal)
    console.log(`[eBayClient][ReviseFixedPriceItem] success itemId=${id}`)
  }

  /** Trading EndFixedPriceItem — legacy listings without offerId */
  async endFixedPriceItem(itemId: string): Promise<void> {
    if (this.simulationMode) {
      recordEbayMutation("end", "simulated")
      console.log(`    [eBayClient][SIM] endFixedPriceItem itemId=${itemId}`)
      return
    }
    recordEbayMutation("end", "real")
    const id = itemId.trim()
    if (!id) throw new Error("itemId is required")

    const token = escapeXml(this.oauthToken)
    const body =
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<EndFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">` +
      `<RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>` +
      `<ItemID>${escapeXml(id)}</ItemID>` +
      `<EndingReason>NotAvailable</EndingReason>` +
      `</EndFixedPriceItemRequest>`

    await this.postTradingApi("EndFixedPriceItem", body)
  }

  /**
   * Sell Analytics traffic_report (30 days, LISTING dimension, LISTING_VIEWS_TOTAL).
   * Scope: sell.analytics.readonly — returns ok=false when scope missing; no fake data.
   */
  async getTrafficReport30dByListings(
    listingIds?: string[]
  ): Promise<EbayTrafficReportResult> {
    return this.fetchTrafficReportListings30d(listingIds)
  }

  /** @deprecated Use getTrafficReport30dByListings */
  async fetchTrafficReportListings30d(
    listingIds?: string[]
  ): Promise<EbayTrafficReportResult> {
    if (this.simulationMode) {
      return { ok: false, error: "Simulation mode", rows: [] }
    }

    const end = new Date()
    const start = new Date()
    start.setDate(start.getDate() - 30)
    const fmt = (d: Date) =>
      `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`
    const dateRange = `[${fmt(start)}..${fmt(end)}]`
    const filterParts = [
      "marketplace_ids:%7BEBAY_US%7D",
      `date_range:${encodeURIComponent(dateRange)}`,
    ]
    if (listingIds && listingIds.length > 0) {
      const ids = listingIds.map(id => id.trim()).filter(Boolean).slice(0, 200)
      if (ids.length > 0) {
        filterParts.push(`listing_ids:${encodeURIComponent(`{${ids.join("|")}}`)}`)
      }
    }

    const metrics = "LISTING_VIEWS_TOTAL"

    const url =
      `${this.baseUrl}/sell/analytics/v1/traffic_report` +
      `?dimension=LISTING&filter=${filterParts.join(",")}&metric=${encodeURIComponent(metrics)}`

    try {
      const res = await fetch(url, { headers: this.buildJsonHeaders() })
      if (res.status === 401 || res.status === 403) {
        const t = await res.text().catch(() => "")
        return {
          ok:    false,
          error: t.includes("scope") || res.status === 403
            ? "Analytics scope missing (sell.analytics.readonly)"
            : "eBay token expired or unauthorized",
          rows:  [],
        }
      }
      if (!res.ok) {
        const t = await res.text().catch(() => "")
        return {
          ok:    false,
          error: `Analytics HTTP ${res.status}: ${t.slice(0, 200)}`,
          rows:  [],
        }
      }

      const data = (await res.json()) as {
        header?: { metrics?: { key: string }[] }
        records?: {
          dimensionValues?: { value?: string }[]
          metricValues?: { value?: number | string; applicable?: boolean }[]
        }[]
      }

      const metricKeys = (data.header?.metrics ?? []).map(m => m.key)
      const rows: EbayListingTrafficMetrics[] = []

      for (const rec of data.records ?? []) {
        const listingId = rec.dimensionValues?.[0]?.value?.trim()
        if (!listingId) continue

        const values = rec.metricValues ?? []
        const byKey = new Map<string, number>()
        metricKeys.forEach((key, i) => {
          const raw = values[i]?.value
          const n = typeof raw === "number" ? raw : parseFloat(String(raw ?? ""))
          if (Number.isFinite(n)) byKey.set(key, n)
        })

        const viewsTotal = byKey.get("LISTING_VIEWS_TOTAL")
        const views =
          viewsTotal != null && Number.isFinite(viewsTotal) ? Math.max(0, Math.floor(viewsTotal)) : 0

        rows.push({
          listingId,
          clicks30d: views,
          views30d: null,
          impressions30d: null,
        })
      }

      return { ok: true, rows }
    } catch (e) {
      return {
        ok:    false,
        error: e instanceof Error ? e.message : String(e),
        rows:  [],
      }
    }
  }

  /**
   * Aktif listeleme fiyat / stok: GET /sell/inventory/v1/offer?limit=100&offset=…
   * Tüm sayfalar (`next` veya offset + total). Başarısız olursa getInventoryItems yedeği.
   */
  async getActiveListingPrices(): Promise<EbayActiveListingPriceRow[]> {
    if (this.simulationMode) {
      console.log(`    [eBayClient][SIM] getActiveListingPrices -> []`)
      return []
    }

    try {
      return await this.fetchPublishedPricesViaOffers()
    } catch (e) {
      console.warn(
        "[getActiveListingPrices] /offer pagination failed, fallback getInventoryItems:",
        e instanceof Error ? e.message : String(e)
      )
      return await this.fetchPublishedPricesViaInventoryItems()
    }
  }

  /**
   * GET /sell/inventory/v1/inventory_item?limit=100&offset=… — tüm sayfalar (SKU birleştirmez).
   * SKU gerektirmez; her item: sku, product.title, availability.shipToLocationAvailability.quantity
   * (+ varsa kayıttaki fiyat / offerId / listingId alanları).
   * `publishedOnly`: true ise yalnızca listingId veya offerId dolu satırlar (envanter listesinde genelde yoktur; varsayılan false).
   */
  async getAllOffersPaginated(options?: { publishedOnly?: boolean }): Promise<EbayActiveListingPriceRow[]> {
    if (this.simulationMode) {
      console.log(`    [eBayClient][SIM] getAllOffersPaginated -> []`)
      return []
    }

    const publishedOnly = options?.publishedOnly ?? false
    const limit         = 100
    const collected: EbayActiveListingPriceRow[] = []
    let nextUrl: string | undefined =
      `${this.baseUrl}/sell/inventory/v1/inventory_item?limit=${limit}&offset=0`
    let pageGuard = 0

    while (nextUrl && pageGuard < 500) {
      pageGuard++
      const res = await fetch(nextUrl, { headers: this.buildJsonHeaders() })

      if (res.status === 429) {
        await alertRateLimit("eBay API", `Rate limit aşıldı. URL: ${nextUrl}`)
        throw new Error(`Rate limit: HTTP 429 - ${nextUrl}`)
      }
      if (res.status >= 500) {
        await alertRateLimit("eBay API", `eBay sunucu hatası HTTP ${res.status}. URL: ${nextUrl}`)
      }

      if (!res.ok) {
        const text = await res.text()
        throw new Error(`getAllOffersPaginated failed: HTTP ${res.status} - ${text}`)
      }

      const page = (await res.json()) as EbayGetInventoryItemsPage
      for (const item of page.inventoryItems ?? []) {
        const row = inventoryItemToActivePriceRow(item)
        if (!row) continue
        if (publishedOnly) {
          const published =
            (row.listingId != null && String(row.listingId).trim().length > 0) ||
            (row.offerId != null && String(row.offerId).trim().length > 0)
          if (!published) continue
        }
        collected.push(row)
      }

      const curOffset = typeof page.offset === "number" ? page.offset : 0
      const pageLimit = typeof page.limit === "number" && page.limit > 0 ? page.limit : limit
      const got       = page.inventoryItems?.length ?? 0
      const total     = typeof page.total === "number" ? page.total : 0

      if (typeof page.next === "string" && page.next.trim().length > 0) {
        const raw = page.next.startsWith("http") ? page.next : `${this.baseUrl}${page.next}`
        nextUrl = raw
        continue
      }

      if (got === 0) {
        nextUrl = undefined
      } else if (total > 0 && curOffset + got < total) {
        nextUrl =
          `${this.baseUrl}/sell/inventory/v1/inventory_item?limit=${pageLimit}&offset=${curOffset + got}`
      } else if (total === 0 && got >= pageLimit) {
        nextUrl =
          `${this.baseUrl}/sell/inventory/v1/inventory_item?limit=${pageLimit}&offset=${curOffset + got}`
      } else {
        nextUrl = undefined
      }
    }

    return collected
  }

  private async fetchPublishedPricesViaOffers(): Promise<EbayActiveListingPriceRow[]> {
    const limit   = 100
    const collected: EbayActiveListingPriceRow[] = []
    let nextUrl: string | undefined = this.offerListUrl(limit, 0)
    let pageGuard = 0

    while (nextUrl && pageGuard < 500) {
      pageGuard++
      console.log("[getActiveListingPrices] fetching URL:", nextUrl)
      const res = await fetch(nextUrl, { headers: this.buildJsonHeaders() })
      console.log("[getActiveListingPrices] response status:", res.status)

      if (res.status === 429) {
        await alertRateLimit("eBay API", `Rate limit aşıldı. URL: ${nextUrl}`)
        throw new Error(`Rate limit: HTTP 429 - ${nextUrl}`)
      }
      if (res.status >= 500) {
        await alertRateLimit("eBay API", `eBay sunucu hatası HTTP ${res.status}. URL: ${nextUrl}`)
      }

      if (!res.ok) {
        const text = await res.text()
        throw new Error(`getActiveListingPrices offer failed: HTTP ${res.status} - ${text}`)
      }

      const page = (await res.json()) as EbayGetOffersPage
      for (const o of page.offers ?? []) {
        const row = offerSummaryToActivePriceRow(o)
        if (row) collected.push(row)
      }

      const curOffset = typeof page.offset === "number" ? page.offset : 0
      const pageLimit = typeof page.limit === "number" && page.limit > 0 ? page.limit : limit
      const got       = page.offers?.length ?? 0
      const total     = typeof page.total === "number" ? page.total : 0

      if (typeof page.next === "string" && page.next.trim().length > 0) {
        const raw = page.next.startsWith("http") ? page.next : `${this.baseUrl}${page.next}`
        nextUrl = this.offerListUrlFromPaginationHref(raw, pageLimit, curOffset + got)
        continue
      }

      if (got === 0) {
        nextUrl = undefined
      } else if (total > 0 && curOffset + got < total) {
        nextUrl = this.offerListUrl(pageLimit, curOffset + got)
      } else if (total === 0 && got >= pageLimit) {
        nextUrl = this.offerListUrl(pageLimit, curOffset + got)
      } else {
        nextUrl = undefined
      }
    }

    return mergeListingPriceRowsBySku(collected)
  }

  private async fetchPublishedPricesViaInventoryItems(): Promise<EbayActiveListingPriceRow[]> {
    const inv = await this.getInventoryItems(200)
    const collected: EbayActiveListingPriceRow[] = []
    for (const item of inv.inventoryItems ?? []) {
      const row = inventoryItemToActivePriceRow(item)
      if (row) collected.push(row)
    }
    return mergeListingPriceRowsBySku(collected)
  }

  // ----------------------------------------------------------------
  // POST /sell/inventory/v1/offer/{offerId}/publish
  // ----------------------------------------------------------------

  async publishOffer(offerId: string): Promise<EbayPublishOfferResponse> {
    if (this.simulationMode) {
      recordEbayMutation("publish", "simulated")
      const simulatedListingId = `SIM-LISTING-${offerId}-${Date.now()}`
      console.log(`    [eBayClient][SIM] publishOffer offerId=${offerId} listingId=${simulatedListingId}`)
      return { listingId: simulatedListingId, warnings: [] }
    }
    recordEbayMutation("publish", "real")

    const url      = `${this.baseUrl}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish`
    const response = await fetch(url, {
      method:  "POST",
      headers: this.buildJsonHeaders(),
    })

    if (response.status === 429) {
      await alertRateLimit("eBay API", `Rate limit aşıldı. URL: ${url}`)
      throw new Error(`Rate limit: HTTP 429 - ${url}`)
    }
    if (response.status >= 500) {
      await alertRateLimit("eBay API", `eBay sunucu hatası HTTP ${response.status}. URL: ${url}`)
    }

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`publishOffer failed: HTTP ${response.status} - ${text}`)
    }

    return response.json() as Promise<EbayPublishOfferResponse>
  }

  // ----------------------------------------------------------------
  // DELETE /sell/inventory/v1/offer/{offerId}
  // ----------------------------------------------------------------

  async withdrawOffer(offerId: string): Promise<void> {
    if (this.simulationMode) {
      recordEbayMutation("end", "simulated")
      console.log(`    [eBayClient][SIM] withdrawOffer offerId=${offerId}`)
      return
    }
    recordEbayMutation("end", "real")

    const url = `${this.baseUrl}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/withdraw`
    const res = await fetch(url, { method: "POST", headers: this.buildJsonHeaders() })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`withdrawOffer failed: HTTP ${res.status} - ${text}`)
    }
  }

  // ----------------------------------------------------------------
  // Quantity update — bulk_update_price_quantity (no description required)
  // ----------------------------------------------------------------

  async updateQuantity(sku: string, quantity: number, storedOfferId?: string, signal?: AbortSignal): Promise<void> {
    if (this.simulationMode) {
      recordEbayMutation("quantity", "simulated")
      console.log(`    [eBayClient][SIM] updateQuantity sku=${sku} qty=${quantity}`)
      return
    }
    recordEbayMutation("quantity", "real")

    const clean = sku.trim()
    if (!clean) throw new Error("sku is required")
    if (quantity < 0) throw new Error("quantity must be >= 0")

    const offerId = storedOfferId?.trim() || await this.getOfferId(clean, signal)

    const request: {
      sku: string
      shipToLocationAvailability: { quantity: number }
      offers?: Array<{ offerId: string; availableQuantity: number }>
    } = {
      sku: clean,
      shipToLocationAvailability: { quantity },
    }

    if (offerId) {
      request.offers = [{ offerId, availableQuantity: quantity }]
    }

    const url = `${this.baseUrl}/sell/inventory/v1/bulk_update_price_quantity`
    const res  = await fetch(url, {
      method:  "POST",
      headers: this.buildJsonHeaders(),
      body:    JSON.stringify({ requests: [request] }),
      signal,
    })

    const text = await res.text()
    console.log(`[eBayClient][updateQuantity] bulk_update_price_quantity status=${res.status} body=${text}`)

    if (res.status === 429) {
      await alertRateLimit("eBay API", `Rate limit aşıldı. URL: ${url}`)
      throw new Error(`Rate limit: HTTP 429 - ${url}`)
    }
    if (res.status >= 500) {
      await alertRateLimit("eBay API", `eBay sunucu hatası HTTP ${res.status}. URL: ${url}`)
    }

    if (!res.ok) {
      throw new Error(`updateQuantity failed: HTTP ${res.status} - ${text}`)
    }

    if (!text.trim()) return

    type BulkQtyResponse = {
      responses?: Array<{
        statusCode?: number
        sku?:        string
        errors?:     Array<{ message?: string }>
      }>
    }

    let parsed: BulkQtyResponse
    try {
      parsed = JSON.parse(text) as BulkQtyResponse
    } catch {
      return
    }

    const responses = parsed.responses ?? []
    const failures = responses.filter(item => item.statusCode !== 200)
    if (responses.length === 0 || failures.length > 0) {
      const errMsg = failures.map(item =>
        item.errors?.map(e => e.message).filter(Boolean).join("; ") ||
        "statusCode=" + (item.statusCode ?? "missing")
      ).join("; ") || "missing item response"
      throw new Error("updateQuantity failed: " + errMsg)
    }

  }

  /** Buyer-visible Inventory mutation for an already-published offer. */
  async updateLiveOfferPriceQuantity(input: { sku: string; offerId: string; price: number; quantity: number }, signal?: AbortSignal): Promise<void> {
    if (this.simulationMode) {
      recordEbayMutation("price", "simulated")
      return
    }
    recordEbayMutation("price", "real")
    if (!input.sku.trim() || !input.offerId.trim() || !Number.isFinite(input.price) || input.price <= 0 || input.quantity < 0) {
      throw new Error("live price update requires sku, offerId, positive price and non-negative quantity")
    }
    const url = `${this.baseUrl}/sell/inventory/v1/bulk_update_price_quantity`
    const res = await fetch(url, {
      method: "POST", headers: this.buildJsonHeaders(), signal,
      // bulk_update_price_quantity has a compact offer shape: its price is
      // directly under offers[].  `pricingSummary.price` is accepted for an
      // Offer resource, but is ignored by this bulk endpoint (leaving price
      // unchanged while the response still reports HTTP/status 200).
      body: JSON.stringify({ requests: [{ sku: input.sku.trim(), shipToLocationAvailability: { quantity: input.quantity }, offers: [{ offerId: input.offerId.trim(), availableQuantity: input.quantity, price: { value: input.price.toFixed(2), currency: "USD" } }] }] }),
    })
    const text = await res.text()
    if (res.status === 429 || res.status >= 500) throw new Error(`updateLiveOfferPriceQuantity retryable: HTTP ${res.status} - ${text}`)
    if (!res.ok) throw new Error(`updateLiveOfferPriceQuantity failed: HTTP ${res.status} - ${text}`)
    const parsed = text.trim() ? JSON.parse(text) as { responses?: Array<{ statusCode?: number; errors?: Array<{ errorId?: number; message?: string }> }> } : {}
    const bad = (parsed.responses ?? []).find(x => x.statusCode !== 200)
    if (bad) throw new Error(`updateLiveOfferPriceQuantity failed: ${bad.errors?.map(e => `${e.errorId ?? ""} ${e.message ?? ""}`).join("; ") || `statusCode=${bad.statusCode}`}`)
  }

  // ----------------------------------------------------------------
  // TOKEN VALIDITY CHECK
  // ----------------------------------------------------------------

  getToken(): string { return this.oauthToken }

  isSimulation(): boolean { return this.simulationMode }

  // ----------------------------------------------------------------
  // HEADERS
  // ----------------------------------------------------------------

  private maskHeadersForLog(headers: Record<string, string>): Record<string, string> {
    const out = { ...headers }
    if (out.Authorization) out.Authorization = "Bearer [REDACTED]"
    if (out.authorization) out.authorization = "Bearer [REDACTED]"
    return out
  }

  private buildAuthHeaders(): Record<string, string> {
    return {
      Authorization:    `Bearer ${this.oauthToken}`,
      Accept:           "application/json",
      "Accept-Language":  "en-US",
    }
  }

  private buildJsonHeaders(): Record<string, string> {
    return {
      Authorization:    `Bearer ${this.oauthToken}`,
      "Content-Type":   "application/json",
      Accept:           "application/json",
      "Accept-Language":  "en-US",
      "Content-Language": "en-US",
    }
  }

  private buildFinancesHeaders(): Record<string, string> {
    return {
      Authorization:             `Bearer ${this.oauthToken}`,
      Accept:                    "application/json",
      "Accept-Language":           "en-US",
      "Content-Type":            "application/json",
      "X-EBAY-C-MARKETPLACE-ID":  "EBAY_US",
    }
  }

  // ----------------------------------------------------------------
  // Sell Finances API — Order earnings (Seller Hub "Order earnings")
  // ----------------------------------------------------------------

  /**
   * Preferred: GET /sell/finances/v1/order_earnings/{orderId}
   * Returns Seller Hub "Order earnings" when the app has order_earnings access.
   * Falls back to getTransactions-by-orderId net sum when unavailable.
   */
  async getOrderEarnings(orderId: string): Promise<{
    amount:     number | null
    currency:   string | null
    source:     "EBAY_ORDER_EARNINGS_API" | "COMPUTED_FROM_EBAY_TRANSACTIONS"
    notReady:   boolean
    rawError?:  string
  }> {
    const clean = orderId.trim()
    if (!clean) {
      return { amount: null, currency: null, source: "EBAY_ORDER_EARNINGS_API", notReady: true, rawError: "missing_order_id" }
    }
    if (this.simulationMode) {
      return { amount: null, currency: "USD", source: "EBAY_ORDER_EARNINGS_API", notReady: true }
    }

    const byId = await this.tryGetOrderEarningsById(clean)
    if (byId.ok) return byId.value
    if (byId.fatal) {
      return {
        amount: null,
        currency: null,
        source: "EBAY_ORDER_EARNINGS_API",
        notReady: false,
        rawError: byId.error,
      }
    }

    const fromTx = await this.tryComputeOrderEarningsFromTransactions(clean)
    return fromTx
  }

  private async tryGetOrderEarningsById(orderId: string): Promise<
    | { ok: true; value: { amount: number | null; currency: string | null; source: "EBAY_ORDER_EARNINGS_API"; notReady: boolean; rawError?: string } }
    | { ok: false; fatal: boolean; error: string }
  > {
    const url = `${this.financesBase}/sell/finances/v1/order_earnings/${encodeURIComponent(orderId)}`
    try {
      const res = await fetch(url, { headers: this.buildFinancesHeaders() })
      if (res.status === 404 || res.status === 204) {
        return { ok: true, value: { amount: null, currency: null, source: "EBAY_ORDER_EARNINGS_API", notReady: true } }
      }
      // 403/401/400 often mean scope or resource not enabled — try transactions fallback.
      if (res.status === 401 || res.status === 403 || res.status === 400 || res.status === 404) {
        const text = await res.text().catch(() => "")
        return { ok: false, fatal: false, error: `HTTP ${res.status}: ${text.slice(0, 300)}` }
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "")
        return { ok: false, fatal: true, error: `order_earnings HTTP ${res.status}: ${text.slice(0, 400)}` }
      }
      const data = (await res.json()) as Record<string, unknown>
      const money =
        asEbayMoney(data.orderEarnings)
        ?? asEbayMoney(data.netEarnings)
        ?? asEbayMoney(data.earnings)
        ?? asEbayMoney(data.orderEarning)
      if (!money) {
        return { ok: true, value: { amount: null, currency: null, source: "EBAY_ORDER_EARNINGS_API", notReady: true } }
      }
      return {
        ok: true,
        value: {
          amount: money.value,
          currency: money.currency,
          source: "EBAY_ORDER_EARNINGS_API",
          notReady: false,
        },
      }
    } catch (e) {
      return { ok: false, fatal: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  private async tryComputeOrderEarningsFromTransactions(orderId: string): Promise<{
    amount: number | null
    currency: string | null
    source: "COMPUTED_FROM_EBAY_TRANSACTIONS"
    notReady: boolean
    rawError?: string
  }> {
    // Filter syntax: orderId:{ORDER_ID}
    const filter = `orderId:{${orderId}}`
    const params = new URLSearchParams()
    params.set("filter", filter)
    params.set("limit", "200")
    const url = `${this.financesBase}/sell/finances/v1/transaction?${params.toString()}`

    try {
      const res = await fetch(url, { headers: this.buildFinancesHeaders() })
      if (res.status === 204) {
        return { amount: null, currency: null, source: "COMPUTED_FROM_EBAY_TRANSACTIONS", notReady: true }
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "")
        return {
          amount: null,
          currency: null,
          source: "COMPUTED_FROM_EBAY_TRANSACTIONS",
          notReady: false,
          rawError: `transaction HTTP ${res.status}: ${text.slice(0, 400)}`,
        }
      }
      const data = (await res.json()) as { transactions?: Array<Record<string, unknown>> }
      const txs = Array.isArray(data.transactions) ? data.transactions : []
      if (txs.length === 0) {
        return { amount: null, currency: null, source: "COMPUTED_FROM_EBAY_TRANSACTIONS", notReady: true }
      }

      let net = 0
      let currency: string | null = null
      let counted = 0
      for (const tx of txs) {
        const money = asEbayMoney(tx.amount)
        if (!money) continue
        const entry = String(tx.bookingEntry ?? "").toUpperCase()
        if (entry === "CREDIT") net += money.value
        else if (entry === "DEBIT") net -= money.value
        else continue
        currency = currency ?? money.currency
        counted++
      }
      if (counted === 0) {
        return { amount: null, currency: null, source: "COMPUTED_FROM_EBAY_TRANSACTIONS", notReady: true }
      }
      // Round to cents to avoid float noise; never invent from order total.
      const rounded = Math.round(net * 100) / 100
      return {
        amount: rounded,
        currency: currency ?? "USD",
        source: "COMPUTED_FROM_EBAY_TRANSACTIONS",
        notReady: false,
      }
    } catch (e) {
      return {
        amount: null,
        currency: null,
        source: "COMPUTED_FROM_EBAY_TRANSACTIONS",
        notReady: false,
        rawError: e instanceof Error ? e.message : String(e),
      }
    }
  }
}

function asEbayMoney(v: unknown): { value: number; currency: string } | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null
  const rec = v as Record<string, unknown>
  const raw = rec.value
  const n =
    typeof raw === "number" ? raw
    : typeof raw === "string" ? parseFloat(raw)
    : NaN
  if (!Number.isFinite(n)) return null
  const currency = typeof rec.currency === "string" && rec.currency.trim()
    ? rec.currency.trim().toUpperCase()
    : "USD"
  return { value: n, currency }
}

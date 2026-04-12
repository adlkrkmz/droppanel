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

const EBAY_PRODUCTION_BASE = "https://api.ebay.com"
const EBAY_SANDBOX_BASE    = "https://api.sandbox.ebay.com"
const EBAY_MEDIA_APIM_PROD = "https://apim.ebay.com"
const EBAY_MEDIA_APIM_SB   = "https://apim.sandbox.ebay.com"
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
}

export type EbayGetOffersPage = {
  offers: EbayOfferSummary[]
  total:  number
  href?:  string
  next?:  string
  limit:  number
  offset: number
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
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i")
  const m = re.exec(block)
  if (!m) return ""
  let inner = m[1].trim()
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/i.exec(inner)
  if (cdata) inner = cdata[1].trim()
  return inner.replace(/<[^>]+>/g, "").trim()
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
  }

  // ----------------------------------------------------------------
  // POST Commerce Media API - upload image (multipart/form-data)
  // ----------------------------------------------------------------

  async uploadImage(imageBuffer: Buffer, fileName: string): Promise<string> {
    if (this.simulationMode) {
      const safe = fileName.replace(/[^a-zA-Z0-9._-]/g, "_")
      console.log(`    [eBayClient][SIM] uploadImage fileName=${safe}`)
      return `https://i.ebayimg.com/images/g/sim-${safe}-${Date.now()}.jpg`
    }

    const url =
      `${this.mediaApimBase}/commerce/media/v1_beta/image/create_image_from_file`

    const form = new FormData()
    const blob = new Blob([new Uint8Array(imageBuffer)], { type: "image/png" })
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

  async getInventoryItem(sku: string): Promise<EbayInventoryItemResponse & { product?: { title?: string; imageUrls?: string[] } }> {
    if (this.simulationMode) {
      console.log(`    [eBayClient][SIM] getInventoryItem sku=${sku}`)
      return { sku, statusCode: 200, warnings: [] }
    }

    const url = `${this.baseUrl}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`
    const res = await fetch(url, { headers: this.buildJsonHeaders() })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`getInventoryItem failed: HTTP ${res.status} - ${text}`)
    }
    return res.json() as Promise<EbayInventoryItemResponse & { product?: { title?: string; imageUrls?: string[] } }>
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
      aspectConstraint?: { aspectRequired?: boolean }
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
            .slice(0, 20)
          return { name, required: true as const, values }
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
      ? `${this.baseUrl}/sell/inventory/v1/offer?limit=${limit}&offset=${offset}&sku=${encodeURIComponent(sku)}`
      : `${this.baseUrl}/sell/inventory/v1/offer?limit=${limit}&offset=${offset}`
    const res = await fetch(url, { headers: this.buildJsonHeaders() })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`getOffers failed: HTTP ${res.status} - ${text}`)
    }
    return res.json() as Promise<EbayGetOffersPage>
  }

  /**
   * GET /sell/inventory/v1/offer?sku={sku}
   * İlk dönen offer kaydının offerId değeri (yoksa null).
   */
  async getOfferId(sku: string): Promise<string | null> {
    if (this.simulationMode) {
      console.log(`    [eBayClient][SIM] getOfferId sku=${sku}`)
      return null
    }

    const clean = sku?.trim() ?? ""
    if (!clean) return null

    const url = `${this.baseUrl}/sell/inventory/v1/offer?sku=${encodeURIComponent(clean)}`
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
      throw new Error(`getOfferId failed: HTTP ${res.status} - ${text}`)
    }

    const page = (await res.json()) as EbayGetOffersPage
    const id   = page.offers?.[0]?.offerId?.trim()
    return id && id.length > 0 ? id : null
  }

  /**
   * GET /sell/inventory/v1/offer/{offerId}
   * Tek offer kaydı — fiyat / stok; monitor için EbayActiveListingPriceRow.
   */
  async getOfferById(offerId: string): Promise<EbayActiveListingPriceRow | null> {
    if (this.simulationMode) {
      console.log(`    [eBayClient][SIM] getOfferById offerId=${offerId}`)
      return null
    }

    const clean = offerId?.trim()
    if (!clean) return null

    const url = `${this.baseUrl}/sell/inventory/v1/offer/${encodeURIComponent(clean)}`
    const res = await fetch(url, { headers: this.buildJsonHeaders() })

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
  async updateOfferQuantity(offerId: string, quantity: number): Promise<void> {
    if (this.simulationMode) {
      console.log(`    [eBayClient][SIM] updateOfferQuantity offerId=${offerId} qty=${quantity}`)
      return
    }

    const url = `${this.baseUrl}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`
    const res = await fetch(url, {
      method:  "PUT",
      headers: this.buildJsonHeaders(),
      body:    JSON.stringify({ availableQuantity: quantity }),
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
   * importExistingEbayListings için toplu çekim:
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
      const block   = m[1]
      const itemId  = xmlTextContent(block, "ItemID")
      let sku       = xmlTextContent(block, "SKU")
      if (!sku) sku = xmlTextContent(block, "CustomLabel")
      const skuFinal = (sku || itemId || "").trim()
      if (!skuFinal) continue

      const curFull = block.match(
        /<CurrentPrice\s+[^>]*currencyID="([^"]+)"[^>]*>([\d.]+)<\/CurrentPrice>/i
      )
      const curSimple = block.match(/<CurrentPrice[^>]*>([\d.]+)<\/CurrentPrice>/i)
      const currency  = curFull?.[1] ?? "USD"
      const priceRaw  = curFull?.[2] ?? curSimple?.[1] ?? "0"
      const price     = parseFloat(priceRaw)

      const qAvail = xmlTextContent(block, "QuantityAvailable")
      const qTot   = xmlTextContent(block, "Quantity")
      const qStr   = qAvail || qTot
      const qty    = qStr ? (parseInt(qStr, 10) || parseFloat(qStr) || 0) : 0

      rows.push({
        sku:               skuFinal,
        price:             Number.isFinite(price) ? price : 0,
        offerId:           "",
        listingId:         itemId.trim() || null,
        availableQuantity: qty,
        currency,
        offerStatus:       null,
      })
    }

    return rows
  }

  private async fetchGetMyeBaySellingAllPages(): Promise<EbayActiveListingPriceRow[]> {
    const tradingUrl = this.isSandbox ? EBAY_TRADING_DLL_SB : EBAY_TRADING_DLL_PROD
    const collected: EbayActiveListingPriceRow[] = []
    const siteId = (process.env.EBAY_SITE_ID ?? "0").trim()

    for (let pageNum = 1; pageNum <= 500; pageNum++) {
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
        throw new Error(`Trading GetMyeBaySelling HTTP ${res.status}: ${t.slice(0, 400)}`)
      }

      const xml = await res.text()
      if (!/<Ack>(Success|Warning)<\/Ack>/i.test(xml)) {
        const short =
          xml.match(/<ShortMessage>([^<]*)<\/ShortMessage>/i)?.[1]?.trim() ??
          xml.match(/<LongMessage>([^<]*)<\/LongMessage>/i)?.[1]?.trim() ??
          xml.slice(0, 300)
        throw new Error(`GetMyeBaySelling failed: ${short}`)
      }

      const pageRows = this.parseTradingActiveItems(xml)
      const totalPages = parseInt(
        xml.match(/<TotalNumberOfPages>(\d+)<\/TotalNumberOfPages>/i)?.[1] || "1",
        10
      )
      const totalEntries =
        xml.match(/<TotalNumberOfEntries>(\d+)<\/TotalNumberOfEntries>/i)?.[1]

      console.log(`[Trading] page=${pageNum} rows=${pageRows.length}`)
      console.log(`[Trading] totalPages=${totalPages} totalEntries=${totalEntries}`)

      if (pageRows.length === 0 && pageNum > 1) break

      collected.push(...pageRows)

      if (pageNum >= totalPages) break
    }

    console.log(`[getAllOffersForImportBulk] Trading API rows=${collected.length}`)
    return collected
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
      const simulatedListingId = `SIM-LISTING-${offerId}-${Date.now()}`
      console.log(`    [eBayClient][SIM] publishOffer offerId=${offerId} listingId=${simulatedListingId}`)
      return { listingId: simulatedListingId, warnings: [] }
    }

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
      console.log(`    [eBayClient][SIM] withdrawOffer offerId=${offerId}`)
      return
    }

    const url = `${this.baseUrl}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/withdraw`
    const res = await fetch(url, { method: "POST", headers: this.buildJsonHeaders() })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`withdrawOffer failed: HTTP ${res.status} - ${text}`)
    }
  }

  // ----------------------------------------------------------------
  // PATCH inventory_item - quantity update
  // ----------------------------------------------------------------

  async updateQuantity(sku: string, quantity: number): Promise<void> {
    if (this.simulationMode) {
      console.log(`    [eBayClient][SIM] updateQuantity sku=${sku} qty=${quantity}`)
      return
    }

    const url  = `${this.baseUrl}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`
    const body = { availability: { shipToLocationAvailability: { quantity } } }
    const res  = await fetch(url, {
      method:  "PUT",
      headers: this.buildJsonHeaders(),
      body:    JSON.stringify(body),
    })

    const text = await res.text()
    console.log(`[eBayClient][updateQuantity] eBay response status=${res.status} body=${text}`)

    if (res.status !== 200 && res.status !== 204) {
      throw new Error(`updateQuantity failed: HTTP ${res.status} - ${text}`)
    }
  }

  // ----------------------------------------------------------------
  // TOKEN VALIDITY CHECK
  // ----------------------------------------------------------------

  getToken(): string { return this.oauthToken }

  isSimulation(): boolean { return this.simulationMode }

  // ----------------------------------------------------------------
  // HEADERS
  // ----------------------------------------------------------------

  private buildJsonHeaders(): Record<string, string> {
    return {
      Authorization:    `Bearer ${this.oauthToken}`,
      "Content-Type":   "application/json",
      Accept:           "application/json",
      "Accept-Language":  "en-US",
      "Content-Language": "en-US",
    }
  }
}

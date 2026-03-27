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
// Listing:  GET /sell/inventory/v1/listing (fiyat listesi — getActiveListingPrices)
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

const EBAY_PRODUCTION_BASE = "https://api.ebay.com"
const EBAY_SANDBOX_BASE    = "https://api.sandbox.ebay.com"
const EBAY_MEDIA_APIM_PROD = "https://apim.ebay.com"
const EBAY_MEDIA_APIM_SB   = "https://apim.sandbox.ebay.com"

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

function extractListingArrayFromPage(page: Record<string, unknown>): unknown[] {
  for (const key of ["listings", "listingSummaries", "items"]) {
    const v = page[key]
    if (Array.isArray(v)) return v
  }
  return []
}

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

function pickSkuFromListingRecord(r: Record<string, unknown>): string {
  if (typeof r.sku === "string" && r.sku.trim()) return r.sku.trim()
  const inv = r.inventoryItem
  if (inv && typeof inv === "object") {
    const s = (inv as Record<string, unknown>).sku
    if (typeof s === "string" && s.trim()) return s.trim()
  }
  return ""
}

function pickListingIdFromRecord(r: Record<string, unknown>): string {
  if (typeof r.listingId === "string" && r.listingId.trim()) return r.listingId.trim()
  if (r.listing && typeof r.listing === "object") {
    const lid = (r.listing as Record<string, unknown>).listingId
    if (typeof lid === "string" && lid.trim()) return lid.trim()
  }
  return ""
}

function parseListingEntryToPriceRow(entry: unknown): EbayActiveListingPriceRow | null {
  if (!entry || typeof entry !== "object") return null
  const r = entry as Record<string, unknown>
  const listingId = pickListingIdFromRecord(r)
  const sku = pickSkuFromListingRecord(r)
  if (!listingId || !sku) return null

  const { value: price, currency } = extractPriceAndCurrency(r)
  const qty =
    typeof r.quantity === "number" ? r.quantity
    : typeof r.availableQuantity === "number" ? r.availableQuantity
    : 0
  const offerId = typeof r.offerId === "string" ? r.offerId : ""

  return {
    sku,
    price:             Number.isFinite(price) ? price : 0,
    offerId,
    listingId,
    availableQuantity: qty,
    currency,
  }
}

function bumpListingPageOffset(url: string, limit: number, baseUrl: string): string {
  const u = new URL(url, baseUrl)
  const cur = Number.parseInt(u.searchParams.get("offset") ?? "0", 10)
  u.searchParams.set("limit", String(limit))
  u.searchParams.set("offset", String(Number.isFinite(cur) ? cur + limit : limit))
  return u.href
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

  constructor(config: EbayClientConfig) {
    this.oauthToken     = config.oauthToken
    this.simulationMode = config.simulationMode ?? false
    const sandbox       = config.sandbox ?? false
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
   * Aktif listeleme fiyatları: önce
   * GET /sell/inventory/v1/listing?limit=200&offset=… (SKU query yok; `next` veya offset ile sayfalar).
   * Başarısız olursa getInventoryItems ile tüm envanter; SKU + varsa fiyat (pricingSummary / price).
   */
  async getActiveListingPrices(): Promise<EbayActiveListingPriceRow[]> {
    if (this.simulationMode) {
      console.log(`    [eBayClient][SIM] getActiveListingPrices -> []`)
      return []
    }

    try {
      return await this.fetchPublishedPricesViaListingResource()
    } catch (e) {
      console.warn(
        "[getActiveListingPrices] /listing failed, fallback getInventoryItems:",
        e instanceof Error ? e.message : String(e)
      )
      return await this.fetchPublishedPricesViaInventoryItems()
    }
  }

  private async fetchPublishedPricesViaListingResource(): Promise<EbayActiveListingPriceRow[]> {
    const limit = 200
    const collected: EbayActiveListingPriceRow[] = []
    let nextUrl: string | undefined =
      `${this.baseUrl}/sell/inventory/v1/listing?limit=${limit}&offset=0`
    let pageGuard = 0

    while (nextUrl && pageGuard < 500) {
      pageGuard++
      const res = await fetch(nextUrl, { headers: this.buildJsonHeaders() })
      if (!res.ok) {
        const text = await res.text()
        console.log("[getActiveListingPrices] failed URL:", nextUrl)
        console.log("[getActiveListingPrices] response text:", text)
        throw new Error(`getActiveListingPrices listing failed: HTTP ${res.status} - ${text}`)
      }

      const page = (await res.json()) as Record<string, unknown>
      const rows = extractListingArrayFromPage(page)
      for (const row of rows) {
        const parsed = parseListingEntryToPriceRow(row)
        if (parsed) collected.push(parsed)
      }

      if (typeof page.next === "string" && page.next.trim().length > 0) {
        const raw = page.next.startsWith("http") ? page.next : `${this.baseUrl}${page.next}`
        nextUrl = raw
        continue
      }

      if (rows.length >= limit) {
        nextUrl = bumpListingPageOffset(nextUrl, limit, this.baseUrl)
        continue
      }

      nextUrl = undefined
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

    if (res.status !== 200 && res.status !== 204) {
      const text = await res.text()
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

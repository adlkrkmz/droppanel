import { ebayBidPercentage, sanitizeMarketingError } from "./ebayPromotedTypes"

function nestedMarketingErrors(json: Record<string, unknown> | null): { errorId: number | null; raw: string } {
  if (!json) return { errorId: null, raw: "" }
  const responses = Array.isArray(json.responses) ? json.responses as Array<Record<string, unknown>> : []
  const inner = responses.flatMap(r => Array.isArray(r.errors) ? r.errors as Array<Record<string, unknown>> : [])
  const top = Array.isArray(json.errors) ? json.errors as Array<Record<string, unknown>> : []
  const first = inner[0] ?? top[0]
  if (!first) {
    const statusCode = Number(responses[0]?.statusCode)
    if (Number.isFinite(statusCode) && statusCode >= 400) {
      return { errorId: statusCode, raw: JSON.stringify(responses[0]).slice(0, 400) }
    }
    return { errorId: null, raw: "" }
  }
  const errorId = Number(first.errorId)
  const message = String(first.message ?? first.longMessage ?? "").slice(0, 220)
  return {
    errorId: Number.isFinite(errorId) ? errorId : null,
    raw: message || JSON.stringify(first).slice(0, 400),
  }
}

const PROD = "https://api.ebay.com"
const SANDBOX = "https://api.sandbox.ebay.com"

export type EbayMarketingClientConfig = {
  oauthToken: string
  sandbox: boolean
  simulationMode: boolean
}

export type EbayMarketingCampaign = {
  campaignId: string
  campaignName: string
  campaignStatus: string
  fundingModel: string | null
  marketplaceId: string | null
}

export type EbayMarketingAd = {
  adId: string
  listingId: string
  campaignId: string | null
  bidPercentage: number | null
  adStatus: string | null
}

type EbayHttpResult = {
  ok: boolean
  status: number
  json: Record<string, unknown> | null
  text: string
  location: string | null
}

function numRate(raw: unknown): number | null {
  if (raw == null) return null
  const n = typeof raw === "number" ? raw : Number(String(raw).trim())
  return Number.isFinite(n) ? n : null
}

export class EbayMarketingApiClient {
  private readonly token: string
  private readonly base: string
  private readonly simulation: boolean

  constructor(cfg: EbayMarketingClientConfig) {
    this.token = cfg.oauthToken
    this.base = cfg.sandbox ? SANDBOX : PROD
    this.simulation = cfg.simulationMode
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "Content-Language": "en-US",
      "Accept-Language": "en-US",
    }
  }

  private async request(method: string, path: string, body?: unknown): Promise<EbayHttpResult> {
    const url = `${this.base}${path}`
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 20_000)
    try {
      const res = await fetch(url, {
        method,
        headers: this.headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ac.signal,
      })
      const text = await res.text().catch(() => "")
      let json: Record<string, unknown> | null = null
      if (text) {
        try { json = JSON.parse(text) as Record<string, unknown> } catch { json = null }
      }
      return {
        ok: res.ok,
        status: res.status,
        json,
        text,
        location: res.headers.get("location") || res.headers.get("Location"),
      }
    } catch (e) {
      const aborted = e instanceof Error && e.name === "AbortError"
      return {
        ok: false,
        status: 0,
        json: null,
        text: aborted ? "MARKETING_TIMEOUT" : (e instanceof Error ? e.message : String(e)),
        location: null,
      }
    } finally {
      clearTimeout(timer)
    }
  }

  throwIfFailed(result: EbayHttpResult, fallback: string): void {
    if (result.ok) return
    const nested = nestedMarketingErrors(result.json)
    const raw = nested.raw || (result.json ? JSON.stringify(result.json).slice(0, 400) : result.text.slice(0, 400))
    const safe = sanitizeMarketingError(raw || fallback, nested.errorId)
    const err = new Error(safe.message) as Error & { code?: string; retryable?: boolean }
    err.code = result.text === "MARKETING_TIMEOUT" ? "MARKETING_TIMEOUT" : safe.code
    err.retryable = safe.retryable && (result.status === 0 || result.status >= 500 || err.code === "MARKETING_TIMEOUT" || safe.retryable)
    if (!safe.retryable) err.retryable = false
    throw err
  }

  campaignIdFromCreate(result: EbayHttpResult): string {
    const fromJson = String(result.json?.campaignId ?? "").trim()
    if (fromJson) return fromJson
    const loc = result.location || ""
    const fromLoc = loc.replace(/\/$/, "").split("/").pop() || ""
    return fromLoc.trim()
  }

  async createGeneralCpsCampaign(input: {
    name: string
    marketplaceId: string
  }): Promise<EbayMarketingCampaign> {
    if (this.simulation) {
      return {
        campaignId: `SIM_CAMP_${Date.now()}`,
        campaignName: input.name,
        campaignStatus: "RUNNING",
        fundingModel: "COST_PER_SALE",
        marketplaceId: input.marketplaceId,
      }
    }
    const start = new Date(Date.now() + 60_000).toISOString()
    const result = await this.request("POST", "/sell/marketing/v1/ad_campaign", {
      campaignName: input.name,
      startDate: start,
      marketplaceId: input.marketplaceId,
      fundingStrategy: { fundingModel: "COST_PER_SALE" },
    })
    this.throwIfFailed(result, "createCampaign failed")
    const id = this.campaignIdFromCreate(result)
    if (!id) throw new Error("createCampaign missing campaignId")
    return {
      campaignId: id,
      campaignName: input.name,
      campaignStatus: String(result.json?.campaignStatus ?? "RUNNING"),
      fundingModel: "COST_PER_SALE",
      marketplaceId: input.marketplaceId,
    }
  }

  async getCampaign(campaignId: string): Promise<EbayMarketingCampaign | null> {
    if (this.simulation) {
      return {
        campaignId,
        campaignName: "SIM",
        campaignStatus: "RUNNING",
        fundingModel: "COST_PER_SALE",
        marketplaceId: "EBAY_US",
      }
    }
    const result = await this.request("GET", `/sell/marketing/v1/ad_campaign/${encodeURIComponent(campaignId)}`)
    if (result.status === 404) return null
    this.throwIfFailed(result, "getCampaign failed")
    const j = result.json ?? {}
    const funding = j.fundingStrategy as { fundingModel?: string } | undefined
    return {
      campaignId: String(j.campaignId ?? campaignId),
      campaignName: String(j.campaignName ?? ""),
      campaignStatus: String(j.campaignStatus ?? ""),
      fundingModel: funding?.fundingModel ?? null,
      marketplaceId: typeof j.marketplaceId === "string" ? j.marketplaceId : null,
    }
  }

  async findCampaignByName(name: string): Promise<EbayMarketingCampaign | null> {
    if (this.simulation) return null
    const result = await this.request(
      "GET",
      `/sell/marketing/v1/ad_campaign?campaign_name=${encodeURIComponent(name)}&limit=5`
    )
    if (result.status === 404 || !result.ok) return null
    const campaigns = Array.isArray(result.json?.campaigns)
      ? result.json!.campaigns as Array<Record<string, unknown>>
      : []
    const wanted = name.trim().toLowerCase()
    const row = campaigns.find(c => String(c.campaignName ?? "").trim().toLowerCase() === wanted) ?? null
    if (!row) return null
    const funding = row.fundingStrategy as { fundingModel?: string } | undefined
    return {
      campaignId: String(row.campaignId ?? ""),
      campaignName: String(row.campaignName ?? name),
      campaignStatus: String(row.campaignStatus ?? ""),
      fundingModel: funding?.fundingModel ?? null,
      marketplaceId: typeof row.marketplaceId === "string" ? row.marketplaceId : null,
    }
  }

  async findCampaignByListingId(listingId: string): Promise<{ campaignId: string; adId: string | null } | null> {
    if (this.simulation) return null
    const result = await this.request(
      "GET",
      `/sell/marketing/v1/ad_campaign/find_campaign_by_ad_reference?listing_id=${encodeURIComponent(listingId)}`
    )
    if (result.status === 404 || !result.ok) return null
    const campaigns = Array.isArray(result.json?.campaigns)
      ? result.json!.campaigns as Array<{ campaignId?: string; ads?: Array<{ adId?: string; listingId?: string }> }>
      : (result.json?.campaignId ? [result.json as { campaignId?: string }] : [])
    const first = campaigns[0]
    const campaignId = String(first?.campaignId ?? "").trim()
    if (!campaignId) return null
    const ads = (first as { ads?: Array<{ adId?: string; listingId?: string }> }).ads
    const ad = ads?.find(a => String(a.listingId ?? "") === listingId) ?? ads?.[0]
    return { campaignId, adId: ad?.adId ? String(ad.adId) : null }
  }

  async createAdByListingId(input: {
    campaignId: string
    listingId: string
    bidPercentage: number
  }): Promise<EbayMarketingAd> {
    if (this.simulation) {
      return {
        adId: `SIM_AD_${input.listingId}`,
        listingId: input.listingId,
        campaignId: input.campaignId,
        bidPercentage: input.bidPercentage,
        adStatus: "ACTIVE",
      }
    }
    const bid = ebayBidPercentage(input.bidPercentage)
    const result = await this.request(
      "POST",
      `/sell/marketing/v1/ad_campaign/${encodeURIComponent(input.campaignId)}/bulk_create_ads_by_listing_id`,
      { requests: [{ listingId: input.listingId, bidPercentage: bid }] }
    )
    const nested = nestedMarketingErrors(result.json)
    if (!result.ok || nested.errorId) {
      const safe = sanitizeMarketingError(nested.raw || "createAd failed", nested.errorId)
      const err = new Error(safe.message) as Error & { code?: string; retryable?: boolean }
      err.code = safe.code
      err.retryable = safe.retryable
      throw err
    }
    const responses = Array.isArray(result.json?.responses) ? result.json!.responses as Array<Record<string, unknown>> : []
    const row = responses[0] ?? result.json ?? {}
    const adId = String(row.adId ?? row.href ?? "").replace(/.*\//, "").trim()
    if (!adId) {
      const read = await this.getAdByListingId(input.campaignId, input.listingId)
      if (read) return read
      throw new Error("createAd missing adId")
    }
    return {
      adId,
      listingId: input.listingId,
      campaignId: input.campaignId,
      bidPercentage: input.bidPercentage,
      adStatus: String(row.adStatus ?? "ACTIVE"),
    }
  }

  async getAdByListingId(campaignId: string, listingId: string): Promise<EbayMarketingAd | null> {
    if (this.simulation) return null
    let result = await this.request(
      "GET",
      `/sell/marketing/v1/ad_campaign/${encodeURIComponent(campaignId)}/ad?listing_ids=${encodeURIComponent(listingId)}`
    )
    if (result.status === 400) {
      result = await this.request(
        "GET",
        `/sell/marketing/v1/ad_campaign/${encodeURIComponent(campaignId)}/ad?listing_id=${encodeURIComponent(listingId)}`
      )
    }
    if (result.status === 404 || !result.ok) return null
    const ads = Array.isArray(result.json?.ads) ? result.json!.ads as Array<Record<string, unknown>> : []
    const row = ads.find(a => String(a.listingId ?? "") === listingId) ?? ads[0]
    if (!row) return null
    return {
      adId: String(row.adId ?? ""),
      listingId: String(row.listingId ?? listingId),
      campaignId,
      bidPercentage: numRate(row.bidPercentage),
      adStatus: typeof row.adStatus === "string" ? row.adStatus : null,
    }
  }

  async updateAdBid(input: {
    campaignId: string
    listingId: string
    bidPercentage: number
  }): Promise<void> {
    if (this.simulation) return
    const bid = ebayBidPercentage(input.bidPercentage)
    const result = await this.request(
      "POST",
      `/sell/marketing/v1/ad_campaign/${encodeURIComponent(input.campaignId)}/bulk_update_ads_bid_by_listing_id`,
      { requests: [{ listingId: input.listingId, bidPercentage: bid }] }
    )
    this.throwIfFailed(result, "updateBid failed")
  }

  async deleteAd(campaignId: string, adId: string): Promise<void> {
    if (this.simulation) return
    const result = await this.request(
      "DELETE",
      `/sell/marketing/v1/ad_campaign/${encodeURIComponent(campaignId)}/ad/${encodeURIComponent(adId)}`
    )
    if (result.status === 404) return
    this.throwIfFailed(result, "deleteAd failed")
  }
}

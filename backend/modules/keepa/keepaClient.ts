import type { KeepaApiResponse } from "./keepaTypes"

type KeepaClientConfig = {
  apiKey:        string
  domain:        number
  offersEnabled: boolean
  timeoutMs:     number
}

function keepaBaseUrl(): string {
  return "https://api.keepa.com"
}

function buildProductUrl(cfg: KeepaClientConfig, asins: string[]): string {
  const url = new URL("/product", keepaBaseUrl())
  url.searchParams.set("key", cfg.apiKey)
  url.searchParams.set("domain", String(cfg.domain))
  url.searchParams.set("asin", asins.join(","))
  url.searchParams.set("stats", "1")
  // Offers are token-expensive; keep disabled by default in phase 1.
  if (cfg.offersEnabled) {
    url.searchParams.set("offers", "20")
  }
  return url.toString()
}

function sanitizeKeepaError(message: string): string {
  // Never include API key even if it somehow appears.
  const key = process.env.KEEPA_API_KEY?.trim()
  if (key && message.includes(key)) return message.split(key).join("[REDACTED]")
  return message
}

export class KeepaClient {
  private cfg: KeepaClientConfig

  constructor(cfg: KeepaClientConfig) {
    this.cfg = cfg
  }

  async fetchProducts(asins: string[]): Promise<KeepaApiResponse> {
    if ((process.env.KEEPA_ENABLED ?? "false").trim().toLowerCase() !== "true") {
      throw new Error("Keepa is disabled")
    }
    const url = buildProductUrl(this.cfg, asins)
    const controller = new AbortController()
    const t = setTimeout(() => controller.abort(), this.cfg.timeoutMs)
    try {
      const res = await fetch(url, { method: "GET", signal: controller.signal })
      const text = await res.text().catch(() => "")
      if (!res.ok) {
        const msg = text.slice(0, 300) || `HTTP ${res.status}`
        throw new Error(`Keepa HTTP error: ${msg}`)
      }
      const json = JSON.parse(text) as KeepaApiResponse
      return json
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      throw new Error(sanitizeKeepaError(msg))
    } finally {
      clearTimeout(t)
    }
  }
}

export function loadKeepaConfig(): {
  enabled: boolean
  dryRun: boolean
  domain: number
  offersEnabled: boolean
  apiKey: string | null
} {
  const enabled = (process.env.KEEPA_ENABLED ?? "false").toLowerCase() === "true"
  const dryRun  = (process.env.KEEPA_DRY_RUN ?? "false").toLowerCase() === "true"
  const offersEnabled = (process.env.KEEPA_OFFERS_ENABLED ?? "false").toLowerCase() === "true"
  const domain = parseInt(process.env.KEEPA_DOMAIN ?? "1", 10)
  const apiKey = process.env.KEEPA_API_KEY?.trim() || null
  return {
    enabled,
    dryRun,
    domain: Number.isFinite(domain) ? domain : 1,
    offersEnabled,
    apiKey,
  }
}


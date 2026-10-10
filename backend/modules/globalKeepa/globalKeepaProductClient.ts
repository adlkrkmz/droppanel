import type { KeepaApiResponse } from "../keepa/keepaTypes"

export type GlobalKeepaHttpFailureCode =
  | "HTTP_429"
  | "HTTP_401"
  | "HTTP_403"
  | "HTTP_5XX"
  | "TIMEOUT"
  | "NETWORK"
  | "MALFORMED_JSON"
  | "HTTP_ERROR"

export type GlobalKeepaProductFetchResult =
  | { ok: true; status: number; body: KeepaApiResponse; durationMs: number }
  | {
      ok: false
      status: number | null
      code: GlobalKeepaHttpFailureCode
      body: KeepaApiResponse | null
      message: string
      durationMs: number
    }

function keepaBaseUrl(): string {
  return "https://api.keepa.com"
}

function sanitizeKeepaError(message: unknown): string {
  const text =
    typeof message === "string"
      ? message
      : message == null
        ? ""
        : JSON.stringify(message)
  const key = process.env.KEEPA_API_KEY?.trim()
  if (key && text.includes(key)) return text.split(key).join("[REDACTED]")
  return text
}

/** 1-token /product request. history=0; no offer, buybox, stock, or update params. Does not use KeepaClient. */
export function buildGlobalKeepaProductUrl(input: {
  apiKey: string
  domain: number
  asins: string[]
}): string {
  const asins = input.asins.map(a => a.trim().toUpperCase()).filter(a => /^[A-Z0-9]{10}$/.test(a))
  const url = new URL("/product", keepaBaseUrl())
  url.searchParams.set("key", input.apiKey)
  url.searchParams.set("domain", String(input.domain))
  url.searchParams.set("asin", asins.join(","))
  url.searchParams.set("stats", "1")
  url.searchParams.set("history", "0")
  return url.toString()
}

function failureCode(status: number | null, err: unknown): GlobalKeepaHttpFailureCode {
  const msg = err instanceof Error ? err.message : String(err)
  if (msg.toLowerCase().includes("abort") || msg.toLowerCase().includes("timeout")) return "TIMEOUT"
  if (status === 429) return "HTTP_429"
  if (status === 401) return "HTTP_401"
  if (status === 403) return "HTTP_403"
  if (status != null && status >= 500) return "HTTP_5XX"
  if (status != null && status >= 400) return "HTTP_ERROR"
  return "NETWORK"
}

export async function fetchGlobalKeepaProducts(input: {
  apiKey: string
  domain: number
  asins: string[]
  timeoutMs: number
}): Promise<GlobalKeepaProductFetchResult> {
  if ((process.env.KEEPA_ENABLED ?? "false").trim().toLowerCase() !== "true") {
    return {
      ok: false,
      status: null,
      code: "HTTP_ERROR",
      body: null,
      message: "KEEPA_DISABLED",
      durationMs: 0,
    }
  }
  if (input.asins.length === 0) {
    return { ok: true, status: 200, body: { products: [], tokensLeft: undefined }, durationMs: 0 }
  }
  if (input.asins.length > 100) {
    return {
      ok: false,
      status: null,
      code: "HTTP_ERROR",
      body: null,
      message: "Keepa product batch exceeds 100 ASINs",
      durationMs: 0,
    }
  }
  const url = buildGlobalKeepaProductUrl(input)
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), Math.max(1000, input.timeoutMs))
  const started = Date.now()
  try {
    const res = await fetch(url, { method: "GET", signal: controller.signal })
    const text = await res.text().catch(() => "")
    const durationMs = Date.now() - started
    let parsed: KeepaApiResponse | null = null
    try {
      parsed = text ? (JSON.parse(text) as KeepaApiResponse) : null
    } catch {
      if (!res.ok) {
        return {
          ok: false,
          status: res.status,
          code: failureCode(res.status, null),
          body: null,
          message: sanitizeKeepaError(text.slice(0, 300) || `HTTP ${res.status}`),
          durationMs,
        }
      }
      return {
        ok: false,
        status: res.status,
        code: "MALFORMED_JSON",
        body: null,
        message: "Keepa response was not JSON",
        durationMs,
      }
    }
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        code: failureCode(res.status, null),
        body: parsed,
        message: sanitizeKeepaError(parsed?.error || text.slice(0, 300) || `HTTP ${res.status}`),
        durationMs,
      }
    }
    if (!parsed) {
      return { ok: false, status: res.status, code: "MALFORMED_JSON", body: null, message: "Empty Keepa JSON", durationMs }
    }
    return { ok: true, status: res.status, body: parsed, durationMs }
  } catch (e) {
    const msg = sanitizeKeepaError(e instanceof Error ? e.message : String(e))
    return { ok: false, status: null, code: failureCode(null, e), body: null, message: msg, durationMs: Date.now() - started }
  } finally {
    clearTimeout(t)
  }
}

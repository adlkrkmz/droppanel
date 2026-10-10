import { recordTokensFromKeepaResponse } from "../stockGuard/keepaTokenGuardService"
import { KeepaClient, loadKeepaConfig } from "./keepaClient"
import {
  formatPriceCandidatesLog,
  selectKeepaActiveSourcePrice,
} from "./keepaPriceSelector"
import type { KeepaSelectedPriceSource } from "./keepaPriceTypes"
import { isTrustedCurrentKeepaPriceSource } from "./keepaPriceTypes"
import type { KeepaPriceSelectionWarning } from "./keepaTypes"
import type {
  KeepaApiProduct,
  KeepaApiResponse,
  KeepaCheckAsinResponse,
  KeepaRawSignals,
  KeepaSourceStatus,
} from "./keepaTypes"

const ASIN_REGEX = /^[A-Z0-9]{10}$/

function buildDecision(input: {
  asin: string
  product: KeepaApiProduct | null
  keepaResp: KeepaApiResponse | null
  offersEnabled: boolean
  errorMessage?: string
}): KeepaCheckAsinResponse {
  const asin = input.asin.trim().toUpperCase()
  const emptyCandidates = {
    primeExclusiveCurrent: null,
    buyBoxCurrent: null,
    amazonCurrent: null,
    newCurrent: null,
    newFbaCurrent: null,
    listPrice: null,
    offerCurrent: null,
  }

  const fail = (
    sourceStatus: KeepaSourceStatus,
    reason: string,
    selectedPriceSource: KeepaSelectedPriceSource = "NONE",
    priceSelectionWarnings: KeepaPriceSelectionWarning[] = []
  ): KeepaCheckAsinResponse => ({
    ok: true,
    asin,
    sourceStatus,
    reason,
    price: null,
    primeOrFbaSignal: false,
    rawSignals: {
      hasPrice: false,
      hasNewPrice: false,
      hasBuyBox: false,
      hasOfferSignal: false,
      hasPrimeExclusivePrice: false,
    },
    selectedPriceSource,
    priceCandidates: emptyCandidates,
    priceSelectionWarnings,
  })

  if (!ASIN_REGEX.test(asin)) {
    return fail("CHECK_FAILED", "invalid asin")
  }

  if (input.errorMessage) {
    return fail("CHECK_FAILED", input.errorMessage)
  }

  const p = input.product
  if (!p) {
    return fail("REMOVED", "No product data returned from Keepa")
  }

  const selection = selectKeepaActiveSourcePrice(p)
  const c = selection.priceCandidates
  const warnings = selection.priceSelectionWarnings

  const hasNewPrice = c.newCurrent != null
  const hasBuyBox = c.buyBoxCurrent != null
  const hasPrimeExclusivePrice = c.primeExclusiveCurrent != null
  const trusted =
    selection.price != null &&
    isTrustedCurrentKeepaPriceSource(selection.selectedPriceSource)

  const rawSignals: KeepaRawSignals = {
    hasPrice: trusted,
    hasNewPrice,
    hasBuyBox,
    hasOfferSignal: false,
    hasPrimeExclusivePrice,
  }

  if (trusted) {
    return {
      ok: true,
      asin,
      sourceStatus: "AMAZON_OK",
      reason: `Active price found: ${selection.selectedPriceSource}`,
      price: selection.price,
      primeOrFbaSignal: hasBuyBox || hasPrimeExclusivePrice,
      rawSignals,
      selectedPriceSource: selection.selectedPriceSource,
      priceCandidates: c,
      priceSelectionWarnings: warnings,
    }
  }

  return {
    ok: true,
    asin,
    sourceStatus: "PRICE_UNCERTAIN",
    reason: "No trusted current Amazon price found",
    price: null,
    primeOrFbaSignal: hasBuyBox || hasPrimeExclusivePrice,
    rawSignals,
    selectedPriceSource: "PRICE_UNCERTAIN",
    priceCandidates: c,
    priceSelectionWarnings: warnings,
  }
}

function normalizeAsins(asins: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of asins) {
    const a = String(raw ?? "").trim().toUpperCase()
    if (!a) continue
    if (seen.has(a)) continue
    seen.add(a)
    out.push(a)
  }
  return out
}

function classifyKeepaError(msg: string): string {
  const m = msg.toLowerCase()
  if (m.includes("abort") || m.includes("timeout")) return "Keepa timeout"
  if (m.includes("rate") || m.includes("tokens") || m.includes("token")) {
    return "Keepa rate limit or token shortage"
  }
  return msg
}

export async function keepaCheckAsins(
  asinsInput: string[],
  workspaceId?: string
): Promise<KeepaCheckAsinResponse[]> {
  const cfg = loadKeepaConfig()
  const asins = normalizeAsins(asinsInput)

  if (asins.length === 0) return []

  if (!cfg.enabled) {
    return asins.map(asin =>
      buildDecision({
        asin,
        product: null,
        keepaResp: null,
        offersEnabled: cfg.offersEnabled,
        errorMessage: "Keepa is disabled",
      })
    )
  }

  if (!cfg.apiKey) {
    return asins.map(asin =>
      buildDecision({
        asin,
        product: null,
        keepaResp: null,
        offersEnabled: cfg.offersEnabled,
        errorMessage: "Keepa API key missing",
      })
    )
  }

  const client = new KeepaClient({
    apiKey: cfg.apiKey,
    domain: cfg.domain,
    offersEnabled: cfg.offersEnabled,
    timeoutMs: 12_000,
  })

  let resp: KeepaApiResponse
  try {
    resp = await client.fetchProducts(asins)
    const wsId = workspaceId?.trim() || process.env.WORKSPACE_ID?.trim()
    if (wsId) {
      await recordTokensFromKeepaResponse(wsId, resp)
    }
  } catch (e) {
    const msg = classifyKeepaError(e instanceof Error ? e.message : String(e))
    return asins.map(asin =>
      buildDecision({
        asin,
        product: null,
        keepaResp: null,
        offersEnabled: cfg.offersEnabled,
        errorMessage: msg,
      })
    )
  }

  const products = Array.isArray(resp.products) ? resp.products : []
  const map = new Map<string, KeepaApiProduct>()
  for (const p of products) {
    const a = p?.asin?.trim()?.toUpperCase()
    if (a) map.set(a, p)
  }

  const results = asins.map(asin =>
    buildDecision({
      asin,
      product: map.get(asin) ?? null,
      keepaResp: resp,
      offersEnabled: cfg.offersEnabled,
    })
  )

  for (const r of results) {
    const cost = resp.processingTimeInMs != null ? ` ms=${resp.processingTimeInMs}` : ""
    const tokensLeft = resp.tokensLeft != null ? ` tokensLeft=${resp.tokensLeft}` : ""
    const warn =
      r.priceSelectionWarnings.length > 0
        ? ` warnings=${r.priceSelectionWarnings.join(",")}`
        : ""
    console.log(
      `[KeepaPriceSelector] asin=${r.asin} selected=${r.price ?? "null"} source=${r.selectedPriceSource} candidates=${formatPriceCandidatesLog(r.priceCandidates)} status=${r.sourceStatus}${warn}${tokensLeft}${cost}`
    )
    console.log(
      `[KeepaCheck] asin=${r.asin} status=${r.sourceStatus} reason="${r.reason}" price=${r.price ?? "null"}${tokensLeft}${cost}`
    )
  }

  return results
}

export async function keepaCheckAsin(
  asin: string,
  workspaceId?: string
): Promise<KeepaCheckAsinResponse> {
  const results = await keepaCheckAsins([asin], workspaceId)
  return (
    results[0] ??
    buildDecision({
      asin,
      product: null,
      keepaResp: null,
      offersEnabled: false,
      errorMessage: "CHECK_FAILED",
    })
  )
}

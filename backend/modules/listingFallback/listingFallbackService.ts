// ----------------------------------------------------------------
// listingFallbackService.ts — deterministic publish fallbacks (no Gemini)
// ----------------------------------------------------------------

import { buildItemSpecifics, isBlockedKey } from "../aiListing/aiListingService"
import type { AiListingInput } from "../aiListing/aiListingTypes"
import type { CategorySuggestionForSelection } from "../aiListing/aiListingService"

export type { CategorySuggestionForSelection }

function collapseWS(s: string): string {
  return s.replace(/\s+/g, " ").trim()
}

export function parseAmazonAttributes(value: unknown): {
  bullets: string[]
  specs:   Record<string, string>
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { bullets: [], specs: {} }
  }
  const att = value as Record<string, unknown>
  const bullets = Array.isArray(att.bullets)
    ? (att.bullets as unknown[]).map(b => collapseWS(String(b))).filter(Boolean).slice(0, 5)
    : []
  const specs: Record<string, string> = {}
  if (att.specs && typeof att.specs === "object" && !Array.isArray(att.specs)) {
    for (const [k, v] of Object.entries(att.specs as Record<string, unknown>)) {
      const key = collapseWS(String(k))
      const val = collapseWS(String(v ?? ""))
      if (key && val) specs[key] = val.slice(0, 65)
    }
  }
  return { bullets, specs }
}

export function buildBulletsFromAmazon(
  amazonBullets: string[],
  title: string
): string[] {
  if (amazonBullets.length > 0) {
    return amazonBullets.map(b => b.slice(0, 180))
  }
  const t = collapseWS(title)
  if (!t) return []
  return [t.slice(0, 180)]
}

export function buildRuleBasedItemSpecifics(input: {
  asin:          string
  title:         string
  brand:         string
  specs:         Record<string, string>
  isPrime?:      boolean
  isFreeShipping?: boolean
}): Record<string, string> {
  const aiInput: AiListingInput = {
    asin:            input.asin,
    title:           input.title,
    brand:           input.brand,
    price:           0,
    currency:        "USD",
    images:          [],
    bullets:         [],
    description:     "",
    specs:           input.specs,
    rating:          0,
    reviews:         0,
    bsr:             null,
    category:        "",
    isPrime:         input.isPrime === true,
    isFreeShipping:  input.isFreeShipping === true,
  }
  return buildItemSpecifics(aiInput)
}

export function buildTemplateDescriptionFallback(
  title: string,
  brand: string,
  bullets: string[]
): string {
  const safeTitle = collapseWS(title).slice(0, 200)
  const safeBrand = collapseWS(brand).slice(0, 65) || "Generic"
  const lines = bullets.length > 0
    ? bullets.map(b => `- ${collapseWS(b).slice(0, 200)}`).join("\n")
    : ""
  const body = lines
    ? `${safeTitle}\n\n${lines}\n\nProduct prepared for ${safeBrand}.`
    : `${safeTitle}\n\nProduct prepared for ${safeBrand}.`
  return body.slice(0, 4000)
}

export function chooseCategoryWithoutAi(
  suggestions: CategorySuggestionForSelection[]
): string {
  return suggestions[0]?.categoryId ?? "0"
}

export { isBlockedKey }

// ─────────────────────────────────────────────────────────────
// aiListingService.ts
//
// Publish: amazon_product_cache.images + processAndUploadImages (ebayInventoryService);
// title / bullets / description / item_specifics bu modulden ai_listing_cache'e yazilir,
// buildEbayListingPayloads ile payload'a aktarilir.
//
// Amazon → eBay listing dönüşümü:
// - Title: Gemini (gemini-2.5-flash-lite) + strict JSON schema
// - Publish: taxonomy önerileri arasından kategori → selectBestCategory (Gemini)
// - Description: template (AI yok)
// - Item specifics: rules (AI yok)
// - generateAndCacheAiListing: generate + upsert ai_listing_cache
// ─────────────────────────────────────────────────────────────

import { GoogleGenerativeAI } from "@google/generative-ai"
import { query } from "../../db/client"
import type { AiListingInput, AiListingOutput } from "./aiListingTypes"

const TITLE_MODEL = "gemini-2.5-flash-lite"
const TITLE_MIN = 65
const TITLE_MAX = 75

const TITLE_SYSTEM_INSTRUCTION =
  "You are an eBay SEO title expert. Return ONLY a JSON object with one field: ebayTitle.\n" +
  "RULES:\n" +
  "1. Length: 65-75 characters mandatory. Never below 65, never above 75.\n" +
  "2. Structure: [Quantity/Size] [Product Name] [Feature/Benefit keywords]\n" +
  "3. Abbreviations: 2PC, 4PC for pieces. 5in, 10ft, 3oz for measurements.\n" +
  "4. NO brand names. NO Amazon. NO Prime. NO special characters (!,@,#).\n" +
  "5. Quantity: ONLY include quantity (2PC, 4PC) if product contains multiple items. Single items (1PC, 1PCS) must NEVER be written.\n" +
  "6. Fill to 65-75 chars using high-search keywords from bullets and specs.\n" +
  "Spaces count as characters. Total must be 65-75 characters including spaces.\n" +
  "NEVER invent measurements (inches, cm, etc.) not present in the Amazon data.\n" +
  "7. English only."

const TITLE_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    ebayTitle: { type: "string" },
  },
  required: ["ebayTitle"],
} as const

const TITLE_GENERATION_CONFIG = {
  temperature: 0.1,
  topP: 0.95,
  topK: 40,
  maxOutputTokens: 512,
  responseMimeType: "application/json" as const,
  responseSchema: TITLE_RESPONSE_SCHEMA,
}

function normalizeSpaces(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

function stripUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s<>"']+/gi, "")
}

function stripForbiddenWords(text: string): string {
  return text
    .replace(/\bAmazon\b/gi, "")
    .replace(/\bPrime\b/gi, "")
    .replace(/\bAmazon\.com\b/gi, "")
}

function stripSpecialCharacters(text: string): string {
  // keep only letters/numbers/spaces
  return normalizeSpaces(text.replace(/[^a-z0-9 ]+/gi, " "))
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function stripBrandFromTitle(title: string, brand: string): string {
  const b = normalizeSpaces(brand)
  if (!b) return title
  const re = new RegExp(`\\b${escapeRegExp(b)}\\b`, "ig")
  return normalizeSpaces(title.replace(re, " "))
}

function cleanText(text: string): string {
  return stripSpecialCharacters(normalizeSpaces(stripForbiddenWords(stripUrls(text))))
}

function truncateItemSpecificText(value: unknown): string {
  return normalizeSpaces(String(value ?? "")).slice(0, 65)
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function escapeHtmlAttr(text: string): string {
  // Same escaping is fine for HTML attributes in our use-case.
  return escapeHtml(text)
}

function keywordsFromInput(input: AiListingInput): string[] {
  const pool = [
    ...(input.bullets ?? []),
    input.category ?? "",
    ...Object.keys(input.specs ?? {}),
    ...Object.values(input.specs ?? {}),
  ].join(" ")

  const cleaned = cleanText(pool).toLowerCase()
  const words = cleaned.split(/\s+/g).filter(w => w.length >= 3 && w.length <= 14)
  const seen = new Set<string>()
  const out: string[] = []
  for (const w of words) {
    if (seen.has(w)) continue
    seen.add(w)
    out.push(w)
    if (out.length >= 20) break
  }
  return out
}

function enforceTitleLength(title: string, input: AiListingInput, brand: string): string {
  let t = cleanText(title)
  t = stripBrandFromTitle(t, brand)

  const truncateAtNearestSpace = (raw: string): string => {
    if (raw.length <= TITLE_MAX) return raw.trim()
    const within = raw.slice(0, TITLE_MAX)
    const lastSpace = within.lastIndexOf(" ")
    if (lastSpace > 0) return raw.slice(0, lastSpace).trim()
    return within.trim()
  }

  if (t.length > TITLE_MAX) t = truncateAtNearestSpace(t)

  if (t.length < TITLE_MIN) {
    const kws = keywordsFromInput(input)
    for (const kw of kws) {
      if (t.length >= TITLE_MIN) break
      const candidate = normalizeSpaces(`${t} ${kw}`)
      if (candidate.length <= TITLE_MAX) t = candidate
    }
  }

  if (t.length < TITLE_MIN) {
    const fillers = ["Quality", "Durable", "Value", "Easy", "Fit", "New"]
    for (const f of fillers) {
      if (t.length >= TITLE_MIN) break
      const candidate = normalizeSpaces(`${t} ${f}`)
      if (candidate.length <= TITLE_MAX) t = candidate
    }
  }

  if (t.length > TITLE_MAX) t = truncateAtNearestSpace(t)
  return t
}

function buildTitlePrompt(input: AiListingInput): string {
  return [
    "Create an eBay SEO title from this Amazon product data.",
    "Return ONLY JSON with {\"ebayTitle\":\"...\"}.",
    "",
    "AMAZON DATA:",
    `- Title: ${input.title}`,
    `- Bullets: ${JSON.stringify(input.bullets)}`,
    `- Specs: ${JSON.stringify(input.specs)}`,
    `- Category: ${input.category}`,
  ].join("\n")
}

export async function generateEbayTitle(input: AiListingInput): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey || apiKey.trim() === "") {
    throw new Error("GEMINI_API_KEY is not set or empty in environment")
  }

  const genAI = new GoogleGenerativeAI(apiKey)
  const model = genAI.getGenerativeModel({
    model: TITLE_MODEL,
    systemInstruction: TITLE_SYSTEM_INSTRUCTION,
    generationConfig: TITLE_GENERATION_CONFIG as Record<string, unknown>,
  })

  const result = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: buildTitlePrompt(input) }] }],
  })

  const response = result.response
  if (!response) throw new Error("Gemini returned no response")

  const text = response.text()
  if (!text || text.trim() === "") throw new Error("Gemini returned empty text")

  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== "object" || parsed === null) throw new Error("Gemini response is not a JSON object")

  const obj = parsed as Record<string, unknown>
  const rawTitle = typeof obj.ebayTitle === "string" ? obj.ebayTitle : ""

  return enforceTitleLength(rawTitle, input, input.brand ?? "")
}

export type CategorySuggestionForSelection = {
  categoryId:              string
  categoryName:              string
  categoryTreeNodeLevel:     number
}

function parseGeminiCategoryIdOnly(text: string): string | null {
  let t = text.trim()
  t = t.replace(/^```(?:\w*)?\r?\n?/i, "").replace(/\r?\n?```\s*$/i, "").trim()
  if (/^\d+$/.test(t)) return t
  const m = t.match(/\b(\d+)\b/)
  return m && /^\d+$/.test(m[1]!) ? m[1]! : null
}

/**
 * eBay taxonomy önerileri arasından Gemini ile en uygun leaf categoryId seçer.
 */
export async function selectBestCategory(
  title: string,
  specs: Record<string, string>,
  suggestions: CategorySuggestionForSelection[]
): Promise<string> {
  const fallback = suggestions[0]?.categoryId ?? "0"
  if (suggestions.length === 0) return "0"

  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey || apiKey.trim() === "") {
    return fallback
  }

  const specsJson = JSON.stringify(specs).slice(0, 500)
  const categoriesBlock = suggestions
    .map((s, i) => `${i}. ${s.categoryName} (id: ${s.categoryId})`)
    .join("\n")

  const prompt =
    "You are an eBay category expert. Select the most appropriate category for this product.\n\n" +
    `Product Title: ${title}\n` +
    `Product Specs: ${specsJson}\n\n` +
    "Available eBay categories:\n" +
    `${categoriesBlock}\n\n` +
    "Rules:\n" +
    "- Choose the most specific and relevant category\n" +
    "- Avoid collectibles categories unless product is clearly a collectible\n" +
    "- Prefer categories used by active sellers of similar products\n" +
    "- Return ONLY the category ID number, nothing else"

  try {
    const genAI = new GoogleGenerativeAI(apiKey)
    const model = genAI.getGenerativeModel({
      model: TITLE_MODEL,
      generationConfig: {
        temperature:     0.1,
        topP:            0.95,
        topK:            40,
        maxOutputTokens: 32,
      },
    })

    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    })
    const response = result.response
    if (!response) return fallback

    const text = response.text()
    if (!text || text.trim() === "") return fallback

    const id = parseGeminiCategoryIdOnly(text)
    if (id && suggestions.some(s => s.categoryId === id)) return id
    return fallback
  } catch {
    return fallback
  }
}

export function buildDescription(input: AiListingInput, ebayTitle: string): string {
  const coverImage = input.images?.[0] ? String(input.images[0]).trim() : ""

  const titleText = escapeHtml(cleanText(ebayTitle))

  const bullets = (input.bullets ?? [])
    .map((b) => cleanText(b))
    .filter((b) => b.length > 0)
    .slice(0, 8)
    .map(escapeHtml)

  const descRaw = input.description ? cleanText(input.description) : ""
  const amazonDesc = descRaw ? escapeHtml(descRaw) : ""

  const coverHtml = coverImage
    ? `<div style="margin:0 0 12px 0;">
  <img src="${escapeHtmlAttr(coverImage)}" style="max-width:100%;display:block;margin:0 auto;border-radius:6px;">
</div>`
    : ""

  const greenBannerHtml = `<div style="margin:0 0 14px 0;padding:10px 12px;background:#16a34a;color:#fff;font-weight:700;border-radius:6px;text-align:center;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.25;">
  ✅ FREE &amp; FAST SHIPPING | ✅ 30-DAY RETURNS | ✅ 100% SATISFACTION
</div>`

  const titleHtml = `<h2 style="font-family:Arial,Helvetica,sans-serif;font-size:22px;line-height:1.25;margin:0 0 12px 0;color:#111;text-align:center;">${titleText}</h2>`

  const bulletsHtml = bullets.length
    ? `<ul style="margin:0 0 14px 0;padding:0;list-style:none;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#222;">
  ${bullets
    .map(
      (b) =>
        `<li style="margin:0 0 8px 0;">
  <span style="margin-right:10px;color:#16a34a;font-weight:800;">✅</span><span>${b}</span>
</li>`,
    )
    .join("\n")}
</ul>`
    : ""

  const descHtml = amazonDesc
    ? `<p style="margin:0 0 14px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.7;color:#222;">${amazonDesc}</p>`
    : ""

  const footerHtml = `<div style="margin-top:16px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:14px;">
  <div style="display:flex;gap:14px;flex-wrap:wrap;">
    <div style="flex:1;min-width:220px;text-align:center;font-family:Arial,Helvetica,sans-serif;">
      <div style="font-size:26px;line-height:1;margin:0 0 6px 0;">🚚</div>
      <div style="font-weight:800;font-size:13px;letter-spacing:0.2px;margin:0 0 3px 0;color:#065f46;">FAST SHIPPING</div>
      <div style="font-size:12px;color:#166534;line-height:1.4;">We ship quickly after payment</div>
    </div>
    <div style="flex:1;min-width:220px;text-align:center;font-family:Arial,Helvetica,sans-serif;">
      <div style="font-size:26px;line-height:1;margin:0 0 6px 0;">↩️</div>
      <div style="font-weight:800;font-size:13px;letter-spacing:0.2px;margin:0 0 3px 0;color:#065f46;">30-DAY RETURNS</div>
      <div style="font-size:12px;color:#166534;line-height:1.4;">Easy returns within 30 days</div>
    </div>
    <div style="flex:1;min-width:220px;text-align:center;font-family:Arial,Helvetica,sans-serif;">
      <div style="font-size:26px;line-height:1;margin:0 0 6px 0;">🛡️</div>
      <div style="font-weight:800;font-size:13px;letter-spacing:0.2px;margin:0 0 3px 0;color:#065f46;">100% SATISFACTION</div>
      <div style="font-size:12px;color:#166534;line-height:1.4;">Buy with confidence</div>
    </div>
  </div>
</div>`

  const policyHtml = `
<div style="font-family:Arial,sans-serif;max-width:700px;margin:20px auto 0;padding:0 12px;">

  <!-- Shipping -->
  <div style="border:1.5px solid #1a6db5;border-radius:10px;padding:18px 20px;margin-bottom:14px;background:#f8fbff;">
    <div style="font-size:22px;margin-bottom:6px;">✦</div>
    <div style="font-weight:700;font-size:14px;color:#1a1a1a;margin-bottom:8px;">Shipping</div>
    <p style="margin:0 0 5px;font-size:13px;color:#333;">We offer <strong style="color:#1a6db5;">Free Shipping</strong> to the US and ship within <strong style="color:#1a6db5;">1-3 business days</strong> of payment.</p>
    <p style="margin:0 0 5px;font-size:13px;color:#333;">Most orders arrive within <strong style="color:#e67e00;">3-7 business days</strong> after dispatch.</p>
    <p style="margin:0;font-size:13px;color:#333;">Tracking information is provided for every order.</p>
  </div>

  <!-- Returns -->
  <div style="border:1.5px solid #1a6db5;border-radius:10px;padding:18px 20px;margin-bottom:14px;background:#f8fbff;">
    <div style="font-size:22px;margin-bottom:6px;">✦</div>
    <div style="font-weight:700;font-size:14px;color:#1a1a1a;margin-bottom:8px;">Returns & Refunds</div>
    <p style="margin:0 0 5px;font-size:13px;color:#333;">We offer a <strong style="color:#1a6db5;">30-Day Return Policy</strong> on all items.</p>
    <p style="margin:0 0 5px;font-size:13px;color:#333;">You may request a <strong style="color:#1a6db5;">full refund</strong> or exchange if you are not completely satisfied.</p>
    <p style="margin:0;font-size:13px;color:#e67e00;">No returns on items shipped outside of the US.</p>
  </div>

  <!-- Contact -->
  <div style="border:1.5px solid #1a6db5;border-radius:10px;padding:18px 20px;margin-bottom:14px;background:#f8fbff;">
    <div style="font-size:22px;margin-bottom:6px;">✦</div>
    <div style="font-weight:700;font-size:14px;color:#1a1a1a;margin-bottom:8px;">Contact & Support</div>
    <p style="margin:0 0 5px;font-size:13px;color:#333;">We do our <strong style="color:#1a6db5;">very best</strong> to ensure every customer is completely satisfied.</p>
    <p style="margin:0;font-size:13px;color:#333;">If there's a <strong style="color:#e67e00;">problem</strong>, message us — we're happy to help. <strong style="color:#1a6db5;">Fast response</strong> guaranteed.</p>
  </div>

</div>
`

  const existingHtml = `<div style="max-width:900px;margin:0 auto;background:#fff;padding:16px;border:1px solid #e6e6e6;border-radius:8px;font-family:Arial,Helvetica,sans-serif;color:#111;">
${coverHtml}
${greenBannerHtml}
${titleHtml}
${bulletsHtml}
${descHtml}
${footerHtml}
</div>`

  console.log("[buildDescription] policyHtml length:", policyHtml.length)
  console.log("[buildDescription] total length:", (existingHtml + policyHtml).length)

  return existingHtml + policyHtml
}

export const BLOCKED_KEYS = [
  "asin",
  "customer reviews",
  "best sellers rank",
  "date first available",
  "var dp",
  "dpacr",
  "hasregiste",
]

export function isBlockedKey(key: string): boolean {
  const k = key.toLowerCase().trim()
  return BLOCKED_KEYS.some(b => k.includes(b))
}

export function buildItemSpecifics(input: AiListingInput): Record<string, string> {
  const out: Record<string, string> = {}

  // Always include
  out[truncateItemSpecificText("Condition")] = truncateItemSpecificText("New")
  out[truncateItemSpecificText("Brand")] = truncateItemSpecificText(input.brand ?? "")

  // Always does not apply
  out[truncateItemSpecificText("Type")] = truncateItemSpecificText("Does not apply")
  out[truncateItemSpecificText("MPN")] = truncateItemSpecificText("Does not apply")
  out[truncateItemSpecificText("UPC")] = truncateItemSpecificText("Does not apply")
  out[truncateItemSpecificText("EAN")] = truncateItemSpecificText("Does not apply")
  out[truncateItemSpecificText("ISBN")] = truncateItemSpecificText("Does not apply")

  // Map all Amazon specs
  for (const [k, v] of Object.entries(input.specs ?? {})) {
    if (isBlockedKey(k)) continue
    const key = truncateItemSpecificText(k)
    const val = truncateItemSpecificText(v)
    if (!key || !val) continue
    out[key] = val
  }

  // Shipping rules
  if (input.isPrime || input.isFreeShipping) {
    out[truncateItemSpecificText("Shipping")] = truncateItemSpecificText("Free Shipping")
  }

  return out
}

function cleanBulletsForOutput(input: AiListingInput): string[] {
  return (input.bullets ?? [])
    .map(b => cleanText(b))
    .filter(Boolean)
}

export async function generateAiListing(input: AiListingInput): Promise<AiListingOutput> {
  const ebayTitle = await generateEbayTitle(input)
  const bullets = cleanBulletsForOutput(input)
  const description = buildDescription(input, ebayTitle)
  const itemSpecifics = buildItemSpecifics(input)

  return {
    ebayTitle,
    brand: input.brand ?? "",
    bullets,
    description,
    itemSpecifics,
  }
}

/**
 * AI listing üretir ve sonucu ai_listing_cache tablosuna upsert eder.
 */
export async function generateAndCacheAiListing(
  workspaceId: string,
  asinRegistryId: number,
  input: AiListingInput
): Promise<AiListingOutput> {
  const output = await generateAiListing(input)

  await query(
    `INSERT INTO ai_listing_cache (workspace_id, asin_registry_id, title, bullets, description, item_specifics, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, NOW())
     ON CONFLICT (workspace_id, asin_registry_id) DO UPDATE SET
       title = EXCLUDED.title,
       bullets = EXCLUDED.bullets,
       description = EXCLUDED.description,
       item_specifics = EXCLUDED.item_specifics,
       updated_at = NOW()`,
    [
      workspaceId,
      asinRegistryId,
      output.ebayTitle,
      JSON.stringify(output.bullets),
      output.description,
      JSON.stringify(output.itemSpecifics),
    ]
  )

  await query(
    `UPDATE asin_pool
     SET pipeline_stage = 'ai_generated',
         ai_status = 'success',
         updated_at = NOW()
     WHERE workspace_id = $1 AND asin_registry_id = $2`,
    [workspaceId, asinRegistryId]
  )

  return output
}

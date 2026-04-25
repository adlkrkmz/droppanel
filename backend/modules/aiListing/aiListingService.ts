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
import { addNotification } from "../notifications/notificationService"
import type { AiListingInput, AiListingOutput } from "./aiListingTypes"

const TITLE_MODEL = "gemini-2.5-flash-lite"
const TITLE_MIN = 75
const TITLE_MAX = 80

const TITLE_SYSTEM_INSTRUCTION =
  "You are an eBay SEO title expert. Return ONLY a JSON object with one field: ebayTitle.\n" +
  "RULES:\n" +
  "1. Length: 75-80 characters mandatory. Never below 75, never above 80.\n" +
  "2. Structure: [Quantity/Size] [Product Name] [Feature/Benefit keywords]\n" +
  "3. Abbreviations: 2PC, 4PC for pieces. 5in, 10ft, 3oz for measurements.\n" +
  "4. NO brand names. NO Amazon. NO Prime. NO special characters (!,@,#).\n" +
  "5. Quantity: ONLY include quantity (2PC, 4PC) if product contains multiple items. Single items (1PC, 1PCS) must NEVER be written.\n" +
  "6. Fill to 75-80 chars using high-search keywords from bullets and specs.\n" +
  "Spaces count as characters. Total must be 75-80 characters including spaces.\n" +
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

async function generateTemuItemSpecifics(title: string, bullets: string[]): Promise<Record<string, string>> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey || apiKey.trim() === "") return {}

  const prompt = [
    "You are an eBay item specifics expert.",
    "Given this product title, infer 5 basic item specifics for an eBay listing.",
    "Return ONLY a JSON object with these fields: Color, Material, Size, Style, Features.",
    "Rules:",
    "- Infer from the title context. Example: 'pillow' → Material: 'Polyester', 'organizer' → Material: 'Fabric/Nylon'.",
    "- Color: if obvious from title use it, otherwise 'Multicolor'.",
    "- Size: if dimensions in title use them, otherwise 'One Size'.",
    "- Features: 2-3 key selling points from the title, max 65 chars.",
    "- Style: infer from product type (e.g. 'Modern', 'Classic', 'Minimalist').",
    "- Keep all values under 65 characters.",
    "- Do NOT use 'Does Not Apply' — always make a reasonable inference.",
    "",
    "Title: " + title,
    "Bullets: " + JSON.stringify(bullets),
  ].join("\n")

  try {
    const genAI = new GoogleGenerativeAI(apiKey)
    const model = genAI.getGenerativeModel({
      model: TITLE_MODEL,
      generationConfig: {
        temperature: 0.1,
        topP: 0.95,
        topK: 40,
        maxOutputTokens: 256,
        responseMimeType: "application/json",
        responseSchema: {
          type: "object",
          properties: {
            Color: { type: "string" },
            Material: { type: "string" },
            Size: { type: "string" },
            Style: { type: "string" },
            Features: { type: "string" },
          },
          required: ["Color", "Material", "Size", "Style", "Features"],
        },
      } as Record<string, unknown>,
    })

    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    })
    const response = result.response
    if (!response) return {}
    const text = response.text()
    if (!text || text.trim() === "") return {}

    const parsed = JSON.parse(text) as Record<string, unknown>
    const specs: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string" && v.trim().length > 0) {
        specs[k] = v.trim().slice(0, 65)
      }
    }
    console.log("[AI] Temu specs generated:", JSON.stringify(specs))
    return specs
  } catch (e) {
    console.warn("[AI] generateTemuItemSpecifics failed:", e instanceof Error ? e.message : e)
    return {}
  }
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

export async function fillMissingRequiredAspects(
  title: string,
  existingAspects: Record<string, string[]>,
  requiredAspects: Array<{ name: string; values: string[] }>
): Promise<Record<string, string[]>> {
  const missing = requiredAspects.filter(ra => {
    const existing = existingAspects[ra.name]
    return !existing || existing.length === 0 || existing[0] === "Does Not Apply"
  })

  if (missing.length === 0) return existingAspects

  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey || apiKey.trim() === "") {
    const filled = { ...existingAspects }
    for (const m of missing) {
      filled[m.name] = [m.values[0] ?? "Does Not Apply"]
    }
    return filled
  }

  const prompt = [
    "You are an eBay item specifics expert.",
    "Given this product title and a list of missing required item specifics with their allowed values,",
    "select the most appropriate value for each missing spec.",
    "Return ONLY a JSON object where keys are spec names and values are the selected value string.",
    "",
    "Product Title: " + title,
    "",
    "Missing required specs:",
    ...missing.map(m => `- ${m.name}: allowed values = [${m.values.slice(0, 15).join(", ")}]`),
    "",
    "Rules:",
    "- Pick the most likely value based on the product title.",
    "- If no value fits, use the first allowed value or 'Does Not Apply'.",
    "- Keep values exactly as listed in allowed values when possible.",
  ].join("\n")

  try {
    const genAI = new GoogleGenerativeAI(apiKey)
    const model = genAI.getGenerativeModel({
      model: TITLE_MODEL,
      generationConfig: {
        temperature:     0.1,
        maxOutputTokens: 256,
        responseMimeType: "application/json",
      } as Record<string, unknown>,
    })

    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    })
    const response = result.response
    const text = response?.text()
    if (!text) throw new Error("empty response")

    const parsed = JSON.parse(text) as Record<string, string>
    const filled = { ...existingAspects }

    for (const m of missing) {
      const aiValue = parsed[m.name]
      if (aiValue && typeof aiValue === "string" && aiValue.trim().length > 0) {
        filled[m.name] = [aiValue.trim().slice(0, 65)]
        console.log(`[AI] Required aspect filled: ${m.name} = ${aiValue}`)
      } else {
        filled[m.name] = [m.values[0] ?? "Does Not Apply"]
        console.log(`[AI] Required aspect fallback: ${m.name} = ${filled[m.name][0]}`)
      }
    }

    return filled
  } catch (e) {
    console.warn("[AI] fillMissingRequiredAspects failed:", e instanceof Error ? e.message : e)
    const filled = { ...existingAspects }
    for (const m of missing) {
      filled[m.name] = [m.values[0] ?? "Does Not Apply"]
    }
    return filled
  }
}

const POLICY_IMAGE_URL = "https://img.listjetgo.com/1.png"
const EBAY_DESC_LIMIT  = 4000

export function buildDescription(input: AiListingInput, ebayTitle: string): string {
  const titleText = escapeHtml(cleanText(ebayTitle))

  const bullets = (input.bullets ?? [])
    .map((b) => cleanText(b))
    .filter((b) => b.length > 0)
    .slice(0, 5)
    .map(escapeHtml)

  const titleHtml = `<h2 style="font-family:Arial,sans-serif;font-size:18px;font-weight:800;color:#111;margin:0 0 12px;line-height:1.3;border-bottom:2px solid #e8edf2;padding-bottom:10px;">${titleText}</h2>`

  const bulletsHtml = bullets.length
    ? `<div style="margin-bottom:14px;">${bullets.map((b) =>
        `<div style="display:flex;align-items:flex-start;gap:10px;margin-bottom:8px;padding:8px 12px;background:#f9fafb;border-left:3px solid #1a6db5;border-radius:0 6px 6px 0;"><span style="color:#1a6db5;font-size:15px;line-height:1;">&#10003;</span><span style="font-size:13px;color:#222;line-height:1.5;">${b}</span></div>`
      ).join("")}</div>`
    : ""

  const policyImgHtml = `<div style="text-align:center;margin-top:8px;"><img src="${POLICY_IMAGE_URL}" style="max-width:100%;display:block;margin:0 auto;" /></div>`

  const html = `<div style="font-family:Arial,sans-serif;max-width:860px;margin:0 auto;padding:16px;color:#111;background:#fff;">${titleHtml}${bulletsHtml}${policyImgHtml}</div>`

  const result = html.length > EBAY_DESC_LIMIT
    ? html.slice(0, EBAY_DESC_LIMIT - 6) + "</div>"
    : html

  console.log("[buildDescription] length:", result.length)
  return result
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
  let itemSpecifics = buildItemSpecifics(input)

  // Temu ürünleri için AI'dan item specifics üret (generateAndCacheAiListing cache'den önce bu çıktıyı kullanır)
  const isTemu = input.asin?.startsWith("TEMU")
  if (isTemu) {
    const temuSpecs = await generateTemuItemSpecifics(ebayTitle, input.bullets ?? [])
    for (const [k, v] of Object.entries(temuSpecs)) {
      if (
        !itemSpecifics[k] ||
        itemSpecifics[k] === "Does not apply" ||
        itemSpecifics[k] === "Does Not Apply" ||
        itemSpecifics[k] === ""
      ) {
        itemSpecifics[k] = v
      }
    }
  }

  const isAli = input.asin?.startsWith("ALI")
  if (isAli) {
    // Önce gelen specs'i item_specifics'e aktar
    const aliSpecs = (input.specs ?? {}) as Record<string, string>
    const SKIP_SPECS = new Set([
      'brand', 'model', 'mpn', 'upc', 'ean', 'isbn',
      'country of origin', 'origin', 'ship from',
    ])
    for (const [k, v] of Object.entries(aliSpecs)) {
      if (!v || v.length > 200) continue
      if (SKIP_SPECS.has(k.toLowerCase())) continue
      if (
        !itemSpecifics[k] ||
        itemSpecifics[k] === 'Does not apply' ||
        itemSpecifics[k] === 'Does Not Apply' ||
        itemSpecifics[k] === ''
      ) {
        itemSpecifics[k] = v
      }
    }
    // Eksik kalanları Temu gibi AI ile tamamla
    const aliAiSpecs = await generateTemuItemSpecifics(ebayTitle, input.bullets ?? [])
    for (const [k, v] of Object.entries(aliAiSpecs)) {
      if (
        !itemSpecifics[k] ||
        itemSpecifics[k] === 'Does not apply' ||
        itemSpecifics[k] === 'Does Not Apply' ||
        itemSpecifics[k] === ''
      ) {
        itemSpecifics[k] = v
      }
    }
  }

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

  try {
    await addNotification(
      workspaceId,
      "success",
      "AI Listing Hazır",
      `${input.asin} için AI listing oluşturuldu`
    )
  } catch {
    /* bildirim ana akışı bozmasın */
  }

  return output
}

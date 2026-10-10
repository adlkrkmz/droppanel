import { GoogleGenerativeAI } from "@google/generative-ai"
import { query } from "../../db/client"

const TITLE_MODEL = "gemini-2.5-flash-lite"

function getWorkspaceId(): string {
  const id = process.env.WORKSPACE_ID
  if (!id) throw new Error("WORKSPACE_ID is not defined")
  return id
}

function parseImages(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map(v => String(v).trim()).filter(Boolean)
  }
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        return parsed.map(v => String(v).trim()).filter(Boolean)
      }
    } catch {
      return []
    }
  }
  return []
}

function clampDescriptionHtml(html: string): string {
  const trimmed = html.trim()
  if (trimmed.length <= 4000) return trimmed
  return trimmed.slice(0, 4000)
}

function clampTitle80(title: string): string {
  const t = title.replace(/\s+/g, " ").trim()
  if (t.length <= 80) return t
  return t.slice(0, 80).trim()
}

function normalizeItemSpecifics(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object") return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const key = String(k).trim()
    if (!key) continue
    const val = typeof v === "string" ? v : v === null || v === undefined ? "" : String(v)
    const s = val.trim()
    if (!s) continue
    out[key] = s.slice(0, 65)
  }
  return out
}

type VariationGeminiOutput = {
  ebay_title: string
  ebay_description: string
  item_specifics: Record<string, string>
}

export async function generateVariationListing(variationProductId: number): Promise<void> {
  const workspaceId = getWorkspaceId()

  const productRes = await query(
    `SELECT id, title, brand, description, images
     FROM variation_products
     WHERE id = $1 AND workspace_id = $2
     LIMIT 1`,
    [variationProductId, workspaceId]
  )
  const product = productRes.rows[0] as
    | {
        id: number
        title: string | null
        brand: string | null
        description: string | null
        images: unknown
      }
    | undefined
  if (!product) throw new Error(`variation_products id=${variationProductId} bulunamadı`)

  const itemsRes = await query(
    `SELECT aspect_name, aspect_value
     FROM variation_items
     WHERE variation_product_id = $1
     ORDER BY id ASC`,
    [variationProductId]
  )
  const variationOptions = itemsRes.rows as Array<{ aspect_name: string; aspect_value: string }>

  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey || apiKey.trim() === "") {
    throw new Error("GEMINI_API_KEY is not set or empty in environment")
  }

  const prompt = [
    "You are an eBay listing expert for a multi-variation (group) product.",
    "Return ONLY JSON with fields: ebay_title, ebay_description, item_specifics.",
    "",
    "RULES:",
    "- ebay_title: English, Amazon-like SEO, MAX 80 characters (including spaces). No emojis.",
    "- ebay_description: HTML suitable for eBay (use <h2>, <p>, <ul><li>), MAX 4000 characters.",
    "- item_specifics: JSON object with string values (e.g. Color, Material, Size, Type, Features).",
    "  * Values max 65 chars.",
    "  * Do NOT include keys that vary per SKU (those will be handled separately).",
    "",
    "PRODUCT DATA:",
    `- title: ${product.title ?? ""}`,
    `- brand: ${product.brand ?? ""}`,
    `- description: ${product.description ?? ""}`,
    `- image_urls: ${JSON.stringify(parseImages(product.images))}`,
    `- variation_options: ${JSON.stringify(variationOptions)}`,
  ].join("\n")

  const genAI = new GoogleGenerativeAI(apiKey)
  const model = genAI.getGenerativeModel({
    model: TITLE_MODEL,
    generationConfig: {
      temperature: 0.2,
      topP: 0.95,
      topK: 40,
      maxOutputTokens: 2048,
      responseMimeType: "application/json",
      responseSchema: {
        type: "object",
        properties: {
          ebay_title: { type: "string" },
          ebay_description: { type: "string" },
          item_specifics: {
            type: "object",
          },
        },
        required: ["ebay_title", "ebay_description", "item_specifics"],
      },
    } as Record<string, unknown>,
  })

  const result = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
  })
  const response = result.response
  if (!response) throw new Error("Gemini returned no response")

  const text = response.text()
  if (!text || text.trim() === "") throw new Error("Gemini returned empty text")

  const parsed = JSON.parse(text) as VariationGeminiOutput
  const ebayTitle = clampTitle80(String(parsed.ebay_title ?? ""))
  if (!ebayTitle) throw new Error("Gemini returned empty ebay_title")

  const ebayDescription = clampDescriptionHtml(String(parsed.ebay_description ?? ""))
  if (!ebayDescription) throw new Error("Gemini returned empty ebay_description")

  const itemSpecifics = normalizeItemSpecifics(parsed.item_specifics)

  await query(
    `UPDATE variation_products
     SET ai_title = $1,
         ai_description = $2,
         ai_item_specifics = $3::jsonb,
         status = 'ai_done',
         updated_at = NOW()
     WHERE id = $4 AND workspace_id = $5`,
    [ebayTitle, ebayDescription, JSON.stringify(itemSpecifics), variationProductId, workspaceId]
  )
}

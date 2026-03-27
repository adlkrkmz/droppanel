// ─────────────────────────────────────────────────────────────
// templateTypes.ts
// ─────────────────────────────────────────────────────────────

export type TemplateId = "minimal_clean" | "modern_sales" | "premium_brand" | "minimal_pro"

export const TEMPLATE_IDS: Record<string, TemplateId> = {
  "1": "minimal_clean",
  "2": "modern_sales",
  "3": "premium_brand",
  "4": "minimal_pro",
}

export type TemplateInput = {
  title:        string
  brand?:       string | null
  bullets?:     string[] | null
  sellerNote?:  string | null
  shippingNote?: string | null
  returnNote?:  string | null
  imageUrls?:   string[] | null
  templateId?:  TemplateId | string | null
}

export type TemplateRenderResult = {
  templateId:  TemplateId
  html:        string
  charCount:   number
}

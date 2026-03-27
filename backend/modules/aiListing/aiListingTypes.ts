// ─────────────────────────────────────────────────────────────
// aiListingTypes.ts
// AI listing üretimi: input (AmazonProductData) ve output tipleri.
// Output: ebayTitle, brand, bullets, description (template), itemSpecifics map.
// ─────────────────────────────────────────────────────────────

import type { AmazonProductData } from "../productExtractor/productExtractorTypes"

/** AI listing servisine giren veri (Amazon ürün bilgisi) */
export type AiListingInput = AmazonProductData

/** Şablon description üretimi için gereken alanlar */
export type DescriptionTemplateInput = {
  ebayTitle: string
  amazonDescription?: string
  bullets: string[]
}

/** Gemini'den dönen yapılandırılmış listing çıktısı (strict schema) */
export type AiListingOutput = {
  ebayTitle: string
  brand: string
  bullets: string[]
  description: string
  itemSpecifics: Record<string, string>
}

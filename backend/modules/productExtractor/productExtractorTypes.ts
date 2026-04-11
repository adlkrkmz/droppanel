// ─────────────────────────────────────────────────────────────
// productExtractorTypes.ts
// Chrome Extension'dan gelen Amazon ürün verisi tipleri.
// ─────────────────────────────────────────────────────────────

/** Extension'dan gelen tek ürün payload'ı */
export type AmazonProductData = {
  asin:            string
  title:           string
  brand:           string
  price:           number
  currency:        string
  images:          string[]
  bullets:         string[]
  description:     string
  specs:           Record<string, string>
  rating:          number
  reviews:         number
  bsr:             number | null
  category:        string
  isPrime:         boolean
  isFreeShipping:  boolean
}

/** POST body — tek ürün (Extension sayfa bazlı gönderir) */
export type ProductExtractorRequest = AmazonProductData & {
  source?:      string
  external_id?: string | null
}

/** Başarılı yanıt */
export type ProductExtractorSuccessResponse = {
  success:         true
  asin:            string
  asinRegistryId:  number
  cacheCreated:    boolean
}

/** Hata yanıtı */
export type ProductExtractorErrorResponse = {
  success: false
  error:   string
}

export type ProductExtractorResponse =
  | ProductExtractorSuccessResponse
  | ProductExtractorErrorResponse

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
  isPrime:         boolean | null
  isFreeShipping:  boolean
  availabilityText?: string
  hasAddToCart?:    boolean
  hasBuyNow?:       boolean
  /** Explicit Prime status from Buy Box detector: PRIME | NOT_PRIME | UNKNOWN */
  primeStatus?:     string | null
  primeEvidence?:   string[]
  primeCheckedAt?:  string | null
  /** Selected Buy Box / page ASIN for integrity checks */
  selectedAsin?:    string | null
  pageUrlAsin?:     string | null
  /** Selected-offer stock: IN_STOCK | LIMITED_STOCK | OUT_OF_STOCK | UNKNOWN */
  stockStatus?:     string | null
  stockCount?:      number | null
  stockEvidence?:   string[]
  stockCheckedAt?:  string | null
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
  poolId:          number | null
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

// ─────────────────────────────────────────────────────────────
// imageProcessorTypes.ts
// Görsel indirme ve işleme (resize, overlay) tipleri.
// ─────────────────────────────────────────────────────────────

export type ImageProcessorInput = {
  imageUrls: string[]
  asin:      string
  /** When true, composite "Ships from USA" banner on first image (store setting). */
  warehouseShippingBannerEnabled?: boolean
}

export type ProcessedImage = {
  originalUrl: string
  buffer:      Buffer
  width:       number
  height:      number
}

export type ImageProcessorOutput = {
  processedImages: ProcessedImage[]
}

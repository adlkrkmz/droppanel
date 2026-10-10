export type AmazonSupplierEvidence = {
  title: string | null
  imageUrls: string[]
  price?: { amount: number; currency: string }
  selectedVariation?: string
  bulletPoints: string[]
  specifications: string[]
}

/** Opaque caller context retained only for reader-job correlation. */
export type AmazonSupplierReaderContext = Record<string, unknown>

export type AiGenerationCandidateRow = {
  poolId: number
  workspaceId: string
  asinRegistryId: number
  asin: string
  brand: string | null
  productTitle: string | null
  cacheTitle: string | null
  cacheBrand: string | null
  price: number | null
  images: unknown
  attributes: unknown
}

export type GeneratedListingContent = {
  title: string
  description: string
  bullets: string[]
}

export type AiGenerationResultRow = {
  poolId: number
  asinRegistryId: number
  asin: string
  title: string
  description: string
  bullets: string[]
  aiStatus: "success" | "failed"
  pipelineStage: "ai_generated" | "scraped"
}

export type AiGenerationResult = {
  processedCount: number
  rows: AiGenerationResultRow[]
}
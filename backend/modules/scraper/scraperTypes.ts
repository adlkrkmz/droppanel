export type PendingScrapeCandidateRow = {
  poolId: number
  asinRegistryId: number
  asin: string
  workspaceId: string
}

export type FakeScrapedData = {
  title: string
  brand: string
  price: number
  images: string[]
  attributes: Record<string, string>
}

export type ScrapeSimulationResultRow = {
  poolId: number
  asinRegistryId: number
  asin: string
  title: string
  brand: string
  price: number
  scrapeStatus: "success"
  pipelineStage: "scraped"
}

export type ScrapeSimulationResult = {
  processedCount: number
  rows: ScrapeSimulationResultRow[]
}
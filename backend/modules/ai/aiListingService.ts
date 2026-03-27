import { db } from "../../db/client"
import {
  getAiGenerationCandidates,
  markPoolAiFailed,
  markPoolAiSuccess,
  upsertAiListingCache
} from "./aiRepository"
import type {
  AiGenerationCandidateRow,
  AiGenerationResult,
  AiGenerationResultRow,
  GeneratedListingContent
} from "./aiTypes"

type TxClient = {
  query: <T = unknown>(
    text: string,
    params?: unknown[]
  ) => Promise<{ rows: T[]; rowCount: number | null }>
  release: () => void
}

function toTitleCase(value: string): string {
  return value
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ")
}

function getPrimaryTitle(candidate: AiGenerationCandidateRow): string {
  const cacheTitle = candidate.cacheTitle?.trim()
  if (cacheTitle) {
    return cacheTitle
  }

  const registryTitle = candidate.productTitle?.trim()
  if (registryTitle) {
    return registryTitle
  }

  return `Simulated Product Listing for ${candidate.asin}`
}

function getPrimaryBrand(candidate: AiGenerationCandidateRow): string {
  const cacheBrand = candidate.cacheBrand?.trim()
  if (cacheBrand) {
    return cacheBrand
  }

  const registryBrand = candidate.brand?.trim()
  if (registryBrand) {
    return registryBrand
  }

  return "Generic"
}

function parseAttributes(value: unknown): Record<string, string> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const output: Record<string, string> = {}

    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      output[key] = String(raw)
    }

    return output
  }

  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const output: Record<string, string> = {}
        for (const [key, raw] of Object.entries(parsed as Record<string, unknown>)) {
          output[key] = String(raw)
        }
        return output
      }
    } catch {
      return {}
    }
  }

  return {}
}

function buildTitle(candidate: AiGenerationCandidateRow): string {
  const baseTitle = getPrimaryTitle(candidate)
  const brand = getPrimaryBrand(candidate)
  const raw = `${brand} ${baseTitle}`.replace(/\s+/g, " ").trim()
  return raw.slice(0, 80)
}

function buildBullets(candidate: AiGenerationCandidateRow): string[] {
  const attrs = parseAttributes(candidate.attributes)
  const brand = getPrimaryBrand(candidate)
  const title = getPrimaryTitle(candidate)
  const priceText =
    typeof candidate.price === "number"
      ? `$${candidate.price.toFixed(2)}`
      : "Competitive price"

  const bullets: string[] = [
    `${brand} branded product matched to ASIN ${candidate.asin}.`,
    `Marketplace-ready listing title based on scraped product data.`,
    `Reference product name: ${title}.`,
    `Pricing anchor available at ${priceText}.`,
    `Key attributes: ${Object.entries(attrs)
      .slice(0, 3)
      .map(([key, value]) => `${toTitleCase(key)} ${value}`)
      .join(", ") || "Standard consumer attributes"}.`
  ]

  return bullets.map((item) => item.slice(0, 180))
}

function buildDescription(candidate: AiGenerationCandidateRow, bullets: string[]): string {
  const intro = `${buildTitle(candidate)} is prepared from simulated Amazon cache data for ASIN ${candidate.asin}.`
  const body = bullets.map((bullet) => `- ${bullet}`).join("\n")
  return `${intro}\n\n${body}`.slice(0, 4000)
}

export function generateListing(
  candidate: AiGenerationCandidateRow
): GeneratedListingContent {
  const bullets = buildBullets(candidate)

  return {
    title: buildTitle(candidate),
    description: buildDescription(candidate, bullets),
    bullets
  }
}

async function processCandidate(
  client: TxClient,
  candidate: AiGenerationCandidateRow
): Promise<AiGenerationResultRow> {
  try {
    const listing = generateListing(candidate)

    await upsertAiListingCache(
      client,
      candidate.workspaceId,
      candidate.asinRegistryId,
      listing
    )

    await markPoolAiSuccess(client, candidate.poolId)

    return {
      poolId: candidate.poolId,
      asinRegistryId: candidate.asinRegistryId,
      asin: candidate.asin,
      title: listing.title,
      description: listing.description,
      bullets: listing.bullets,
      aiStatus: "success",
      pipelineStage: "ai_generated"
    }
  } catch (error) {
    await markPoolAiFailed(client, candidate.poolId)

    return {
      poolId: candidate.poolId,
      asinRegistryId: candidate.asinRegistryId,
      asin: candidate.asin,
      title: "",
      description: "",
      bullets: [],
      aiStatus: "failed",
      pipelineStage: "scraped"
    }
  }
}

export async function runAiListingGeneration(
  workspaceId: string,
  limit = 100
): Promise<AiGenerationResult> {
  const candidates = await getAiGenerationCandidates(workspaceId, limit)

  if (candidates.length === 0) {
    return {
      processedCount: 0,
      rows: []
    }
  }

  const client = (await db.connect()) as TxClient

  try {
    await client.query("BEGIN")

    const rows: AiGenerationResultRow[] = []

    for (const candidate of candidates) {
      const resultRow = await processCandidate(client, candidate)
      rows.push(resultRow)
    }

    await client.query("COMMIT")

    return {
      processedCount: rows.length,
      rows
    }
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}
import { db } from "../../db/client"
import {
  getPendingScrapeCandidates,
  markPoolAsScraped,
  updateAsinRegistryMetadata,
  upsertAmazonProductCache
} from "./scrapeRepository"
import type {
  FakeScrapedData,
  PendingScrapeCandidateRow,
  ScrapeSimulationResult,
  ScrapeSimulationResultRow
} from "./scraperTypes"

type TxClient = {
  query: <T = unknown>(text: string, params?: unknown[]) => Promise<{ rows: T[]; rowCount: number | null }>
  release: () => void
}

function buildFakeBrand(asin: string): string {
  return `Brand-${asin.slice(0, 4)}`
}

function buildFakeTitle(asin: string): string {
  return `Simulated Amazon Product for ${asin}`
}

function buildFakePrice(asin: string): number {
  const seed = asin
    .split("")
    .reduce((sum, char) => sum + char.charCodeAt(0), 0)

  const base = 19 + (seed % 80)
  const cents = ((seed % 9) + 1) / 10

  return Number((base + cents).toFixed(2))
}

function buildFakeImages(asin: string): string[] {
  return [
    `https://example.com/images/${asin}-1.jpg`,
    `https://example.com/images/${asin}-2.jpg`,
    `https://example.com/images/${asin}-3.jpg`
  ]
}

function buildFakeAttributes(asin: string): Record<string, string> {
  return {
    asin,
    color: "Black",
    material: "ABS",
    pack_size: "1 Pack",
    source: "simulation"
  }
}

export function generateFakeScrapedData(candidate: Pick<PendingScrapeCandidateRow, "asin">): FakeScrapedData {
  return {
    title: buildFakeTitle(candidate.asin),
    brand: buildFakeBrand(candidate.asin),
    price: buildFakePrice(candidate.asin),
    images: buildFakeImages(candidate.asin),
    attributes: buildFakeAttributes(candidate.asin)
  }
}

async function processCandidate(
  client: TxClient,
  candidate: PendingScrapeCandidateRow
): Promise<ScrapeSimulationResultRow> {
  const fakeData = generateFakeScrapedData(candidate)

  await upsertAmazonProductCache(client, candidate.asinRegistryId, fakeData)
  await updateAsinRegistryMetadata(client, candidate.asinRegistryId, fakeData)
  await markPoolAsScraped(client, candidate.poolId)

  return {
    poolId: candidate.poolId,
    asinRegistryId: candidate.asinRegistryId,
    asin: candidate.asin,
    title: fakeData.title,
    brand: fakeData.brand,
    price: fakeData.price,
    scrapeStatus: "success",
    pipelineStage: "scraped"
  }
}

export async function runAmazonScraperSimulation(
  workspaceId: string,
  limit = 100
): Promise<ScrapeSimulationResult> {
  const candidates = await getPendingScrapeCandidates(workspaceId, limit)

  if (candidates.length === 0) {
    return {
      processedCount: 0,
      rows: []
    }
  }

  const client = (await db.connect()) as TxClient

  try {
    await client.query("BEGIN")

    const rows: ScrapeSimulationResultRow[] = []

    for (const candidate of candidates) {
      const row = await processCandidate(client, candidate)
      rows.push(row)
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
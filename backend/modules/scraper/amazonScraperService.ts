import { db, query } from "../../db/client"
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

type SinglePoolScrapeRow = {
  poolId:         number
  asinRegistryId: number
  asin:           string
  registryTitle:  string | null
  registryBrand:  string | null
  pipelineStage:  string
  scrapeStatus:   string
}

export type ScrapeSinglePoolResult = {
  ok:               boolean
  createdOrUpdated: boolean
  message?:         string
}

export type ScrapeSinglePoolOptions = {
  /** Live runner: only fill cache; do not change asin_pool pipeline/scrape_status. */
  preservePoolStage?: boolean
}

function isRealAmazonCacheRow(row: {
  source:     string | null
  images:     unknown
  attributes: unknown
}): boolean {
  if (row.source === "amazon") return true
  const attrs = row.attributes as Record<string, unknown> | null
  if (attrs?.source === "simulation") return false
  const images = Array.isArray(row.images) ? row.images : []
  return images.some(
    (u) => typeof u === "string" && /amazon|media-amazon|ssl-images-amazon/i.test(u)
  )
}

/** Worker scrape path for one pool item — creates amazon_product_cache when missing. */
export async function scrapeSinglePoolItemById(
  workspaceId: string,
  poolId:      number,
  opts:        ScrapeSinglePoolOptions = {}
): Promise<ScrapeSinglePoolResult> {
  const result = await query<SinglePoolScrapeRow>(
    `SELECT
       ap.id AS "poolId",
       ap.asin_registry_id AS "asinRegistryId",
       ar.asin AS "asin",
       ar.title AS "registryTitle",
       ar.brand AS "registryBrand",
       ap.pipeline_stage::text AS "pipelineStage",
       ap.scrape_status::text AS "scrapeStatus"
     FROM asin_pool ap
     INNER JOIN asin_registry ar ON ar.id = ap.asin_registry_id
     WHERE ap.workspace_id = $1 AND ap.id = $2
     LIMIT 1`,
    [workspaceId, poolId]
  )

  const row = result.rows[0]
  if (!row) {
    return { ok: false, createdOrUpdated: false, message: "Pool item not found" }
  }

  const cacheCheck = await query<{
    title:       string | null
    brand:       string | null
    price:      number | null
    images:     unknown
    source:     string | null
    attributes: unknown
  }>(
    `SELECT title, brand, price, images, source, attributes
     FROM amazon_product_cache
     WHERE asin_registry_id = $1
     LIMIT 1`,
    [row.asinRegistryId]
  )

  const existing = cacheCheck.rows[0]
  const existingAttributes = existing?.attributes && typeof existing.attributes === "object"
    ? existing.attributes as Record<string, unknown>
    : null
  const existingIsExtension = !!existing && (
    existing.source === "extension" || existingAttributes?.source === "extension"
  )
  const images = Array.isArray(existing?.images) ? existing.images : []
  if (existing && Number(existing.price) > 0 && images.length > 0) {
    if (isRealAmazonCacheRow(existing)) {
      return { ok: true, createdOrUpdated: false, message: "Extension Amazon cache already present" }
    }
    if (opts.preservePoolStage) {
      return { ok: true, createdOrUpdated: false, message: "Cache already present" }
    }
  }

  const client = (await db.connect()) as TxClient
  try {
    await client.query("BEGIN")

    const fakeData = generateFakeScrapedData({ asin: row.asin })
    if (row.registryTitle?.trim()) fakeData.title = row.registryTitle.trim().slice(0, 200)
    if (row.registryBrand?.trim()) fakeData.brand = row.registryBrand.trim()

    // Simulation may fill missing images, but must not replace identity/pricing
    // already captured from the extension.
    if (existingIsExtension) {
      if (existing?.title?.trim()) fakeData.title = existing.title.trim().slice(0, 200)
      if (existing?.brand?.trim()) fakeData.brand = existing.brand.trim()
      if (existing?.price != null && Number(existing.price) > 0) fakeData.price = Number(existing.price)
    }

    await upsertAmazonProductCache(client, row.asinRegistryId, fakeData)
    await updateAsinRegistryMetadata(client, row.asinRegistryId, fakeData)

    if (!opts.preservePoolStage) {
      if (row.pipelineStage === "validated" || row.scrapeStatus === "pending") {
        await markPoolAsScraped(client, row.poolId)
      } else {
        await client.query(
          `UPDATE asin_pool
           SET scrape_status = 'success',
               updated_at = NOW()
           WHERE id = $1`,
          [row.poolId]
        )
      }
    }

    await client.query("COMMIT")
    return { ok: true, createdOrUpdated: true, message: "Amazon product cache prepared" }
  } catch (e) {
    await client.query("ROLLBACK")
    return {
      ok: false,
      createdOrUpdated: false,
      message: e instanceof Error ? e.message : String(e),
    }
  } finally {
    client.release()
  }
}
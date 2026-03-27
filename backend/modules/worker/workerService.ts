// ─────────────────────────────────────────────────────────────
// workerService.ts
//
// Pipeline:
//   1. Scheduler summary → kaç scrape/ai/publish adayı var
//   2. scrape stage  → runAmazonScraperSimulation()
//   3. ai stage      → runAiListingGeneration()
//   4. publish stage → buildEbayListingPayloads()
//                      + runInventoryFlowBatch()
//                      + persistPublishResults()
// ─────────────────────────────────────────────────────────────

import { randomUUID } from "crypto"
import { getSchedulerSummary }       from "../scheduler/schedulerService"
import { runAmazonScraperSimulation } from "../scraper/amazonScraperService"
import { runAiListingGeneration }     from "../ai/aiListingService"
import { buildEbayListingPayloads }   from "../ebay/ebayPayloadService"
import { runInventoryFlowBatch }      from "../ebay/ebayInventoryService"
import {
  persistPublishResults,
  zipPayloadsAndResults
} from "../ebay/ebayPublishPersistenceService"
import { releaseAllLocksForWorker } from "./workerRepository"
import type { WorkerRunResult, WorkerStageResult } from "./workerTypes"

// ─── WORKER OPTIONS ───────────────────────────────────────────

export type WorkerRunOptions = {
  scrapeLimit?:    number
  aiLimit?:        number
  publishLimit?:   number
  publishDelayMs?: number
  ebayOauthToken?: string
  ebaySandbox?:    boolean
  simulationMode?: boolean
}

const DEFAULTS: Required<WorkerRunOptions> = {
  scrapeLimit:    100,
  aiLimit:        100,
  publishLimit:   20,
  publishDelayMs: 1000,
  ebayOauthToken: "SIM_TOKEN",
  ebaySandbox:    true,
  simulationMode: true
}

function emptyStage(stage: WorkerStageResult["stage"]): WorkerStageResult {
  return { stage, attempted: 0, succeeded: 0, failed: 0, skipped: 0, durationMs: 0 }
}

// ─── STAGE 1: SCRAPE ──────────────────────────────────────────
// runAmazonScraperSimulation(workspaceId, limit)
//   → { processedCount: number, rows: ScrapeSimulationResultRow[] }
//   ScrapeSimulationResultRow.scrapeStatus: "success" | "failed"

async function runScrapeStage(
  workspaceId: string,
  opts: Required<WorkerRunOptions>
): Promise<WorkerStageResult> {
  const t0 = Date.now()
  console.log(`[Worker] Stage: SCRAPE | limit=${opts.scrapeLimit}`)

  try {
    const result = await runAmazonScraperSimulation(workspaceId, opts.scrapeLimit)

    const succeeded = result.rows.filter(r => r.scrapeStatus === "success").length
    const failed    = result.rows.filter(r => r.scrapeStatus !== "success").length

    console.log(
      `[Worker] SCRAPE done | ` +
      `processed=${result.processedCount} succeeded=${succeeded} failed=${failed}`
    )

    return {
      stage:      "scrape",
      attempted:  result.processedCount,
      succeeded,
      failed,
      skipped:    0,
      durationMs: Date.now() - t0
    }
  } catch (err) {
    console.error("[Worker] SCRAPE stage error:", err instanceof Error ? err.message : err)
    return { ...emptyStage("scrape"), durationMs: Date.now() - t0 }
  }
}

// ─── STAGE 2: AI ──────────────────────────────────────────────
// runAiListingGeneration(workspaceId, limit)
//   → { processedCount: number, rows: AiGenerationResultRow[] }
//   AiGenerationResultRow.aiStatus: "success" | "failed"

async function runAiStage(
  workspaceId: string,
  opts: Required<WorkerRunOptions>
): Promise<WorkerStageResult> {
  const t0 = Date.now()
  console.log(`[Worker] Stage: AI | limit=${opts.aiLimit}`)

  try {
    const result = await runAiListingGeneration(workspaceId, opts.aiLimit)

    const succeeded = result.rows.filter(r => r.aiStatus === "success").length
    const failed    = result.rows.filter(r => r.aiStatus === "failed").length

    console.log(
      `[Worker] AI done | ` +
      `processed=${result.processedCount} succeeded=${succeeded} failed=${failed}`
    )

    return {
      stage:      "ai",
      attempted:  result.processedCount,
      succeeded,
      failed,
      skipped:    0,
      durationMs: Date.now() - t0
    }
  } catch (err) {
    console.error("[Worker] AI stage error:", err instanceof Error ? err.message : err)
    return { ...emptyStage("ai"), durationMs: Date.now() - t0 }
  }
}

// ─── STAGE 3: PUBLISH ─────────────────────────────────────────
// buildEbayListingPayloads(workspaceId, limit)
//   → EbayListingPayload[]
// runInventoryFlowBatch(payloads, clientConfig, batchOpts)
//   → { total, failed, results: InventoryFlowResult[] }
// persistPublishResults(inputs)
//   → { total, succeeded, failed, rows }

async function runPublishStage(
  workspaceId: string,
  opts: Required<WorkerRunOptions>
): Promise<WorkerStageResult> {
  const t0 = Date.now()
  console.log(`[Worker] Stage: PUBLISH | limit=${opts.publishLimit}`)

  try {
    const payloads = await buildEbayListingPayloads(workspaceId, opts.publishLimit)

    if (payloads.length === 0) {
      console.log("[Worker] PUBLISH: no payloads found")
      return emptyStage("publish")
    }

    const batchResult = await runInventoryFlowBatch(
      payloads,
      {
        sandbox:        opts.ebaySandbox,
        simulationMode: opts.simulationMode,
      },
      { delayBetweenMs: opts.publishDelayMs }
    )

    const successfulResults = batchResult.results.filter(
      r =>
        r.inventoryItemStatus !== "FAILED" &&
        r.inventoryItemStatus !== "failed" &&
        r.offerStatus         !== "FAILED" &&
        r.offerStatus         !== "failed" &&
        r.publishStatus       !== "FAILED" &&
        r.publishStatus       !== "failed"
    )

    const inputs        = zipPayloadsAndResults(payloads, successfulResults)
    const persistResult = await persistPublishResults(inputs)

    console.log(
      `[Worker] PUBLISH done | ` +
      `attempted=${batchResult.total} ` +
      `succeeded=${persistResult.succeeded} ` +
      `failed=${batchResult.failed + persistResult.failed}`
    )

    return {
      stage:      "publish",
      attempted:  batchResult.total,
      succeeded:  persistResult.succeeded,
      failed:     batchResult.failed + persistResult.failed,
      skipped:    0,
      durationMs: Date.now() - t0
    }
  } catch (err) {
    console.error("[Worker] PUBLISH stage error:", err instanceof Error ? err.message : err)
    return { ...emptyStage("publish"), durationMs: Date.now() - t0 }
  }
}

// ─── MAIN WORKER RUN ──────────────────────────────────────────

export async function runWorker(
  workspaceId: string,
  options: WorkerRunOptions = {}
): Promise<WorkerRunResult> {
  const opts      = { ...DEFAULTS, ...options }
  const workerId  = `worker-${randomUUID().slice(0, 8)}`
  const startedAt = new Date().toISOString()
  const t0        = Date.now()

  console.log(`[Worker] Starting | id=${workerId} | workspace=${workspaceId}`)

  const summary = await getSchedulerSummary(workspaceId)

  console.log(
    `[Worker] Queue snapshot | ` +
    `scrape=${summary.counts.scrapeQueueCount} ` +
    `ai=${summary.counts.aiQueueCount} ` +
    `publish=${summary.counts.publishQueueCount}`
  )

  const scrapeResult = summary.counts.scrapeQueueCount > 0
    ? await runScrapeStage(workspaceId, opts)
    : emptyStage("scrape")

  const aiResult = summary.counts.aiQueueCount > 0
    ? await runAiStage(workspaceId, opts)
    : emptyStage("ai")

  const publishResult = summary.counts.publishQueueCount > 0
    ? await runPublishStage(workspaceId, opts)
    : emptyStage("publish")

  await releaseAllLocksForWorker(workspaceId)

  const completedAt = new Date().toISOString()

  console.log(
    `[Worker] Done | id=${workerId} | ` +
    `scrape=${scrapeResult.succeeded}/${scrapeResult.attempted} ` +
    `ai=${aiResult.succeeded}/${aiResult.attempted} ` +
    `publish=${publishResult.succeeded}/${publishResult.attempted}`
  )

  return {
    workspaceId,
    startedAt,
    completedAt,
    totalDurationMs: Date.now() - t0,
    stages:  [scrapeResult, aiResult, publishResult],
    scrape:  scrapeResult,
    ai:      aiResult,
    publish: publishResult
  }
}

// ─────────────────────────────────────────────────────────────
// schedulerService.ts
//
// Orchestration summary üretir — gerçek execution yapmaz.
// Sonraki aşamada her queue kendi runner'ına bağlanacak:
//   scrapeQueue()    ← amazonScraperService
//   runAiQueue()     ← aiListingService
//   runInventoryFlowBatch() + persistPublishResults() ← ebay pipeline
// ─────────────────────────────────────────────────────────────

import {
  fetchScrapeCandiates,
  fetchAiCandidates,
  fetchPublishCandidates,
  fetchQueueCountsOnly
} from "./schedulerRepository"
import type {
  ExecutionPlan,
  QueueCounts,
  SchedulerCandidate,
  SchedulerSummary
} from "./schedulerTypes"

const CANDIDATE_PREVIEW_LIMIT = 20   // her aşama için önizleme limiti

// ─── QUEUE COUNTS ─────────────────────────────────────────────

export async function getQueueCounts(workspaceId: string): Promise<QueueCounts> {
  const raw = await fetchQueueCountsOnly(workspaceId)
  return {
    scrapeQueueCount:  raw.scrape,
    aiQueueCount:      raw.ai,
    publishQueueCount: raw.publish,
    total:             raw.scrape + raw.ai + raw.publish
  }
}

// ─── EXECUTION PLAN ───────────────────────────────────────────

function buildExecutionPlan(
  workspaceId: string,
  counts: QueueCounts
): ExecutionPlan {
  return {
    workspaceId,
    scrapeQueueCount:  counts.scrapeQueueCount,
    aiQueueCount:      counts.aiQueueCount,
    publishQueueCount: counts.publishQueueCount,
    totalQueued:       counts.total,
    generatedAt:       new Date().toISOString()
  }
}

// ─── FULL SUMMARY ─────────────────────────────────────────────

export async function getSchedulerSummary(
  workspaceId: string
): Promise<SchedulerSummary> {
  console.log(`[Scheduler] Building summary for workspace=${workspaceId}`)

  // Paralel çek — sayılar + aday listeleri
  const [counts, scrapeCandidates, aiCandidates, publishCandidates] =
    await Promise.all([
      getQueueCounts(workspaceId),
      fetchScrapeCandiates(workspaceId,  CANDIDATE_PREVIEW_LIMIT),
      fetchAiCandidates(workspaceId,     CANDIDATE_PREVIEW_LIMIT),
      fetchPublishCandidates(workspaceId, CANDIDATE_PREVIEW_LIMIT)
    ])

  const allCandidates: SchedulerCandidate[] = [
    ...scrapeCandidates,
    ...aiCandidates,
    ...publishCandidates
  ]

  const plan = buildExecutionPlan(workspaceId, counts)

  console.log(
    `[Scheduler] Summary ready | ` +
    `scrape=${counts.scrapeQueueCount} ` +
    `ai=${counts.aiQueueCount} ` +
    `publish=${counts.publishQueueCount} ` +
    `total=${counts.total}`
  )

  return {
    workspaceId,
    counts,
    plan,
    candidates: allCandidates,
    summaryAt:  new Date().toISOString()
  }
}

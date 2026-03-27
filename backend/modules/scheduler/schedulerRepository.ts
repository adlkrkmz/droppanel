// ─────────────────────────────────────────────────────────────
// schedulerRepository.ts
// Scheduler aday sorgular — DB okuma katmanı
// ─────────────────────────────────────────────────────────────

import { query } from "../../db/client"
import type { SchedulerCandidate } from "./schedulerTypes"

// ─── SCRAPE ADAYLARI ──────────────────────────────────────────
// status='ready' AND pipeline_stage='validated' AND scrape_status='pending'

export async function fetchScrapeCandiates(
  workspaceId: string,
  limit: number
): Promise<SchedulerCandidate[]> {
  const result = await query<{
    pool_id:          number
    asin:             string
    priority:         number
    assigned_store_id: number | null
  }>(
    `SELECT
       ap.id           AS pool_id,
       ar.asin,
       ap.priority,
       ap.assigned_store_id
     FROM asin_pool ap
     INNER JOIN asin_registry ar ON ar.id = ap.asin_registry_id
     WHERE ap.workspace_id   = $1
       AND ap.status         = 'ready'
       AND ap.pipeline_stage = 'validated'
       AND ap.scrape_status  = 'pending'
     ORDER BY ap.priority DESC, ap.id ASC
     LIMIT $2`,
    [workspaceId, limit]
  )

  return result.rows.map(r => ({
    poolId:          r.pool_id,
    asin:            r.asin,
    stage:           "scrape" as const,
    priority:        r.priority,
    assignedStoreId: r.assigned_store_id
  }))
}

// ─── AI ADAYLARI ──────────────────────────────────────────────
// status='ready' AND pipeline_stage='scraped' AND ai_status='pending'

export async function fetchAiCandidates(
  workspaceId: string,
  limit: number
): Promise<SchedulerCandidate[]> {
  const result = await query<{
    pool_id:           number
    asin:              string
    priority:          number
    assigned_store_id: number | null
  }>(
    `SELECT
       ap.id           AS pool_id,
       ar.asin,
       ap.priority,
       ap.assigned_store_id
     FROM asin_pool ap
     INNER JOIN asin_registry ar ON ar.id = ap.asin_registry_id
     WHERE ap.workspace_id   = $1
       AND ap.status         = 'ready'
       AND ap.pipeline_stage = 'scraped'
       AND ap.ai_status      = 'pending'
     ORDER BY ap.priority DESC, ap.id ASC
     LIMIT $2`,
    [workspaceId, limit]
  )

  return result.rows.map(r => ({
    poolId:          r.pool_id,
    asin:            r.asin,
    stage:           "ai" as const,
    priority:        r.priority,
    assignedStoreId: r.assigned_store_id
  }))
}

// ─── PUBLISH ADAYLARI ─────────────────────────────────────────
// status='ready' AND pipeline_stage='ai_generated' AND assigned_store_id IS NOT NULL

export async function fetchPublishCandidates(
  workspaceId: string,
  limit: number
): Promise<SchedulerCandidate[]> {
  const result = await query<{
    pool_id:           number
    asin:              string
    priority:          number
    assigned_store_id: number
  }>(
    `SELECT
       ap.id                AS pool_id,
       ar.asin,
       ap.priority,
       ap.assigned_store_id
     FROM asin_pool ap
     INNER JOIN asin_registry ar ON ar.id = ap.asin_registry_id
     WHERE ap.workspace_id      = $1
       AND ap.status            = 'ready'
       AND ap.pipeline_stage    = 'ai_generated'
       AND ap.assigned_store_id IS NOT NULL
     ORDER BY ap.priority DESC, ap.id ASC
     LIMIT $2`,
    [workspaceId, limit]
  )

  return result.rows.map(r => ({
    poolId:          r.pool_id,
    asin:            r.asin,
    stage:           "publish" as const,
    priority:        r.priority,
    assignedStoreId: r.assigned_store_id
  }))
}

// ─── TOPLAM SAYILAR (COUNT — limit olmadan) ───────────────────

export async function fetchQueueCountsOnly(workspaceId: string): Promise<{
  scrape:  number
  ai:      number
  publish: number
}> {
  const result = await query<{
    scrape:  string
    ai:      string
    publish: string
  }>(
    `SELECT
       COUNT(*) FILTER (
         WHERE status = 'ready'
           AND pipeline_stage = 'validated'
           AND scrape_status  = 'pending'
       ) AS scrape,

       COUNT(*) FILTER (
         WHERE status         = 'ready'
           AND pipeline_stage = 'scraped'
           AND ai_status      = 'pending'
       ) AS ai,

       COUNT(*) FILTER (
         WHERE status              = 'ready'
           AND pipeline_stage      = 'ai_generated'
           AND assigned_store_id   IS NOT NULL
       ) AS publish

     FROM asin_pool
     WHERE workspace_id = $1`,
    [workspaceId]
  )

  const row = result.rows[0]
  return {
    scrape:  parseInt(row?.scrape  ?? "0", 10),
    ai:      parseInt(row?.ai      ?? "0", 10),
    publish: parseInt(row?.publish ?? "0", 10)
  }
}

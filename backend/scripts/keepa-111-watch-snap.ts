import "dotenv/config"
import { query } from "../db/client"
import { loadKeepaCollectorReconcileCheckpoint } from "../modules/keepaSensor/keepaCollectorSnapshot"
import { computeKeepaReconcileManifest } from "../modules/keepaSensor/keepaCollectorReconcile"

async function snap(label: string) {
  const outbox = await query<{ status: string; c: string }>(
    `SELECT status, COUNT(*)::text AS c FROM keepa_asin_sync_outbox GROUP BY status ORDER BY status`
  )
  const totals = await query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM keepa_asin_sync_outbox`)
  const dups = await query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM (
       SELECT asin, event_type, payload_fingerprint
       FROM keepa_asin_sync_outbox
       GROUP BY 1,2,3
       HAVING COUNT(*) > 1
     ) d`
  )
  const ver = await query<{ regressions: string; maxv: string; minv: string }>(
    `SELECT COUNT(*) FILTER (WHERE source_version < 1)::text AS regressions,
            COALESCE(MAX(source_version),0)::text AS maxv,
            COALESCE(MIN(source_version),0)::text AS minv
     FROM keepa_asin_sync_state`
  )
  const checkpoint = await loadKeepaCollectorReconcileCheckpoint()
  const manifest = computeKeepaReconcileManifest(checkpoint.rows)
  const tel = await query<{
    collector_id: string
    collected_at: Date
    payload: Record<string, unknown>
  }>(
    `SELECT collector_id, collected_at, payload
     FROM keepa_collector_host_telemetry
     ORDER BY collected_at DESC
     LIMIT 3`
  )
  const createdSince = process.env.KEEPA_SNAP_SINCE
    ? await query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM keepa_asin_sync_outbox WHERE created_at >= $1::timestamptz`,
        [process.env.KEEPA_SNAP_SINCE]
      )
    : null
  const out: Record<string, string> = {}
  for (const r of outbox.rows) out[r.status] = r.c
  const t0 = tel.rows[0]
  const p = (t0?.payload ?? {}) as Record<string, unknown>
  console.log(
    JSON.stringify({
      label,
      at: new Date().toISOString(),
      outboxTotal: Number(totals.rows[0]?.c ?? 0),
      outboxByStatus: out,
      duplicateFingerprints: Number(dups.rows[0]?.c ?? 0),
      sourceVersionMin: Number(ver.rows[0]?.minv ?? 0),
      sourceVersionMax: Number(ver.rows[0]?.maxv ?? 0),
      sourceVersionBelowOne: Number(ver.rows[0]?.regressions ?? 0),
      projectionCount: manifest.uniqueAsins,
      projectionHash: manifest.hash,
      projectionSold: manifest.sold,
      projectionStandard: manifest.standard,
      projectionPaused: manifest.pausedQtyZero,
      outboxCreatedSince: createdSince ? Number(createdSince.rows[0]?.c ?? 0) : null,
      telemetry: t0
        ? {
            collectorId: t0.collector_id,
            collectedAt: new Date(t0.collected_at).toISOString(),
            collectorVersion: p.collectorVersion ?? null,
            syncState: p.syncState ?? null,
            reconcileMatched: p.reconcileMatched ?? null,
            localHash: p.localReconcileHash ?? null,
            centralCount: p.centralReconcileCount ?? null,
            localCount: p.localReconcileCount ?? null,
            lastErrorCode: p.lastErrorCode ?? null,
            eventsPulled: p.eventsPulled ?? null,
            eventsAcked: p.eventsAcked ?? null,
            pendingAck: p.pendingAck ?? null,
            dueSold: p.dueSold ?? null,
            dueStandard: p.dueStandard ?? null,
            tokensLeft: p.tokensLeft ?? null,
            lastKeepaBatchSize: p.lastKeepaBatchSize ?? null,
            added: p.added ?? null,
            updated: p.updated ?? null,
            scans15m: p.scans15m ?? null,
          }
        : null,
    })
  )
}

void snap(process.argv[2] || "snap")
  .then(() => process.exit(0))
  .catch(e => {
    console.error("snap_failed", e instanceof Error ? e.message : e)
    process.exit(1)
  })

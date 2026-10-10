import type { Request, Response } from "express"
import { query } from "../../db/client"
import { authorizeKeepaCollector } from "./keepaCollectorAuth"
import { loadAmazonScanConfig } from "../amazonScan/amazonScanConfig"
import { keepaDirectMutationsEnabled } from "./keepaDirectMutationGate"
import {
  loadKeepaCollectorReconcileCheckpoint,
  loadKeepaCollectorReconcileRows,
  loadKeepaCollectorSnapshotPage,
  loadKeepaCollectorSnapshotTotals,
  loadKeepaCollectorWatermark,
} from "./keepaCollectorSnapshot"
import { computeKeepaReconcileManifest } from "./keepaCollectorReconcile"
import { KEEPA_COLLECTOR_VERSION } from "./keepaCollectorVersion"
import {
  observationPayloadHasForbiddenFields,
  parseKeepaObservationPayload,
  persistKeepaCollectorObservation,
} from "./keepaObservationEvaluate"
import {
  sanitizeKeepaCollectorTelemetry,
  telemetryContainsForbidden,
} from "./keepaCollectorTelemetry"

function auth(req: Request, res: Response): boolean {
  const decision = authorizeKeepaCollector(
    typeof req.headers.authorization === "string" ? req.headers.authorization : undefined
  )
  if (decision.ok === true) return true
  res.status(decision.status).json({ ok: false, error: decision.error })
  return false
}

export function registerKeepaCollectorRoutes(app: { get: Function; post: Function }): void {
  app.get("/internal/keepa-collector/heartbeat", async (req: Request, res: Response) => {
    if (!auth(req, res)) return
    res.json({
      ok: true,
      requestId: String(req.headers["x-request-id"] ?? ""),
      protocol: true,
      keepaDirectMutationsEnabled: keepaDirectMutationsEnabled(),
      collectorProcessEnabled: false,
    })
  })

  app.post("/internal/keepa-collector/heartbeat", async (req: Request, res: Response) => {
    if (!auth(req, res)) return
    const body = (req.body ?? {}) as Record<string, unknown>
    if (telemetryContainsForbidden(body)) {
      res.status(400).json({ ok: false, error: "TELEMETRY_FORBIDDEN_FIELD" })
      return
    }
    const telemetry = sanitizeKeepaCollectorTelemetry(body)
    const collectorId = String(telemetry.collectorId ?? "").trim()
    if (!collectorId || !/^[A-Za-z0-9._:-]{1,64}$/.test(collectorId)) {
      res.status(400).json({ ok: false, error: "INVALID_COLLECTOR_ID" })
      return
    }
    const collectedAt = String(telemetry.collectedAt ?? new Date().toISOString())
    await query(
      `INSERT INTO keepa_collector_host_telemetry (
         collector_id, hostname, payload, collected_at, updated_at
       ) VALUES ($1, $2, $3::jsonb, $4::timestamptz, NOW())
       ON CONFLICT (collector_id) DO UPDATE SET
         hostname = EXCLUDED.hostname,
         payload = EXCLUDED.payload,
         collected_at = EXCLUDED.collected_at,
         updated_at = NOW()`,
      [
        collectorId,
        String(telemetry.hostname ?? "").slice(0, 64),
        JSON.stringify(telemetry),
        collectedAt,
      ]
    )
    res.json({ ok: true, upserted: true, mutation: false, collectorVersion: KEEPA_COLLECTOR_VERSION })
  })

  app.get("/internal/keepa-collector/status", async (req: Request, res: Response) => {
    if (!auth(req, res)) return
    const pending = await query<{ c: string; oldest: Date | null }>(
      `SELECT COUNT(*)::text AS c, MIN(created_at) AS oldest
       FROM keepa_asin_sync_outbox WHERE status = 'PENDING'`
    )
    const rows = await loadKeepaCollectorReconcileRows()
    const manifest = computeKeepaReconcileManifest(rows)
    res.json({
      ok: true,
      pendingEvents: Number(pending.rows[0]?.c ?? 0),
      oldestPendingAt: pending.rows[0]?.oldest ?? null,
      reconcileCount: manifest.uniqueAsins,
      reconcileHash: manifest.hash,
      keepaDirectMutationsEnabled: keepaDirectMutationsEnabled(),
    })
  })

  app.get("/internal/keepa-collector/snapshot", async (req: Request, res: Response) => {
    if (!auth(req, res)) return
    try {
      const cursor = String(req.query.cursor ?? "").trim().toUpperCase()
      const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? "100"), 10) || 100))
      const offsetSeq = Math.max(0, parseInt(String(req.query.offsetSeq ?? "0"), 10) || 0)
      const firstPage = cursor === ""
      const [page, totals, watermark] = await Promise.all([
        loadKeepaCollectorSnapshotPage({ cursorAsin: cursor, limit, offsetSeq }),
        firstPage ? loadKeepaCollectorSnapshotTotals() : Promise.resolve(null),
        firstPage ? loadKeepaCollectorWatermark() : Promise.resolve(null),
      ])
      res.json({
        ok: true,
        items: page.items,
        nextCursor: page.nextCursor,
        offsetSeq: offsetSeq + page.items.length,
        totals,
        watermark,
      })
    } catch (e) {
      console.error("[keepa-collector] snapshot failed:", e instanceof Error ? e.message : e)
      res.status(500).json({ ok: false, error: "SNAPSHOT_QUERY_FAILED" })
    }
  })

  app.get("/internal/keepa-collector/events", async (req: Request, res: Response) => {
    if (!auth(req, res)) return
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? "50"), 10) || 50))
    const after = String(req.query.afterEventId ?? "").trim()
    const sinceCreatedAt = String(req.query.sinceCreatedAt ?? "").trim()
    let rows
    if (sinceCreatedAt) {
      const since = new Date(sinceCreatedAt)
      if (Number.isNaN(since.getTime())) {
        res.status(400).json({ ok: false, error: "INVALID_WATERMARK" })
        return
      }
      rows = await query<{
        event_id: string
        asin: string
        event_type: string
        source_version: string
        payload: unknown
        created_at: Date
      }>(
        after
          ? `SELECT event_id::text, asin, event_type, source_version::text, payload, created_at
             FROM keepa_asin_sync_outbox
             WHERE status = 'PENDING'
               AND created_at >= $1::timestamptz
               AND (created_at > (SELECT created_at FROM keepa_asin_sync_outbox WHERE event_id = $2::uuid)
                    OR (created_at = (SELECT created_at FROM keepa_asin_sync_outbox WHERE event_id = $2::uuid)
                        AND event_id > $2::uuid))
             ORDER BY created_at ASC, event_id ASC
             LIMIT $3::int`
          : `SELECT event_id::text, asin, event_type, source_version::text, payload, created_at
             FROM keepa_asin_sync_outbox
             WHERE status = 'PENDING' AND created_at >= $1::timestamptz
             ORDER BY created_at ASC, event_id ASC
             LIMIT $2::int`,
        after ? [since.toISOString(), after, limit] : [since.toISOString(), limit]
      )
    } else {
      rows = await query<{
        event_id: string
        asin: string
        event_type: string
        source_version: string
        payload: unknown
        created_at: Date
      }>(
        after
          ? `SELECT event_id::text, asin, event_type, source_version::text, payload, created_at
             FROM keepa_asin_sync_outbox
             WHERE status = 'PENDING' AND created_at >= (
               SELECT created_at FROM keepa_asin_sync_outbox WHERE event_id = $1::uuid
             ) AND event_id <> $1::uuid
             ORDER BY created_at ASC, event_id ASC
             LIMIT $2::int`
          : `SELECT event_id::text, asin, event_type, source_version::text, payload, created_at
             FROM keepa_asin_sync_outbox
             WHERE status = 'PENDING'
             ORDER BY created_at ASC, event_id ASC
             LIMIT $1::int`,
        after ? [after, limit] : [limit]
      )
    }
    res.json({
      ok: true,
      requestId: String(req.headers["x-request-id"] ?? ""),
      events: rows.rows.map(r => ({
        eventId: r.event_id,
        asin: r.asin,
        eventType: r.event_type,
        sourceVersion: Number(r.source_version),
        payload: r.payload,
        createdAt: r.created_at,
      })),
    })
  })

  app.post("/internal/keepa-collector/ack", async (req: Request, res: Response) => {
    if (!auth(req, res)) return
    const ids = Array.isArray((req.body ?? {}).eventIds) ? (req.body as { eventIds: unknown[] }).eventIds : []
    const uuids = ids.map(x => String(x)).filter(x => /^[0-9a-f-]{36}$/i.test(x))
    if (uuids.length === 0) {
      res.json({ ok: true, acked: 0, alreadyAcked: 0 })
      return
    }
    const r = await query(
      `UPDATE keepa_asin_sync_outbox
       SET status = 'DELIVERED', delivered_at = NOW()
       WHERE event_id = ANY($1::uuid[]) AND status = 'PENDING'`,
      [uuids]
    )
    const already = await query<{ c: string }>(
      `SELECT COUNT(*)::text AS c
       FROM keepa_asin_sync_outbox
       WHERE event_id = ANY($1::uuid[])
         AND status IN ('DELIVERED', 'COVERED_BY_SNAPSHOT')`,
      [uuids]
    )
    res.json({
      ok: true,
      acked: r.rowCount ?? 0,
      alreadyAcked: Number(already.rows[0]?.c ?? 0),
    })
  })

  app.get("/internal/keepa-collector/reconcile", async (req: Request, res: Response) => {
    if (!auth(req, res)) return
    const checkpoint = await loadKeepaCollectorReconcileCheckpoint()
    const manifest = computeKeepaReconcileManifest(checkpoint.rows)
    res.json({
      ok: true,
      count: manifest.uniqueAsins,
      hash: manifest.hash,
      active: manifest.active,
      pausedQtyZero: manifest.pausedQtyZero,
      sold: manifest.sold,
      standard: manifest.standard,
      duplicates: manifest.duplicates,
      sourceVersionRegressions: manifest.sourceVersionRegressions,
      eventHighWatermarkCreatedAt: checkpoint.eventHighWatermarkCreatedAt,
      eventHighWatermarkId: checkpoint.eventHighWatermarkId,
      generatedAt: checkpoint.generatedAt,
    })
  })

  app.post("/internal/keepa-collector/bootstrap-complete", async (req: Request, res: Response) => {
    if (!auth(req, res)) return
    const body = (req.body ?? {}) as Record<string, unknown>
    const snapshotStartedAt = String(body.snapshotStartedAt ?? "").trim()
    const localHash = String(body.localHash ?? "").trim()
    const localCount = Number(body.localCount)
    if (!snapshotStartedAt || !localHash || !Number.isFinite(localCount)) {
      res.status(400).json({ ok: false, error: "INVALID_BOOTSTRAP_COMPLETE" })
      return
    }
    const started = new Date(snapshotStartedAt)
    if (Number.isNaN(started.getTime())) {
      res.status(400).json({ ok: false, error: "INVALID_WATERMARK" })
      return
    }
    const requestId =
      typeof body.requestId === "string" && body.requestId.trim()
        ? body.requestId.trim()
        : String(req.headers["x-request-id"] ?? "")
    if (requestId) {
      const prior = await query<{ covered: string; local_hash: string }>(
        `SELECT covered::text, local_hash FROM keepa_collector_bootstrap_receipts WHERE request_id = $1`,
        [requestId]
      )
      if (prior.rows[0] && prior.rows[0].local_hash === localHash) {
        res.json({
          ok: true,
          covered: Number(prior.rows[0].covered),
          collectorVersion: typeof body.collectorVersion === "string" ? body.collectorVersion : KEEPA_COLLECTOR_VERSION,
          requestId,
          mutation: false,
          idempotent: true,
        })
        return
      }
    }
    const checkpoint = await loadKeepaCollectorReconcileCheckpoint()
    const manifest = computeKeepaReconcileManifest(checkpoint.rows)
    if (manifest.hash !== localHash || manifest.uniqueAsins !== localCount || manifest.duplicates > 0) {
      res.status(409).json({
        ok: false,
        error: "RECONCILE_MISMATCH",
        count: manifest.uniqueAsins,
        hash: manifest.hash,
      })
      return
    }
    if (manifest.sourceVersionRegressions > 0) {
      res.status(409).json({ ok: false, error: "RECONCILE_MISMATCH", count: manifest.uniqueAsins, hash: manifest.hash })
      return
    }
    const covered = await query(
      `UPDATE keepa_asin_sync_outbox
       SET status = 'COVERED_BY_SNAPSHOT',
           covered_reason = 'COVERED_BY_SNAPSHOT',
           bootstrap_watermark = $1::timestamptz,
           delivered_at = COALESCE(delivered_at, NOW())
       WHERE status = 'PENDING'
         AND created_at < $1::timestamptz`,
      [started.toISOString()]
    )
    if (requestId) {
      await query(
        `INSERT INTO keepa_collector_bootstrap_receipts (request_id, snapshot_started_at, local_hash, local_count, covered)
         VALUES ($1, $2::timestamptz, $3, $4, $5)
         ON CONFLICT (request_id) DO NOTHING`,
        [requestId, started.toISOString(), localHash, localCount, covered.rowCount ?? 0]
      )
    }
    res.json({
      ok: true,
      covered: covered.rowCount ?? 0,
      collectorVersion: typeof body.collectorVersion === "string" ? body.collectorVersion : KEEPA_COLLECTOR_VERSION,
      requestId,
      mutation: false,
    })
  })

  app.post("/internal/keepa-collector/repair-complete", async (req: Request, res: Response) => {
    if (!auth(req, res)) return
    const body = (req.body ?? {}) as Record<string, unknown>
    const requestId = typeof body.requestId === "string" ? body.requestId.trim() : ""
    const snapshotStartedAt = String(body.snapshotStartedAt ?? "").trim()
    const finalHash = String(body.finalHash ?? "").trim()
    const finalCount = Number(body.finalCount)
    if (!requestId || !snapshotStartedAt || !finalHash || !Number.isFinite(finalCount)) {
      res.status(400).json({ ok: false, error: "INVALID_REPAIR_COMPLETE" })
      return
    }
    const started = new Date(snapshotStartedAt)
    if (Number.isNaN(started.getTime())) {
      res.status(400).json({ ok: false, error: "INVALID_WATERMARK" })
      return
    }
    const prior = await query<{ final_hash: string; final_count: string }>(
      `SELECT final_hash, final_count::text FROM keepa_collector_repair_receipts WHERE request_id = $1`,
      [requestId]
    )
    if (prior.rows[0]) {
      res.json({
        ok: true,
        idempotent: true,
        mutation: false,
        requestId,
        collectorVersion: typeof body.collectorVersion === "string" ? body.collectorVersion : KEEPA_COLLECTOR_VERSION,
      })
      return
    }
    const checkpoint = await loadKeepaCollectorReconcileCheckpoint()
    const manifest = computeKeepaReconcileManifest(checkpoint.rows)
    if (manifest.hash !== finalHash || manifest.uniqueAsins !== finalCount || manifest.duplicates > 0) {
      res.status(409).json({
        ok: false,
        error: "RECONCILE_MISMATCH",
        count: manifest.uniqueAsins,
        hash: manifest.hash,
      })
      return
    }
    await query(
      `INSERT INTO keepa_collector_repair_receipts (
         request_id, collector_id, collector_version, snapshot_started_at,
         final_count, final_hash, added, updated, paused, removed, preserved
       ) VALUES ($1, $2, $3, $4::timestamptz, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (request_id) DO NOTHING`,
      [
        requestId,
        String(body.collectorId ?? "").slice(0, 64),
        typeof body.collectorVersion === "string" ? body.collectorVersion : KEEPA_COLLECTOR_VERSION,
        started.toISOString(),
        finalCount,
        finalHash,
        Number(body.added) || 0,
        Number(body.updated) || 0,
        Number(body.paused) || 0,
        Number(body.removed) || 0,
        Number(body.preserved) || 0,
      ]
    )
    res.json({
      ok: true,
      mutation: false,
      requestId,
      collectorVersion: typeof body.collectorVersion === "string" ? body.collectorVersion : KEEPA_COLLECTOR_VERSION,
    })
  })

  app.post("/internal/keepa-collector/observations", async (req: Request, res: Response) => {
    if (!auth(req, res)) return
    const body = (req.body ?? {}) as Record<string, unknown>
    if (observationPayloadHasForbiddenFields(body)) {
      res.status(400).json({ ok: false, error: "OBSERVATION_FORBIDDEN_FIELD", mutation: false })
      return
    }
    const payload = parseKeepaObservationPayload(body)
    if (!payload) {
      res.status(400).json({ ok: false, error: "INVALID_OBSERVATION", mutation: false })
      return
    }
    const result = await persistKeepaCollectorObservation(payload)
    res.json(result)
  })

  app.post("/internal/keepa-collector/candidates", async (req: Request, res: Response) => {
    if (!auth(req, res)) return
    const body = (req.body ?? {}) as Record<string, unknown>
    const asin = String(body.asin ?? "").trim().toUpperCase()
    const fingerprint = String(body.fingerprint ?? "").trim()
    const snapshot = body.snapshot && typeof body.snapshot === "object" ? body.snapshot : null
    if (!/^[A-Z0-9]{10}$/.test(asin) || fingerprint.length < 16 || !snapshot) {
      res.status(400).json({ ok: false, error: "INVALID_CANDIDATE" })
      return
    }
    await query(
      `UPDATE keepa_verify_candidates
       SET status = 'SUPERSEDED', updated_at = NOW()
       WHERE asin = $1 AND status IN ('PENDING','RETRYABLE') AND fingerprint <> $2`,
      [asin, fingerprint]
    )
    const ins = await query<{ id: string }>(
      `INSERT INTO keepa_verify_candidates (asin, fingerprint, snapshot, status)
       VALUES ($1, $2, $3::jsonb, 'PENDING')
       ON CONFLICT (asin, fingerprint) DO NOTHING
       RETURNING id::text`,
      [asin, fingerprint, JSON.stringify(snapshot)]
    )
    const cfg = loadAmazonScanConfig()
    res.json({
      ok: true,
      created: (ins.rowCount ?? 0) > 0,
      enqueueEnabled: cfg.keepaVerifyEnqueueEnabled === true,
      mutation: false,
    })
  })
}

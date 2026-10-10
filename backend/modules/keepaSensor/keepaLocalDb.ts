import { createHash } from "crypto"
import { DatabaseSync } from "node:sqlite"
import { KEEPA_QUEUE_HORIZON_MS, nextScanAtForNewAsin } from "./keepaAsinProjection"
import { computeKeepaReconcileManifest, type KeepaReconcileRow } from "./keepaCollectorReconcile"
import { KEEPA_COLLECTOR_VERSION } from "./keepaCollectorVersion"

export type LocalAsinRow = {
  asin: string
  active_consumer_count: number
  status: string
  priority: string
  cadence_hours: number
  next_scan_at: number
  last_scanned_at?: number | null
  source_version: number
  queue_seq?: number
}

export type BootstrapStatus = "EMPTY" | "IN_PROGRESS" | "COMPLETE" | "FAILED"

export type BootstrapPhase =
  | "EMPTY"
  | "SNAPSHOTTING"
  | "STAGING_EVENTS"
  | "COMMITTED_PENDING_ACK"
  | "FINALIZING"
  | "COMPLETE"
  | "FAILED"

export type RemoteAckStatus = "PENDING_ACK" | "ACKED_REMOTE"

export const BOOTSTRAP_PHASES: BootstrapPhase[] = [
  "EMPTY",
  "SNAPSHOTTING",
  "STAGING_EVENTS",
  "COMMITTED_PENDING_ACK",
  "FINALIZING",
  "COMPLETE",
  "FAILED",
]

export type SnapshotItem = {
  asin: string
  activeConsumerCount: number
  status: string
  priority: string
  cadenceHours: number
  sourceVersion: number
  updatedAt?: string
  queueSeq: number
}

export function openKeepaLocalDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec("PRAGMA busy_timeout = 5000")
  db.exec("PRAGMA journal_mode = WAL")
  db.exec(`
    CREATE TABLE IF NOT EXISTS asin_registry (
      asin TEXT PRIMARY KEY,
      active_consumer_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      priority TEXT NOT NULL,
      cadence_hours INTEGER NOT NULL,
      next_scan_at INTEGER NOT NULL,
      source_version INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS asin_registry_staging (
      asin TEXT PRIMARY KEY,
      active_consumer_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      priority TEXT NOT NULL,
      cadence_hours INTEGER NOT NULL,
      next_scan_at INTEGER NOT NULL,
      source_version INTEGER NOT NULL DEFAULT 0,
      queue_seq INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sync_events (
      event_id TEXT PRIMARY KEY,
      asin TEXT NOT NULL,
      event_type TEXT NOT NULL,
      source_version INTEGER NOT NULL,
      applied_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS keepa_snapshots (
      asin TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS keepa_candidates (
      fingerprint TEXT PRIMARY KEY,
      asin TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS worker_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_asin_registry_due
      ON asin_registry (next_scan_at) WHERE status = 'ACTIVE';
  `)
  ensureColumn(db, "asin_registry", "queue_seq", "INTEGER NOT NULL DEFAULT 0")
  ensureColumn(db, "sync_events", "payload_fingerprint", "TEXT NOT NULL DEFAULT ''")
  ensureColumn(db, "sync_events", "applied_local_at", "INTEGER NOT NULL DEFAULT 0")
  ensureColumn(db, "sync_events", "remote_ack_status", "TEXT NOT NULL DEFAULT 'ACKED_REMOTE'")
  ensureColumn(db, "sync_events", "remote_ack_attempts", "INTEGER NOT NULL DEFAULT 0")
  ensureColumn(db, "sync_events", "last_ack_error_code", "TEXT NOT NULL DEFAULT ''")
  ensureColumn(db, "sync_events", "last_ack_attempt_at", "INTEGER NOT NULL DEFAULT 0")
  ensureColumn(db, "sync_events", "remote_acked_at", "INTEGER NOT NULL DEFAULT 0")
  ensureColumn(db, "asin_registry", "last_scanned_at", "INTEGER")
  ensureColumn(db, "asin_registry_staging", "last_scanned_at", "INTEGER")
  db.exec(`
    CREATE TABLE IF NOT EXISTS keepa_observation_outbox (
      fingerprint TEXT PRIMARY KEY,
      asin TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      remote_status TEXT NOT NULL DEFAULT 'PENDING',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT NOT NULL DEFAULT '',
      next_attempt_at INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_keepa_observation_outbox_pending
      ON keepa_observation_outbox (created_at) WHERE remote_status = 'PENDING';
    CREATE TABLE IF NOT EXISTS keepa_token_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      collected_at INTEGER NOT NULL,
      tokens_left REAL,
      refill_rate REAL,
      refill_in REAL,
      tokens_consumed REAL,
      token_flow_reduction REAL,
      processing_time_ms INTEGER,
      http_status INTEGER,
      requested INTEGER NOT NULL DEFAULT 0,
      returned INTEGER NOT NULL DEFAULT 0,
      parsed INTEGER NOT NULL DEFAULT 0
    );
  `)
  db.exec("CREATE INDEX IF NOT EXISTS idx_sync_events_pending_ack ON sync_events (remote_ack_status)")
  ensureColumn(db, "keepa_observation_outbox", "next_attempt_at", "INTEGER NOT NULL DEFAULT 0")
  if (!getWorkerState(db, "bootstrap_status")) setWorkerState(db, "bootstrap_status", "EMPTY")
  if (!getWorkerState(db, "bootstrap_phase")) setWorkerState(db, "bootstrap_phase", "EMPTY")
  if (!getWorkerState(db, "collector_version")) setWorkerState(db, "collector_version", KEEPA_COLLECTOR_VERSION)
  return db
}

function tableInfo(db: DatabaseSync, table: string): { name: string }[] {
  return db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
}

function ensureColumn(db: DatabaseSync, table: string, column: string, spec: string): void {
  const cols = tableInfo(db, table)
  if (cols.some(c => c.name === column)) return
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${spec}`)
}

export function getWorkerState(db: DatabaseSync, key: string): string | null {
  const row = db.prepare("SELECT value FROM worker_state WHERE key = ?").get(key) as { value: string } | undefined
  return row?.value ?? null
}

export function setWorkerState(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    "INSERT INTO worker_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value)
}

export function bootstrapStatus(db: DatabaseSync): BootstrapStatus {
  const phase = bootstrapPhase(db)
  if (phase === "COMPLETE") return "COMPLETE"
  if (phase === "FAILED") return "FAILED"
  if (phase === "EMPTY") return "EMPTY"
  return "IN_PROGRESS"
}

export function bootstrapPhase(db: DatabaseSync): BootstrapPhase {
  const status = getWorkerState(db, "bootstrap_status") ?? "EMPTY"
  const raw = getWorkerState(db, "bootstrap_phase") ?? ""
  if (status === "COMPLETE") return "COMPLETE"
  if (status === "FAILED") return "FAILED"
  if ((BOOTSTRAP_PHASES as string[]).includes(raw) && raw !== "EMPTY") return raw as BootstrapPhase
  if (status === "IN_PROGRESS") return "SNAPSHOTTING"
  return "EMPTY"
}

export function setBootstrapPhase(db: DatabaseSync, phase: BootstrapPhase): void {
  setWorkerState(db, "bootstrap_phase", phase)
  if (phase === "COMPLETE") setWorkerState(db, "bootstrap_status", "COMPLETE")
  else if (phase === "FAILED") setWorkerState(db, "bootstrap_status", "FAILED")
  else if (phase === "EMPTY") setWorkerState(db, "bootstrap_status", "EMPTY")
  else setWorkerState(db, "bootstrap_status", "IN_PROGRESS")
}

export function eventPayloadFingerprint(input: {
  eventType: string
  asin: string
  sourceVersion: number
  status?: string
  priority?: string
  cadenceHours?: number
  activeConsumerCount?: number
}): string {
  return createHash("sha256")
    .update(
      [
        input.eventType,
        input.asin,
        String(input.sourceVersion),
        String(input.status ?? ""),
        String(input.priority ?? ""),
        String(input.cadenceHours ?? ""),
        String(input.activeConsumerCount ?? ""),
      ].join("|")
    )
    .digest("hex")
}

export function clearStaging(db: DatabaseSync): void {
  db.exec("DELETE FROM asin_registry_staging")
}

export function insertStagingRow(db: DatabaseSync, item: SnapshotItem, nowMs: number): void {
  if (item.status !== "ACTIVE" && item.status !== "PAUSED_QTY_ZERO") return
  const nextScan = nowMs + Math.max(0, Number(item.queueSeq) || 0) * 1000
  db.prepare(
    `INSERT INTO asin_registry_staging (
       asin, active_consumer_count, status, priority, cadence_hours, next_scan_at,
       source_version, queue_seq, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    item.asin,
    item.activeConsumerCount,
    item.status,
    item.priority,
    item.cadenceHours,
    nextScan,
    item.sourceVersion,
    item.queueSeq,
    nowMs,
    nowMs
  )
}

export type RepairMergeStats = {
  added: number
  updated: number
  paused: number
  removed: number
  preserved: number
}

export function mergeStagingIntoRegistry(
  db: DatabaseSync,
  nowMs: number,
  opts?: { inTransaction?: boolean }
): RepairMergeStats {
  const run = (): RepairMergeStats => {
    const stats: RepairMergeStats = { added: 0, updated: 0, paused: 0, removed: 0, preserved: 0 }
    const staging = db.prepare(
      `SELECT asin, active_consumer_count, status, priority, cadence_hours, source_version, queue_seq
       FROM asin_registry_staging`
    ).all() as Array<{
      asin: string
      active_consumer_count: number
      status: string
      priority: string
      cadence_hours: number
      source_version: number
      queue_seq: number
    }>
    const existing = db.prepare(`SELECT * FROM asin_registry`).all() as LocalAsinRow[]
    const current = new Map(existing.map(r => [r.asin, r]))
    const stagingAsins = new Set(staging.map(s => s.asin))
    const latest = db.prepare(
      `SELECT MAX(next_scan_at) AS m FROM asin_registry
       WHERE status = 'ACTIVE' AND next_scan_at <= ?`
    ).get(nowMs + KEEPA_QUEUE_HORIZON_MS) as { m: number | null }
    let tail = nextScanAtForNewAsin({ nowMs, latestQueueMs: latest?.m ?? null })
    const insert = db.prepare(
      `INSERT INTO asin_registry (
         asin, active_consumer_count, status, priority, cadence_hours, next_scan_at,
         source_version, queue_seq, created_at, updated_at, last_scanned_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
    )
    const update = db.prepare(
      `UPDATE asin_registry SET
         active_consumer_count = ?,
         status = ?,
         priority = ?,
         cadence_hours = ?,
         source_version = ?,
         next_scan_at = ?,
         updated_at = ?
       WHERE asin = ?`
    )
    for (const row of staging) {
      const cur = current.get(row.asin)
      if (!cur) {
        insert.run(
          row.asin,
          row.active_consumer_count,
          row.status,
          row.priority,
          row.cadence_hours,
          row.status === "ACTIVE" ? tail : nowMs + 365 * 86400_000,
          row.source_version,
          row.queue_seq || 0,
          nowMs,
          nowMs
        )
        if (row.status === "ACTIVE") tail += 1000
        stats.added++
        if (row.status === "PAUSED_QTY_ZERO") stats.paused++
        continue
      }
      const sv = Math.max(Number(cur.source_version) || 0, Number(row.source_version) || 0)
      let nextScan = cur.next_scan_at
      if (cur.status !== "ACTIVE" && row.status === "ACTIVE") {
        nextScan = tail
        tail += 1000
      }
      const unchanged =
        cur.status === row.status &&
        cur.priority === row.priority &&
        cur.cadence_hours === row.cadence_hours &&
        Number(cur.active_consumer_count) === Number(row.active_consumer_count)
      update.run(
        row.active_consumer_count,
        row.status,
        row.priority,
        row.cadence_hours,
        sv,
        nextScan,
        nowMs,
        row.asin
      )
      if (unchanged) stats.preserved++
      else stats.updated++
      if (row.status === "PAUSED_QTY_ZERO") stats.paused++
    }
    for (const row of existing) {
      if (!stagingAsins.has(row.asin)) {
        db.prepare(`DELETE FROM asin_registry WHERE asin = ?`).run(row.asin)
        stats.removed++
      }
    }
    db.exec("DELETE FROM asin_registry_staging")
    return stats
  }
  if (opts?.inTransaction) return run()
  db.exec("BEGIN")
  try {
    const stats = run()
    db.exec("COMMIT")
    return stats
  } catch (e) {
    db.exec("ROLLBACK")
    throw e
  }
}

export function swapStagingIntoRegistry(db: DatabaseSync): void {
  commitSwapAndPendingAcks(db, [], Date.now())
}

export type LedgerEvent = {
  eventId: string
  asin: string
  eventType: string
  sourceVersion: number
  fingerprint: string
}

export function commitSwapAndPendingAcks(db: DatabaseSync, events: LedgerEvent[], nowMs: number): void {
  db.exec("BEGIN")
  try {
    db.exec("DELETE FROM asin_registry")
    db.exec(
      `INSERT INTO asin_registry (
         asin, active_consumer_count, status, priority, cadence_hours, next_scan_at,
         source_version, queue_seq, created_at, updated_at
       )
       SELECT asin, active_consumer_count, status, priority, cadence_hours, next_scan_at,
              source_version, queue_seq, created_at, updated_at
       FROM asin_registry_staging
       WHERE status IN ('ACTIVE', 'PAUSED_QTY_ZERO')`
    )
    db.exec("DELETE FROM asin_registry_staging")
    const insert = db.prepare(
      `INSERT INTO sync_events (
         event_id, asin, event_type, source_version, applied_at, payload_fingerprint,
         applied_local_at, remote_ack_status, remote_ack_attempts, last_ack_error_code,
         last_ack_attempt_at, remote_acked_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING_ACK', 0, '', 0, 0)
       ON CONFLICT(event_id) DO UPDATE SET
         remote_ack_status = CASE
           WHEN sync_events.remote_ack_status = 'ACKED_REMOTE' THEN 'ACKED_REMOTE'
           ELSE 'PENDING_ACK'
         END`
    )
    for (const ev of events) {
      insert.run(ev.eventId, ev.asin, ev.eventType, ev.sourceVersion, nowMs, ev.fingerprint, nowMs)
    }
    setBootstrapPhase(db, "COMMITTED_PENDING_ACK")
    db.exec("COMMIT")
  } catch (e) {
    db.exec("ROLLBACK")
    throw e
  }
}

const REGISTRY_TABLES = ["asin_registry", "asin_registry_staging"] as const
type RegistryTable = (typeof REGISTRY_TABLES)[number]

function assertRegistryTable(table: string): RegistryTable {
  if (table === "asin_registry" || table === "asin_registry_staging") return table
  throw new Error("LOCAL_DB_INVALID")
}

export function localReconcileRows(db: DatabaseSync, table: RegistryTable = "asin_registry"): KeepaReconcileRow[] {
  const safe = assertRegistryTable(table)
  const rows = db.prepare(
    `SELECT asin, status, priority, cadence_hours, active_consumer_count, source_version
     FROM ${safe}`
  ).all() as Array<{
    asin: string
    status: string
    priority: string
    cadence_hours: number
    active_consumer_count: number
    source_version: number
  }>
  return rows.map(r => ({
    asin: r.asin,
    status: r.status,
    priority: r.priority,
    cadenceHours: r.cadence_hours,
    activeConsumerCount: r.active_consumer_count,
    sourceVersion: r.source_version,
  }))
}

export function localReconcileManifest(db: DatabaseSync, table: RegistryTable = "asin_registry") {
  return computeKeepaReconcileManifest(localReconcileRows(db, table))
}

export function keepaScanAllowed(db: DatabaseSync, centralHash?: string | null): { allowed: boolean; reason: string | null } {
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    const names = new Set(tables.map(t => t.name))
    if (!names.has("asin_registry") || !names.has("asin_registry_staging") || !names.has("worker_state")) {
      return { allowed: false, reason: "LOCAL_DB_INVALID" }
    }
    const phase = bootstrapPhase(db)
    if (phase !== "COMPLETE") return { allowed: false, reason: `BOOTSTRAP_${bootstrapStatus(db)}` }
    if (pendingAckCount(db) > 0) return { allowed: false, reason: "PENDING_ACK" }
    if (unauthorizedAckCount(db) > 0) return { allowed: false, reason: "ACK_UNAUTHORIZED" }
    const local = localReconcileManifest(db)
    const expected = getWorkerState(db, "central_reconcile_hash")
    const expectedCount = getWorkerState(db, "central_reconcile_count")
    if (!expected || local.hash !== expected) return { allowed: false, reason: "RECONCILE_MISMATCH" }
    if (expectedCount != null && Number(expectedCount) !== local.uniqueAsins) {
      return { allowed: false, reason: "RECONCILE_MISMATCH" }
    }
    if (centralHash && centralHash !== local.hash) return { allowed: false, reason: "RECONCILE_MISMATCH" }
    if (local.duplicates > 0 || local.sourceVersionRegressions > 0) {
      return { allowed: false, reason: "RECONCILE_MISMATCH" }
    }
    return { allowed: true, reason: null }
  } catch {
    return { allowed: false, reason: "LOCAL_DB_INVALID" }
  }
}

export function sqliteIntegrityOk(db: DatabaseSync): boolean {
  try {
    const row = db.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined
    return String(row?.integrity_check ?? "") === "ok"
  } catch {
    return false
  }
}

export function pendingAckCount(db: DatabaseSync): number {
  const row = db.prepare("SELECT COUNT(*) AS c FROM sync_events WHERE remote_ack_status = 'PENDING_ACK'").get() as { c: number }
  return Number(row?.c ?? 0)
}

export function unauthorizedAckCount(db: DatabaseSync): number {
  const row = db.prepare(
    `SELECT COUNT(*) AS c FROM sync_events
     WHERE last_ack_error_code IN ('HTTP_401', 'HTTP_403', 'UNAUTHORIZED')`
  ).get() as { c: number }
  return Number(row?.c ?? 0)
}

export function listPendingAckIds(db: DatabaseSync): string[] {
  const rows = db.prepare(
    "SELECT event_id FROM sync_events WHERE remote_ack_status = 'PENDING_ACK' ORDER BY applied_local_at ASC, event_id ASC"
  ).all() as { event_id: string }[]
  return rows.map(r => r.event_id)
}

export function markAckAttempt(db: DatabaseSync, eventId: string, nowMs: number, errorCode: string): void {
  db.prepare(
    `UPDATE sync_events
     SET remote_ack_attempts = remote_ack_attempts + 1,
         last_ack_attempt_at = ?,
         last_ack_error_code = ?
     WHERE event_id = ?`
  ).run(nowMs, errorCode, eventId)
}

export function markAckedRemote(db: DatabaseSync, eventId: string, nowMs: number): void {
  db.prepare(
    `UPDATE sync_events
     SET remote_ack_status = 'ACKED_REMOTE',
         remote_acked_at = ?,
         last_ack_attempt_at = ?,
         last_ack_error_code = ''
     WHERE event_id = ?`
  ).run(nowMs, nowMs, eventId)
}

export function applySyncEvent(
  db: DatabaseSync,
  event: {
    eventId: string
    asin: string
    eventType: string
    sourceVersion: number
    payload: {
      activeConsumerCount?: number
      status?: string
      priority?: string
      cadenceHours?: number
    }
    nowMs: number
  },
  opts?: { table?: RegistryTable; recordSync?: boolean; remoteAckStatus?: RemoteAckStatus; inTransaction?: boolean }
): boolean {
  const table = assertRegistryTable(opts?.table ?? "asin_registry")
  const recordSync = opts?.recordSync !== false
  const ackStatus: RemoteAckStatus = opts?.remoteAckStatus ?? "PENDING_ACK"
  const fingerprint = eventPayloadFingerprint({
    eventType: event.eventType,
    asin: event.asin,
    sourceVersion: event.sourceVersion,
    status: event.payload.status,
    priority: event.payload.priority,
    cadenceHours: event.payload.cadenceHours,
    activeConsumerCount: event.payload.activeConsumerCount,
  })
  if (recordSync) {
    const exists = db.prepare("SELECT event_id FROM sync_events WHERE event_id = ?").get(event.eventId)
    if (exists) return false
  }
  const run = (): boolean => {
    const cur = db.prepare(`SELECT * FROM ${table} WHERE asin = ?`).get(event.asin) as LocalAsinRow | undefined
    const skipState = Boolean(cur && event.sourceVersion <= cur.source_version)
    const removed = event.eventType === "ASIN_REMOVED" || event.payload.status === "REMOVED"
    if (!skipState) {
      if (removed) {
        db.prepare(`DELETE FROM ${table} WHERE asin = ?`).run(event.asin)
      } else {
        let status = event.payload.status ?? cur?.status ?? "ACTIVE"
        let priority = event.payload.priority ?? cur?.priority ?? "STANDARD"
        let cadence = event.payload.cadenceHours ?? cur?.cadence_hours ?? 24
        const count = event.payload.activeConsumerCount ?? cur?.active_consumer_count ?? 0
        if (event.eventType === "QTY_ZERO_PAUSED") status = "PAUSED_QTY_ZERO"
        if (
          (event.eventType === "CONSUMER_ATTACHED" || event.eventType === "QTY_POSITIVE_RESUMED") &&
          (Number(count) || 0) > 0
        ) {
          status = "ACTIVE"
        }
        if (event.eventType === "SOLD_PRIORITY_CHANGED") {
          priority = "SOLD"
          cadence = 12
        }
        let nextScan = cur?.next_scan_at ?? event.nowMs
        if (!cur) {
          const latest = db.prepare(`SELECT MAX(next_scan_at) AS m FROM ${table} WHERE status = 'ACTIVE'`).get() as { m: number | null }
          nextScan = nextScanAtForNewAsin({ nowMs: event.nowMs, latestQueueMs: latest?.m ?? null })
        }
        if (event.eventType === "QTY_POSITIVE_RESUMED" && status === "ACTIVE") {
          const latest = db.prepare(`SELECT MAX(next_scan_at) AS m FROM ${table} WHERE status = 'ACTIVE'`).get() as { m: number | null }
          nextScan = nextScanAtForNewAsin({ nowMs: event.nowMs, latestQueueMs: latest?.m ?? null })
        }
        db.prepare(
          `INSERT INTO ${table} (asin, active_consumer_count, status, priority, cadence_hours, next_scan_at, source_version, queue_seq, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(asin) DO UPDATE SET
             active_consumer_count = excluded.active_consumer_count,
             status = excluded.status,
             priority = excluded.priority,
             cadence_hours = excluded.cadence_hours,
             next_scan_at = CASE WHEN excluded.status = 'ACTIVE' AND ${table}.status <> 'ACTIVE'
               THEN excluded.next_scan_at ELSE ${table}.next_scan_at END,
             source_version = excluded.source_version,
             updated_at = excluded.updated_at`
        ).run(
          event.asin,
          count,
          status,
          priority,
          cadence,
          nextScan,
          event.sourceVersion,
          cur?.queue_seq ?? 0,
          event.nowMs,
          event.nowMs
        )
      }
    }
    if (recordSync) {
      db.prepare(
        `INSERT INTO sync_events (
           event_id, asin, event_type, source_version, applied_at, payload_fingerprint,
           applied_local_at, remote_ack_status, remote_ack_attempts, last_ack_error_code,
           last_ack_attempt_at, remote_acked_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, '', 0, ?)`
      ).run(
        event.eventId,
        event.asin,
        event.eventType,
        event.sourceVersion,
        event.nowMs,
        fingerprint,
        event.nowMs,
        ackStatus,
        ackStatus === "ACKED_REMOTE" ? event.nowMs : 0
      )
    }
    return !skipState
  }
  if (opts?.inTransaction) return run()
  db.exec("BEGIN")
  try {
    const changed = run()
    db.exec("COMMIT")
    return changed
  } catch (e) {
    db.exec("ROLLBACK")
    throw e
  }
}

export function dueAsins(db: DatabaseSync, nowMs: number, limit: number, exclude: string[] = []): LocalAsinRow[] {
  const excludeClause = exclude.length > 0 ? `AND asin NOT IN (${exclude.map(() => "?").join(",")})` : ""
  const rows = db.prepare(
    `SELECT * FROM asin_registry
     WHERE status = 'ACTIVE'
       AND priority IN ('SOLD', 'STANDARD')
       AND (
         last_scanned_at IS NULL OR last_scanned_at = 0
         OR last_scanned_at + cadence_hours * 3600000 <= ?
       )
       ${excludeClause}
     ORDER BY
       CASE WHEN last_scanned_at IS NULL OR last_scanned_at = 0 THEN 0 ELSE 1 END,
       next_scan_at ASC, asin ASC
     LIMIT ?`
  ).all(
    ...(exclude.length > 0 ? [nowMs, ...exclude, limit] : [nowMs, limit])
  ) as LocalAsinRow[]
  return rows
}

export function countDueAsins(db: DatabaseSync, nowMs: number): { total: number; sold: number; standard: number; oldestDueAgeSec: number | null } {
  const row = db.prepare(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN priority = 'SOLD' THEN 1 ELSE 0 END) AS sold,
       SUM(CASE WHEN priority = 'STANDARD' THEN 1 ELSE 0 END) AS standard,
       MIN(
         CASE
           WHEN last_scanned_at IS NULL OR last_scanned_at = 0 THEN ?
           ELSE CAST((? - last_scanned_at) / 1000 AS INTEGER)
         END
       ) AS oldest
     FROM asin_registry
     WHERE status = 'ACTIVE'
       AND priority IN ('SOLD', 'STANDARD')
       AND (
         last_scanned_at IS NULL OR last_scanned_at = 0
         OR last_scanned_at + cadence_hours * 3600000 <= ?
       )`
  ).get(Math.floor(nowMs / 1000), nowMs, nowMs) as {
    total: number
    sold: number | null
    standard: number | null
    oldest: number | null
  }
  return {
    total: Number(row?.total ?? 0),
    sold: Number(row?.sold ?? 0),
    standard: Number(row?.standard ?? 0),
    oldestDueAgeSec: row?.total ? Number(row.oldest ?? 0) : null,
  }
}

/** Next cadence wake. Unscanned ACTIVE is already due (now). PAUSED/REMOVED excluded. */
export function nextDueAtMs(db: DatabaseSync, nowMs: number): number | null {
  if (countDueAsins(db, nowMs).total > 0) return nowMs
  const row = db.prepare(
    `SELECT MIN(
       CASE
         WHEN last_scanned_at IS NULL OR last_scanned_at = 0 THEN ?
        ELSE last_scanned_at + cadence_hours * 3600000
       END
     ) AS m
     FROM asin_registry
     WHERE status = 'ACTIVE' AND priority IN ('SOLD', 'STANDARD')`
  ).get(nowMs) as { m: number | null }
  const m = row?.m
  if (m == null || !Number.isFinite(Number(m))) return null
  return Number(m)
}

export function markScanned(db: DatabaseSync, asin: string, nowMs: number, cadenceHours: number): void {
  const row = db.prepare("SELECT priority, cadence_hours FROM asin_registry WHERE asin = ?").get(asin) as { priority: string; cadence_hours: number } | undefined
  const configured = Number(row?.cadence_hours)
  const requested = Number(cadenceHours)
  const hours = [12, 24, 120].includes(configured) ? configured : ([12, 24, 120].includes(requested) ? requested : (row?.priority === "SOLD" ? 12 : 24))
  db.prepare(
    "UPDATE asin_registry SET next_scan_at = ?, last_scanned_at = ?, updated_at = ? WHERE asin = ?"
  ).run(nowMs + hours * 3600_000, nowMs, nowMs, asin)
}

export function recordKeepaTokenSample(
  db: DatabaseSync,
  sample: {
    collectedAt: number
    tokensLeft: number | null
    refillRate: number | null
    refillIn: number | null
    tokensConsumed: number | null
    tokenFlowReduction: number | null
    processingTimeInMs: number | null
    httpStatus: number | null
    requested: number
    returned: number
    parsed: number
  }
): void {
  db.prepare(
    `INSERT INTO keepa_token_samples (
       collected_at, tokens_left, refill_rate, refill_in, tokens_consumed, token_flow_reduction,
       processing_time_ms, http_status, requested, returned, parsed
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    sample.collectedAt,
    sample.tokensLeft,
    sample.refillRate,
    sample.refillIn,
    sample.tokensConsumed,
    sample.tokenFlowReduction,
    sample.processingTimeInMs,
    sample.httpStatus,
    sample.requested,
    sample.returned,
    sample.parsed
  )
}

/** Complete the sample after product parsing; the row is initially recorded before parsing. */
export function updateKeepaTokenSampleParsed(
  db: DatabaseSync,
  collectedAt: number,
  parsed: number
): void {
  db.prepare(
    `UPDATE keepa_token_samples
     SET parsed = ?
     WHERE collected_at = ?`
  ).run(Math.max(0, Math.trunc(parsed)), collectedAt)
}

export function keepaSampleWindowTotals(db: DatabaseSync, nowMs: number): {
  scans15m: number
  scans1h: number
  scans24h: number
  parsed15m: number
  parsed1h: number
  parsed24h: number
  tokensSpent15m: number
  tokensSpent1h: number
  tokensSpent24h: number
} {
  const row = db.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN collected_at >= ? THEN requested ELSE 0 END), 0) AS s15,
       COALESCE(SUM(CASE WHEN collected_at >= ? THEN requested ELSE 0 END), 0) AS s1,
       COALESCE(SUM(CASE WHEN collected_at >= ? THEN requested ELSE 0 END), 0) AS s24,
       COALESCE(SUM(CASE WHEN collected_at >= ? THEN parsed ELSE 0 END), 0) AS p15,
       COALESCE(SUM(CASE WHEN collected_at >= ? THEN parsed ELSE 0 END), 0) AS p1,
       COALESCE(SUM(CASE WHEN collected_at >= ? THEN parsed ELSE 0 END), 0) AS p24,
       COALESCE(SUM(CASE WHEN collected_at >= ? THEN COALESCE(tokens_consumed, 0) ELSE 0 END), 0) AS t15,
       COALESCE(SUM(CASE WHEN collected_at >= ? THEN COALESCE(tokens_consumed, 0) ELSE 0 END), 0) AS t1,
       COALESCE(SUM(CASE WHEN collected_at >= ? THEN COALESCE(tokens_consumed, 0) ELSE 0 END), 0) AS t24
     FROM keepa_token_samples`
  ).get(
    nowMs - 15 * 60_000,
    nowMs - 3600_000,
    nowMs - 24 * 3600_000,
    nowMs - 15 * 60_000,
    nowMs - 3600_000,
    nowMs - 24 * 3600_000,
    nowMs - 15 * 60_000,
    nowMs - 3600_000,
    nowMs - 24 * 3600_000
  ) as Record<string, number>
  return {
    scans15m: Number(row.s15) || 0,
    scans1h: Number(row.s1) || 0,
    scans24h: Number(row.s24) || 0,
    parsed15m: Number(row.p15) || 0,
    parsed1h: Number(row.p1) || 0,
    parsed24h: Number(row.p24) || 0,
    tokensSpent15m: Number(row.t15) || 0,
    tokensSpent1h: Number(row.t1) || 0,
    tokensSpent24h: Number(row.t24) || 0,
  }
}

export function registryTelemetryCounts(db: DatabaseSync): {
  active: number
  paused: number
  sold: number
  standard: number
  snapshotted: number
} {
  const row = db.prepare(
    `SELECT
       SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END) AS active,
       SUM(CASE WHEN status = 'PAUSED_QTY_ZERO' THEN 1 ELSE 0 END) AS paused,
       SUM(CASE WHEN status = 'ACTIVE' AND priority = 'SOLD' THEN 1 ELSE 0 END) AS sold,
       SUM(CASE WHEN status = 'ACTIVE' AND priority = 'STANDARD' THEN 1 ELSE 0 END) AS standard
     FROM asin_registry`
  ).get() as { active: number; paused: number; sold: number; standard: number }
  const snaps = db.prepare("SELECT COUNT(*) AS c FROM keepa_snapshots").get() as { c: number }
  return {
    active: Number(row.active) || 0,
    paused: Number(row.paused) || 0,
    sold: Number(row.sold) || 0,
    standard: Number(row.standard) || 0,
    snapshotted: Number(snaps.c) || 0,
  }
}

export function candidateTelemetryCounts(db: DatabaseSync): {
  pending: number
  retryable: number
  noBusinessChange: number
  confirmed: number
  conflict: number
  terminal: number
} {
  const row = db.prepare(
    `SELECT
       SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN status = 'RETRYABLE' THEN 1 ELSE 0 END) AS retryable,
       SUM(CASE WHEN status = 'NO_BUSINESS_CHANGE' THEN 1 ELSE 0 END) AS nbc,
       SUM(CASE WHEN status = 'MATCHED' THEN 1 ELSE 0 END) AS matched,
       SUM(CASE WHEN status = 'CONFLICT' THEN 1 ELSE 0 END) AS conflict,
       SUM(CASE WHEN status IN ('MATCHED','CONFLICT','SUPERSEDED','COOLDOWN') THEN 1 ELSE 0 END) AS terminal
     FROM keepa_candidates`
  ).get() as Record<string, number>
  return {
    pending: Number(row.pending) || 0,
    retryable: Number(row.retryable) || 0,
    noBusinessChange: Number(row.nbc) || 0,
    confirmed: Number(row.matched) || 0,
    conflict: Number(row.conflict) || 0,
    terminal: Number(row.terminal) || 0,
  }
}

export function saveSnapshot(db: DatabaseSync, asin: string, fingerprint: string, snapshotJson: string, nowMs: number): void {
  db.prepare(
    `INSERT INTO keepa_snapshots (asin, fingerprint, snapshot_json, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(asin) DO UPDATE SET fingerprint = excluded.fingerprint, snapshot_json = excluded.snapshot_json, updated_at = excluded.updated_at`
  ).run(asin, fingerprint, snapshotJson, nowMs)
}

export function loadSnapshot(db: DatabaseSync, asin: string): { fingerprint: string; snapshot_json: string } | undefined {
  return db.prepare("SELECT fingerprint, snapshot_json FROM keepa_snapshots WHERE asin = ?").get(asin) as
    | { fingerprint: string; snapshot_json: string }
    | undefined
}

export function upsertCandidate(db: DatabaseSync, input: {
  asin: string
  fingerprint: string
  snapshotJson: string
  status: string
  nowMs: number
}): void {
  db.prepare(
    `UPDATE keepa_candidates SET status = 'SUPERSEDED', updated_at = ?
     WHERE asin = ? AND status IN ('PENDING','RETRYABLE') AND fingerprint <> ?`
  ).run(input.nowMs, input.asin, input.fingerprint)
  db.prepare(
    `INSERT INTO keepa_candidates (fingerprint, asin, snapshot_json, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(fingerprint) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`
  ).run(input.fingerprint, input.asin, input.snapshotJson, input.status, input.nowMs, input.nowMs)
}

export function candidateCount(db: DatabaseSync): number {
  const row = db.prepare("SELECT COUNT(*) AS c FROM keepa_candidates").get() as { c: number }
  return Number(row?.c ?? 0)
}

export function snapshotCount(db: DatabaseSync): number {
  const row = db.prepare("SELECT COUNT(*) AS c FROM keepa_snapshots").get() as { c: number }
  return Number(row?.c ?? 0)
}

export function registryCount(db: DatabaseSync): number {
  const row = db.prepare("SELECT COUNT(*) AS c FROM asin_registry").get() as { c: number }
  return Number(row?.c ?? 0)
}

export function stagingCount(db: DatabaseSync): number {
  const row = db.prepare("SELECT COUNT(*) AS c FROM asin_registry_staging").get() as { c: number }
  return Number(row?.c ?? 0)
}

export function enqueueObservationOutbox(
  db: DatabaseSync,
  input: { fingerprint: string; asin: string; payloadJson: string; nowMs: number }
): void {
  db.prepare(
    `INSERT INTO keepa_observation_outbox (fingerprint, asin, payload_json, remote_status, attempts, last_error, next_attempt_at, created_at, updated_at)
     VALUES (?, ?, ?, 'PENDING', 0, '', 0, ?, ?)
     ON CONFLICT(fingerprint) DO NOTHING`
  ).run(input.fingerprint, input.asin, input.payloadJson, input.nowMs, input.nowMs)
}

export function listPendingObservationOutbox(
  db: DatabaseSync,
  nowMs = Date.now()
): Array<{ fingerprint: string; asin: string; payload_json: string; attempts: number }> {
  return db.prepare(
    `SELECT fingerprint, asin, payload_json, attempts FROM keepa_observation_outbox
     WHERE remote_status = 'PENDING' AND COALESCE(next_attempt_at, 0) <= ?
     ORDER BY created_at ASC`
  ).all(nowMs) as Array<{ fingerprint: string; asin: string; payload_json: string; attempts: number }>
}

export function markObservationDelivered(db: DatabaseSync, fingerprint: string, nowMs: number): void {
  db.prepare(
    `UPDATE keepa_observation_outbox
     SET remote_status = 'DELIVERED', last_error = '', updated_at = ?
     WHERE fingerprint = ?`
  ).run(nowMs, fingerprint)
}

export function markObservationAttempt(db: DatabaseSync, fingerprint: string, nowMs: number, errorCode: string): void {
  const row = db.prepare(`SELECT attempts FROM keepa_observation_outbox WHERE fingerprint = ?`).get(fingerprint) as
    | { attempts: number }
    | undefined
  const attempts = (Number(row?.attempts) || 0) + 1
  const delay = attempts <= 1 ? 0 : Math.min(15 * 60_000, 1000 * Math.pow(2, attempts - 1))
  const nextAt = nowMs + delay
  db.prepare(
    `UPDATE keepa_observation_outbox
     SET attempts = ?, last_error = ?, next_attempt_at = ?, updated_at = ?
     WHERE fingerprint = ?`
  ).run(attempts, errorCode, nextAt, nowMs, fingerprint)
}

export function pendingObservationCount(db: DatabaseSync): number {
  const row = db.prepare(
    `SELECT COUNT(*) AS c FROM keepa_observation_outbox WHERE remote_status = 'PENDING'`
  ).get() as { c: number }
  return Number(row?.c ?? 0)
}

export function deliveredObservationCount(db: DatabaseSync): number {
  const row = db.prepare(
    `SELECT COUNT(*) AS c FROM keepa_observation_outbox WHERE remote_status = 'DELIVERED'`
  ).get() as { c: number }
  return Number(row?.c ?? 0)
}

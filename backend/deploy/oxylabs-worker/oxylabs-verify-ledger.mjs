export const WORKER_LEDGER_VERSION = 2
export const OXYLABS_CALL_OUTCOME_UNKNOWN = "OXYLABS_CALL_OUTCOME_UNKNOWN"

export function migrateOxylabsWorkerLedger(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS jobs (
  job_id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  asin TEXT NOT NULL,
  lease_token TEXT NOT NULL,
  call_state TEXT NOT NULL,
  http_status INTEGER,
  response_json TEXT,
  call_outcome TEXT,
  result_submitted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
`)
  const cols = db.prepare(`PRAGMA table_info(jobs)`).all().map(c => c.name)
  const add = (name, ddl) => {
    if (!cols.includes(name)) db.exec(`ALTER TABLE jobs ADD COLUMN ${ddl}`)
  }
  add("fail_code", "fail_code TEXT")
  add("fail_message", "fail_message TEXT")
  add("fail_submitted", "fail_submitted INTEGER NOT NULL DEFAULT 0")
  add("result_submit_attempts", "result_submit_attempts INTEGER NOT NULL DEFAULT 0")
  add("fail_submit_attempts", "fail_submit_attempts INTEGER NOT NULL DEFAULT 0")
  add("call_started_at", "call_started_at TEXT")
  add("call_completed_at", "call_completed_at TEXT")
  add("pk_errors", "pk_errors INTEGER NOT NULL DEFAULT 0")
  db.exec(`
CREATE TABLE IF NOT EXISTS ledger_meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
`)
  db.prepare(`INSERT OR IGNORE INTO ledger_meta (k, v) VALUES ('schema_version', ?)`).run(String(WORKER_LEDGER_VERSION))
}

export function loadJob(db, jobId) {
  return db.prepare(`SELECT * FROM jobs WHERE job_id = ?`).get(jobId) ?? null
}

export function ensureJobRow(db, job) {
  const now = new Date().toISOString()
  try {
    db.prepare(
      `INSERT OR IGNORE INTO jobs (job_id, kind, asin, lease_token, call_state, created_at)
       VALUES (?, ?, ?, ?, 'NEW', ?)`
    ).run(job.jobId, job.kind, job.asin, job.leaseToken, now)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/UNIQUE|PRIMARY KEY/i.test(msg)) {
      db.prepare(`UPDATE jobs SET pk_errors = COALESCE(pk_errors, 0) + 1 WHERE job_id = ?`).run(job.jobId)
    } else {
      throw e
    }
  }
  const row = loadJob(db, job.jobId)
  if (row && row.lease_token !== job.leaseToken) {
    db.prepare(`UPDATE jobs SET lease_token = ? WHERE job_id = ?`).run(job.leaseToken, job.jobId)
  }
  return loadJob(db, job.jobId)
}

export function markCallStarted(db, jobId) {
  const now = new Date().toISOString()
  db.prepare(
    `UPDATE jobs
     SET call_state = 'CALL_STARTED', call_started_at = COALESCE(call_started_at, ?)
     WHERE job_id = ? AND call_state IN ('NEW', 'PENDING')`
  ).run(now, jobId)
  return loadJob(db, jobId)
}

export function markCallUnknown(db, jobId) {
  db.prepare(
    `UPDATE jobs
     SET call_state = 'CALL_OUTCOME_UNKNOWN',
         call_outcome = ?,
         fail_code = ?,
         fail_message = COALESCE(fail_message, 'prior call outcome unknown; no second paid call')
     WHERE job_id = ? AND response_json IS NULL AND call_state IN ('CALL_STARTED', 'CALL_OUTCOME_UNKNOWN', 'NEW')`
  ).run(OXYLABS_CALL_OUTCOME_UNKNOWN, OXYLABS_CALL_OUTCOME_UNKNOWN, jobId)
  return loadJob(db, jobId)
}

export function saveProviderResponse(db, jobId, httpStatus, json, outcome = "OK") {
  const now = new Date().toISOString()
  db.prepare(
    `UPDATE jobs
     SET call_state = 'SAVED',
         http_status = ?,
         response_json = ?,
         call_outcome = ?,
         call_completed_at = ?
     WHERE job_id = ? AND response_json IS NULL`
  ).run(httpStatus, JSON.stringify(json), outcome, now, jobId)
  return loadJob(db, jobId)
}

export function markResultSubmitted(db, jobId) {
  db.prepare(
    `UPDATE jobs SET result_submitted = 1, call_state = 'RESULT_SUBMITTED' WHERE job_id = ?`
  ).run(jobId)
  return loadJob(db, jobId)
}

export function bumpResultSubmitAttempt(db, jobId) {
  db.prepare(`UPDATE jobs SET result_submit_attempts = COALESCE(result_submit_attempts, 0) + 1 WHERE job_id = ?`).run(jobId)
}

export function markFailSubmitted(db, jobId) {
  db.prepare(
    `UPDATE jobs SET fail_submitted = 1, call_state = 'FAIL_SUBMITTED' WHERE job_id = ?`
  ).run(jobId)
  return loadJob(db, jobId)
}

export function bumpFailSubmitAttempt(db, jobId) {
  db.prepare(`UPDATE jobs SET fail_submit_attempts = COALESCE(fail_submit_attempts, 0) + 1 WHERE job_id = ?`).run(jobId)
}

export function decideReplayAction(row, { ownedThisProcess = false } = {}) {
  if (!row) return { action: "ensure", providerCall: false }
  if (row.result_submitted === 1 || row.call_state === "RESULT_SUBMITTED") {
    return { action: "noop", providerCall: false }
  }
  if (row.fail_submitted === 1 || row.call_state === "FAIL_SUBMITTED") {
    return { action: "noop", providerCall: false }
  }
  if (row.response_json) {
    return { action: "submit_result", providerCall: false }
  }
  if (row.call_state === "CALL_OUTCOME_UNKNOWN" || row.fail_code) {
    return { action: "submit_fail", providerCall: false }
  }
  if (row.call_state === "CALL_STARTED") {
    if (ownedThisProcess) return { action: "provider_call", providerCall: true }
    return { action: "mark_unknown", providerCall: false }
  }
  if (row.call_state === "NEW" || row.call_state === "PENDING") {
    return { action: "start_call", providerCall: true }
  }
  return { action: "noop", providerCall: false }
}

export async function processClaimedJob(input) {
  const { db, job, callProvider, submitResult, submitFail, ownedCalls, expiredRecovery } = input
  migrateOxylabsWorkerLedger(db)
  const owned = ownedCalls ?? new Set()
  let row = ensureJobRow(db, job)
  let action = decideReplayAction(row, { ownedThisProcess: owned.has(job.jobId) })
  let providerCalls = 0
  let pkErrors = 0
  if (expiredRecovery) {
    if (row.result_submitted === 1 || row.call_state === "RESULT_SUBMITTED") {
      return { row, providerCalls: 0, pkErrors: Number(row.pk_errors ?? 0) || 0, action: "noop" }
    }
    if (row.fail_submitted === 1 || row.call_state === "FAIL_SUBMITTED") {
      return { row, providerCalls: 0, pkErrors: Number(row.pk_errors ?? 0) || 0, action: "noop" }
    }
    if (row.response_json && !row.fail_code) {
      action = { action: "submit_result", providerCall: false }
    } else if (row.fail_code) {
      action = { action: "submit_fail", providerCall: false }
    } else {
      row = markCallUnknown(db, job.jobId)
      action = { action: "submit_fail", providerCall: false }
    }
  }

  if (expiredRecovery && action.providerCall) {
    row = markCallUnknown(db, job.jobId)
    action = { action: "submit_fail", providerCall: false }
  }

  if (action.action === "noop") return { row, providerCalls, pkErrors, action: action.action }

  if (action.action === "start_call") {
    row = markCallStarted(db, job.jobId)
    owned.add(job.jobId)
    action = decideReplayAction(row, { ownedThisProcess: true })
  }

  if (action.action === "mark_unknown") {
    row = markCallUnknown(db, job.jobId)
    action = { action: "submit_fail", providerCall: false }
  }

  if (action.action === "provider_call") {
    let httpStatus = null
    let json = null
    try {
      const out = await callProvider(job.asin)
      providerCalls += 1
      httpStatus = out.httpStatus
      json = out.json
    } catch {
      row = markCallUnknown(db, job.jobId)
      bumpFailSubmitAttempt(db, job.jobId)
      const fail = await submitFail(loadJob(db, job.jobId))
      if (fail.acked) markFailSubmitted(db, job.jobId)
      return { row: loadJob(db, job.jobId), providerCalls, pkErrors, action: "submit_fail" }
    }
    if (httpStatus === 401 || httpStatus === 403) {
      db.prepare(
        `UPDATE jobs SET fail_code = 'CREDENTIAL_REJECT', fail_message = 'provider auth rejected' WHERE job_id = ?`
      ).run(job.jobId)
      row = saveProviderResponse(db, job.jobId, httpStatus, json, "CREDENTIAL_REJECT")
      bumpFailSubmitAttempt(db, job.jobId)
      const fail = await submitFail(loadJob(db, job.jobId))
      if (fail.acked) markFailSubmitted(db, job.jobId)
      return { row: loadJob(db, job.jobId), providerCalls, pkErrors, action: "submit_fail" }
    }
    row = saveProviderResponse(db, job.jobId, httpStatus, json, "OK")
    action = { action: "submit_result", providerCall: false }
  }

  if (action.action === "submit_result") {
    bumpResultSubmitAttempt(db, job.jobId)
    const result = await submitResult(loadJob(db, job.jobId))
    if (result.acked) markResultSubmitted(db, job.jobId)
  }

  if (action.action === "submit_fail") {
    bumpFailSubmitAttempt(db, job.jobId)
    const fail = await submitFail(loadJob(db, job.jobId))
    if (fail.acked) markFailSubmitted(db, job.jobId)
  }

  pkErrors = Number(loadJob(db, job.jobId)?.pk_errors ?? 0) || 0
  return { row: loadJob(db, job.jobId), providerCalls, pkErrors, action: action.action }
}

export function pendingOutbox(db) {
  return db
    .prepare(
      `SELECT * FROM jobs
       WHERE (response_json IS NOT NULL AND result_submitted = 0)
          OR (fail_code IS NOT NULL AND fail_submitted = 0 AND (response_json IS NULL OR call_state = 'CALL_OUTCOME_UNKNOWN'))`
    )
    .all()
}

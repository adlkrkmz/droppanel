#!/usr/bin/env node
import assert from "node:assert"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { DatabaseSync } from "node:sqlite"
import {
  migrateOxylabsWorkerLedger,
  processClaimedJob,
  ensureJobRow,
  markCallStarted,
  saveProviderResponse,
  loadJob,
  OXYLABS_CALL_OUTCOME_UNKNOWN,
} from "../deploy/oxylabs-worker/oxylabs-verify-ledger.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const product = {
  results: [{ content: { asin: "B00TEST001", price: 1.5, stock: "In Stock" }, status_code: 200 }],
}

function tmpDb() {
  const p = path.join(os.tmpdir(), `oxy-ledger-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`)
  const database = new DatabaseSync(p)
  migrateOxylabsWorkerLedger(database)
  return database
}

const job = { jobId: 42, kind: "OXYLABS_PRODUCT_PRIMARY", asin: "B00TEST001", leaseToken: "lease-1" }

{
  const database = tmpDb()
  let providerCalls = 0
  let resultSubmits = 0
  const statuses = [500, 200]
  const owned = new Set()
  const callProvider = async () => {
    providerCalls++
    return { httpStatus: 200, json: product }
  }
  const submitResult = async () => {
    resultSubmits++
    return { acked: statuses.shift() === 200 }
  }
  const submitFail = async () => ({ acked: false })
  await processClaimedJob({ db: database, job, ownedCalls: owned, callProvider, submitResult, submitFail })
  await processClaimedJob({ db: database, job, ownedCalls: owned, callProvider, submitResult, submitFail })
  const row = loadJob(database, 42)
  assert.equal(providerCalls, 1)
  assert.equal(resultSubmits, 2)
  assert.equal(row.result_submitted, 1)
  assert.equal(row.pk_errors ?? 0, 0)
  console.log("PASS A result-retry provider=1 submit=2 pk=0")
}

{
  const database = tmpDb()
  ensureJobRow(database, job)
  markCallStarted(database, 42)
  let providerCalls = 0
  let failSubmits = 0
  const failAck = [false, true]
  await processClaimedJob({
    db: database,
    job,
    ownedCalls: new Set(),
    callProvider: async () => {
      providerCalls++
      return { httpStatus: 200, json: product }
    },
    submitResult: async () => ({ acked: true }),
    submitFail: async () => {
      failSubmits++
      return { acked: failAck.shift() === true }
    },
  })
  await processClaimedJob({
    db: database,
    job,
    ownedCalls: new Set(),
    callProvider: async () => {
      providerCalls++
      return { httpStatus: 200, json: product }
    },
    submitResult: async () => ({ acked: true }),
    submitFail: async () => {
      failSubmits++
      return { acked: true }
    },
  })
  const row = loadJob(database, 42)
  assert.equal(providerCalls, 0)
  assert.equal(failSubmits, 2)
  assert.equal(row.fail_code, OXYLABS_CALL_OUTCOME_UNKNOWN)
  assert.equal(row.fail_submitted, 1)
  assert.equal(row.pk_errors ?? 0, 0)
  console.log("PASS B mid-call crash unknown fail retry provider=0")
}

{
  const database = tmpDb()
  ensureJobRow(database, job)
  saveProviderResponse(database, 42, 200, product, "OK")
  let providerCalls = 0
  let resultSubmits = 0
  await processClaimedJob({
    db: database,
    job,
    ownedCalls: new Set(),
    callProvider: async () => {
      providerCalls++
      return { httpStatus: 200, json: product }
    },
    submitResult: async () => {
      resultSubmits++
      return { acked: true }
    },
    submitFail: async () => ({ acked: false }),
  })
  assert.equal(providerCalls, 0)
  assert.equal(resultSubmits, 1)
  assert.equal(loadJob(database, 42).result_submitted, 1)
  console.log("PASS C saved-response crash provider=0 result=1")
}

{
  const workerPath = path.join(__dirname, "../deploy/oxylabs-worker/oxylabs-verify-worker.mjs")
  const r = spawnSync(process.execPath, [workerPath], {
    env: {
      ...process.env,
      OXYLABS_PRICING_ENABLED: "true",
      LISTJETGO_API_BASE: "http://127.0.0.1:9",
      OXYLABS_VERIFY_WORKER_TOKEN: "x".repeat(32),
      OXYLABS_WORKER_ENABLED: "false",
    },
    encoding: "utf8",
  })
  assert.equal(r.status, 1)
  assert.match(String(r.stderr), /OXYLABS_PRICING_ENABLED/)
  console.log("PASS F pricing exit 1 provider=0")
}

assert.doesNotMatch(
  fs.readFileSync(path.join(__dirname, "../deploy/oxylabs-worker/oxylabs-verify-worker.mjs"), "utf8"),
  /source:\s*"amazon_pricing"/
)
{
  const database = tmpDb()
  let providerCalls = 0
  let failSubmits = 0
  await processClaimedJob({
    db: database,
    job,
    expiredRecovery: true,
    ownedCalls: new Set(),
    callProvider: async () => {
      providerCalls++
      return { httpStatus: 200, json: product }
    },
    submitResult: async () => ({ acked: true }),
    submitFail: async () => {
      failSubmits++
      return { acked: true }
    },
  })
  const row = loadJob(database, 42)
  assert.equal(providerCalls, 0)
  assert.equal(failSubmits, 1)
  assert.equal(row.fail_code, OXYLABS_CALL_OUTCOME_UNKNOWN)
  assert.equal(row.fail_submitted, 1)
  console.log("PASS R1 expiredRecovery missing-ledger unknown fail provider=0")
}

{
  const database = tmpDb()
  ensureJobRow(database, job)
  saveProviderResponse(database, 42, 200, product, "OK")
  let providerCalls = 0
  let resultSubmits = 0
  await processClaimedJob({
    db: database,
    job,
    expiredRecovery: true,
    ownedCalls: new Set(),
    callProvider: async () => {
      providerCalls++
      return { httpStatus: 200, json: product }
    },
    submitResult: async () => {
      resultSubmits++
      return { acked: true }
    },
    submitFail: async () => ({ acked: true }),
  })
  assert.equal(providerCalls, 0)
  assert.equal(resultSubmits, 1)
  assert.equal(loadJob(database, 42).result_submitted, 1)
  console.log("PASS R2 expiredRecovery SAVED resubmit provider=0")
}

{
  const database = tmpDb()
  ensureJobRow(database, job)
  markCallStarted(database, 42)
  let providerCalls = 0
  let failSubmits = 0
  await processClaimedJob({
    db: database,
    job,
    expiredRecovery: true,
    ownedCalls: new Set([42]),
    callProvider: async () => {
      providerCalls++
      return { httpStatus: 200, json: product }
    },
    submitResult: async () => ({ acked: true }),
    submitFail: async () => {
      failSubmits++
      return { acked: true }
    },
  })
  assert.equal(providerCalls, 0)
  assert.equal(failSubmits, 1)
  assert.equal(loadJob(database, 42).fail_code, OXYLABS_CALL_OUTCOME_UNKNOWN)
  console.log("PASS R3 expiredRecovery CALL_STARTED owned still provider=0")
}

{
  const database = tmpDb()
  ensureJobRow(database, job)
  database.prepare(
    `UPDATE jobs SET fail_code = ?, fail_message = 'provider auth rejected', call_state = 'SAVED' WHERE job_id = ?`
  ).run("CREDENTIAL_REJECT", 42)
  let providerCalls = 0
  let failSubmits = 0
  await processClaimedJob({
    db: database,
    job,
    expiredRecovery: true,
    ownedCalls: new Set(),
    callProvider: async () => {
      providerCalls++
      return { httpStatus: 200, json: product }
    },
    submitResult: async () => ({ acked: true }),
    submitFail: async () => {
      failSubmits++
      return { acked: true }
    },
  })
  assert.equal(providerCalls, 0)
  assert.equal(failSubmits, 1)
  assert.equal(loadJob(database, 42).fail_submitted, 1)
  console.log("PASS R4 expiredRecovery prepared fail payload provider=0")
}

console.log("PASS oxylabs worker 1.0.2 ledger A-C F R1-R4")

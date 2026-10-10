/**
 * Controlled local Stock Guard V2 E2E: Keepa → decision → extension (if needed) → Stock Alerts.
 * Orchestrates existing services. Does not copy business logic.
 * Live Keepa. No eBay mutations. No production deploy.
 */
import "dotenv/config"
import crypto from "crypto"
import fs from "fs"
import path from "path"
import { closeDbPool, query } from "../db/client"
import { issueExtensionToken } from "../modules/app/extensionAuth"
import { hashPassword } from "../modules/auth/password"
import { activateProductAccessForUser } from "../modules/productAccess/productAccessRepository"
import { GLOBAL_KEEPA_ACTIVE_CONSUMER_WHERE } from "../modules/globalKeepa/globalKeepaEligibility"
import { runGlobalKeepaPlannerForAsins } from "../modules/globalKeepa/globalKeepaPlannerTick"
import { loadAmazonVerificationConfig } from "../modules/amazonVerification/amazonVerificationConfig"
import { loadGlobalKeepaFoundationConfig } from "../modules/globalKeepa/globalKeepaConfig"
import { getPlatformAmazonVerificationStatus } from "../modules/amazonVerification/amazonVerificationAdminStatus"
import { getStockGuardScannerMode } from "../modules/stockGuard/stockGuardScannerOwnership"

const WORKSPACE_ID = process.env.WORKSPACE_ID || "00000000-0000-0000-0000-000000000001"
const PREFERRED_ASINS = ["B0CVVX47K8", "B00367HAV6"]
const TEST_EXT_DIR = "C:\\Users\\pc\\Desktop\\ListJetGo-StockGuard-Test-Extension"
const PROD_EXT_DIR = path.resolve(__dirname, "../../extension")
const LOCAL_STATE_DIR = path.resolve(__dirname, "../.local-e2e")
const STATE_FILE = path.join(LOCAL_STATE_DIR, "stock-guard-v2-50-run.json")
const ENV_FILE = path.resolve(__dirname, "../.env")
const LOCAL_API = "http://localhost:4000"
const TARGET_UNIQUE = 50

function assertLocalDb(): void {
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error("DATABASE_URL is not defined")
  const host = new URL(dbUrl).hostname.toLowerCase()
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
    throw new Error(`Refusing E2E: DATABASE_URL host=${host} is not local`)
  }
}

function upsertEnv(pairs: Record<string, string>): void {
  let text = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8") : ""
  if (text.length && !text.endsWith("\n")) text += "\n"
  for (const [key, value] of Object.entries(pairs)) {
    const re = new RegExp(`^${key}=.*$`, "m")
    const line = `${key}=${value}`
    if (re.test(text)) text = text.replace(re, line)
    else text += `${line}\n`
  }
  fs.writeFileSync(ENV_FILE, text)
}

function envOrGenerate(name: string, bytes = 32): string {
  const existing = process.env[name]?.trim() ?? ""
  if (existing.length >= 32) return existing
  const generated = crypto.randomBytes(bytes).toString("hex")
  process.env[name] = generated
  return generated
}

function patchCopiedFile(filePath: string, replacements: Array<[string | RegExp, string]>): void {
  let text = fs.readFileSync(filePath, "utf8")
  for (const [from, to] of replacements) {
    text = text.replace(from, to)
  }
  fs.writeFileSync(filePath, text)
}

function copyTestExtension(): void {
  fs.mkdirSync(TEST_EXT_DIR, { recursive: true })
  const files = fs.readdirSync(PROD_EXT_DIR, { withFileTypes: true })
  for (const file of files) {
    if (!file.isFile()) continue
    fs.copyFileSync(path.join(PROD_EXT_DIR, file.name), path.join(TEST_EXT_DIR, file.name))
  }
  patchCopiedFile(path.join(TEST_EXT_DIR, "api.js"), [
    ["const API = 'https://api.listjetgo.com';", `const API = '${LOCAL_API}';`],
  ])
  const apiPath = path.join(TEST_EXT_DIR, "api.js")
  let api = fs.readFileSync(apiPath, "utf8")
  const tokenLoader = `
  async function loadLocalTestConfig() {
    try {
      const res = await fetch(chrome.runtime.getURL('local-test-config.json'));
      if (!res.ok) return null;
      return await res.json();
    } catch (_) { return null; }
  }
`
  if (!api.includes("loadLocalTestConfig")) {
    api = api.replace("async function getToken(force) {", `${tokenLoader}
  async function getToken(force) {
    const localCfg = await loadLocalTestConfig();
    if (localCfg && localCfg.localTestKey) {
      const saved = await chrome.storage.local.get([TOKEN, EXPIRES]);
      if (!force && saved[TOKEN] && Number(new Date(saved[EXPIRES])) > Date.now() + 30000) return saved[TOKEN];
      try {
        const r = await fetch((localCfg.apiBase || API) + '/app/extension/local-test-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: localCfg.localTestKey })
        });
        if (r.ok) {
          const data = await r.json();
          if (data.accessToken) {
            await chrome.storage.local.set({ [TOKEN]: data.accessToken, [EXPIRES]: data.expiresAt });
            return data.accessToken;
          }
        }
      } catch (_) {}
      if (localCfg.accessToken) {
        await chrome.storage.local.set({ [TOKEN]: localCfg.accessToken, [EXPIRES]: localCfg.expiresAt });
        return localCfg.accessToken;
      }
    }
`)
    fs.writeFileSync(apiPath, api)
  }
  patchCopiedFile(path.join(TEST_EXT_DIR, "background.js"), [
    ["const API_BASE = 'https://api.listjetgo.com'", `const API_BASE = '${LOCAL_API}'`],
  ])
  const manifestPath = path.join(TEST_EXT_DIR, "manifest.json")
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    name: string
    host_permissions: string[]
  }
  manifest.name = "ListJetGo Stock Guard LOCAL TEST"
  const hosts = new Set(manifest.host_permissions || [])
  hosts.add("http://localhost:4000/*")
  hosts.add("http://127.0.0.1:4000/*")
  manifest.host_permissions = [...hosts]
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n")
}

function writeLocalTestConfig(input: { accessToken: string; expiresAt: string; localTestKey: string }): void {
  fs.writeFileSync(
    path.join(TEST_EXT_DIR, "local-test-config.json"),
    JSON.stringify(
      {
        apiBase: LOCAL_API,
        accessToken: input.accessToken,
        expiresAt: input.expiresAt,
        localTestKey: input.localTestKey,
      },
      null,
      2
    ) + "\n"
  )
}

async function ensureLocalTestUser(): Promise<{ userId: string; email: string }> {
  const email = "stockguard.v2.local.e2e@localhost"
  const existing = await query<{ id: string }>(
    `SELECT id::text AS id FROM users WHERE email = $1 LIMIT 1`,
    [email]
  )
  let userId = existing.rows[0]?.id
  if (!userId) {
    const passwordHash = await hashPassword(crypto.randomBytes(24).toString("hex"))
    const created = await query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, approval_status, email_verified_at, requested_product)
       VALUES ($1, $2, 'user', 'active', NOW(), 'EBAY')
       RETURNING id::text AS id`,
      [email, passwordHash]
    ).catch(async () =>
      query<{ id: string }>(
        `INSERT INTO users (email, password_hash, role, approval_status, email_verified_at)
         VALUES ($1, $2, 'user', 'active', NOW())
         RETURNING id::text AS id`,
        [email, passwordHash]
      )
    )
    userId = created.rows[0]?.id
    if (userId) {
      await query(
        `INSERT INTO password_credentials (user_id, password_hash)
         VALUES ($1::uuid, $2)
         ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = NOW()`,
        [userId, passwordHash]
      ).catch(() => undefined)
    }
  } else {
    await query(
      `UPDATE users
       SET approval_status = 'active',
           email_verified_at = COALESCE(email_verified_at, NOW()),
           updated_at = NOW()
       WHERE id = $1::uuid`,
      [userId]
    )
  }
  if (!userId) throw new Error("Failed to create local E2E user")
  await query(
    `INSERT INTO workspace_members (workspace_id, user_id, role)
     VALUES ($1::uuid, $2::uuid, 'owner')
     ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = 'owner'`,
    [WORKSPACE_ID, userId]
  )
  const primary = await query<{ workspace_id: string }>(
    `SELECT workspace_id::text AS workspace_id
     FROM workspace_members
     WHERE user_id = $1::uuid
     ORDER BY created_at ASC
     LIMIT 1`,
    [userId]
  )
  if (primary.rows[0]?.workspace_id !== WORKSPACE_ID) {
    throw new Error("Local E2E user primary workspace is not the catalog workspace")
  }
  await activateProductAccessForUser(userId, "EBAY")
  return { userId, email }
}

async function selectBatch(): Promise<{
  asins: string[]
  listingCount: number
  preferredPresent: string[]
}> {
  const rows = await query<{ asin: string; consumer_count: string }>(
    `SELECT g.asin, COUNT(*)::text AS consumer_count
     FROM global_asin_consumers c
     JOIN global_amazon_asins g ON g.id = c.global_asin_id
     JOIN store_catalog_state scs ON scs.id = c.catalog_state_id
     JOIN stores st ON st.id = c.store_id AND st.workspace_id = c.workspace_id
     WHERE ${GLOBAL_KEEPA_ACTIVE_CONSUMER_WHERE}
     GROUP BY g.asin
     ORDER BY CASE WHEN g.asin = ANY($1::text[]) THEN 0 ELSE 1 END,
              COUNT(*) DESC,
              g.asin ASC
     LIMIT $2::int`,
    [PREFERRED_ASINS, TARGET_UNIQUE]
  )
  const asins = rows.rows.map(r => r.asin)
  const listing = await query<{ c: string }>(
    `SELECT COUNT(*)::text AS c
     FROM global_asin_consumers c
     JOIN global_amazon_asins g ON g.id = c.global_asin_id
     JOIN store_catalog_state scs ON scs.id = c.catalog_state_id
     JOIN stores st ON st.id = c.store_id AND st.workspace_id = c.workspace_id
     WHERE ${GLOBAL_KEEPA_ACTIVE_CONSUMER_WHERE}
       AND g.asin = ANY($1::text[])`,
    [asins]
  )
  return {
    asins,
    listingCount: parseInt(listing.rows[0]?.c ?? "0", 10) || 0,
    preferredPresent: PREFERRED_ASINS.filter(a => asins.includes(a)),
  }
}

type RunState = {
  startedAt: string
  asins: string[]
  listingCount: number
  keepa?: Record<string, unknown>
  stopReason?: string
}

function saveState(state: RunState): void {
  fs.mkdirSync(LOCAL_STATE_DIR, { recursive: true })
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n")
}

async function assertNoQty0InBatch(asins: string[]): Promise<void> {
  const eligible = await query<{ asin: string }>(
    `SELECT DISTINCT g.asin
     FROM global_asin_consumers c
     JOIN global_amazon_asins g ON g.id = c.global_asin_id
     JOIN store_catalog_state scs ON scs.id = c.catalog_state_id
     JOIN stores st ON st.id = c.store_id AND st.workspace_id = c.workspace_id
     WHERE ${GLOBAL_KEEPA_ACTIVE_CONSUMER_WHERE}
       AND g.asin = ANY($1::text[])`,
    [asins]
  )
  const ok = new Set(eligible.rows.map(r => r.asin))
  const missing = asins.filter(a => !ok.has(a))
  if (missing.length > 0) {
    throw new Error(`STOP: qty0-only or ineligible ASIN in batch: ${missing.join(",")}`)
  }
}

async function fetchServerVerificationStatus(): Promise<Record<string, unknown> | null> {
  try {
    const headers: Record<string, string> = {}
    const key = process.env.ADMIN_INTERNAL_API_KEY?.trim()
    if (key) headers["x-admin-internal-key"] = key
    const r = await fetch(`${LOCAL_API}/admin/platform/amazon-verification/status`, { headers })
    if (!r.ok) return null
    return (await r.json()) as Record<string, unknown>
  } catch {
    return null
  }
}

async function collectReport(state: RunState): Promise<Record<string, unknown>> {
  const asins = state.asins
  const snapshots = await query<{
    asin: string
    new_price: string | null
    amazon_price: string | null
    candidate_price: string | null
    new_fba_count: string | null
    new_fbm_count: string | null
    status: string | null
    signal_class: string | null
    checked_at: Date | null
  }>(
    `SELECT g.asin,
            s.new_price::text,
            s.amazon_price::text,
            s.candidate_price::text,
            s.new_fba_count::text,
            s.new_fbm_count::text,
            s.status,
            s.signal_class,
            s.checked_at
     FROM global_amazon_asins g
     LEFT JOIN global_keepa_snapshots s ON s.global_asin_id = g.id
     WHERE g.asin = ANY($1::text[])`,
    [asins]
  )
  const tasks = await query<{
    id: string
    asin: string
    status: string
    reason: string
    result_price: string | null
    result_is_prime: boolean | null
    result_is_fba: boolean | null
    result_metadata: unknown
    failure_code: string | null
    created_at: Date
  }>(
    `SELECT id::text, asin, status, reason, result_price::text, result_is_prime, result_is_fba,
            result_metadata, failure_code, created_at
     FROM amazon_price_verification_tasks
     WHERE asin = ANY($1::text[])
       AND created_at >= $2::timestamptz
     ORDER BY created_at ASC`,
    [asins, state.startedAt]
  )
  const decisions = await query<{
    asin: string
    last_verified_decision: string | null
    last_verified_source_price: string | null
  }>(
    `SELECT DISTINCT ON (g.asin)
            g.asin,
            scs.last_verified_decision,
            scs.last_verified_source_price::text
     FROM global_asin_consumers c
     JOIN global_amazon_asins g ON g.id = c.global_asin_id
     JOIN store_catalog_state scs ON scs.id = c.catalog_state_id
     WHERE g.asin = ANY($1::text[])
     ORDER BY g.asin, scs.updated_at DESC`,
    [asins]
  )
  const alerts = await query<{ c: string }>(
    `SELECT COUNT(*)::text AS c
     FROM stock_review_items
     WHERE asin = ANY($1::text[])
       AND updated_at >= $2::timestamptz
       AND review_status IN ('pending', 'processing', 'failed', 'actioned')
       AND source_status_reason IS DISTINCT FROM 'Resolved — verified source unchanged'`,
    [asins, state.startedAt]
  )
  const healthyAlerts = await query<{ c: string }>(
    `SELECT COUNT(*)::text AS c
     FROM stock_review_items
     WHERE asin = ANY($1::text[])
       AND created_at >= $2::timestamptz
       AND source_status_reason ILIKE '%no change%'`,
    [asins, state.startedAt]
  )
  const legacyJobs = await query<{ c: string }>(
    `SELECT COUNT(*)::text AS c
     FROM stock_guard_scan_jobs
     WHERE created_at >= $1::timestamptz
       AND job_type = 'source_scan'`,
    [state.startedAt]
  )
  const stuck = await query<{ c: string }>(
    `SELECT COUNT(*)::text AS c
     FROM amazon_price_verification_tasks
     WHERE asin = ANY($1::text[])
       AND created_at >= $2::timestamptz
       AND status IN ('CLAIMED', 'RUNNING')
       AND (lease_expires_at IS NULL OR lease_expires_at < NOW())`,
    [asins, state.startedAt]
  )
  const verificationAsins = new Set(tasks.rows.map(t => t.asin))
  const keepaDirectStable = asins.filter(a => !verificationAsins.has(a)).length
  const completed = tasks.rows.filter(t => t.status === "COMPLETED").length
  const retryable = tasks.rows.filter(t => t.status === "RETRYABLE" || t.status === "WAITING_FOR_WORKER").length
  const failed = tasks.rows.filter(t => t.status === "FAILED").length
  const decisionByAsin = new Map(decisions.rows.map(d => [d.asin, d.last_verified_decision]))
  let validSource = 0
  let priceChange = 0
  let noValid = 0
  let redirect = 0
  let technical = 0
  let other = 0
  for (const t of tasks.rows) {
    const outcome = decisionByAsin.get(t.asin)
    if (t.status === "RETRYABLE" || t.failure_code === "CAPTCHA" || t.reason === "KEEPA_UNRESOLVED") technical++
    else if (outcome === "VALID_SOURCE") validSource++
    else if (outcome === "CONFIRMED_NO_VALID_SOURCE") noValid++
    else if (outcome === "SOURCE_ASIN_REDIRECTED" || t.reason === "SOURCE_STALE") redirect++
    else if (t.reason === "PRICE_CHANGED") priceChange++
    else if (t.status === "COMPLETED" && outcome === "UNKNOWN") technical++
    else other++
  }
  const status = (await fetchServerVerificationStatus()) ?? (await getPlatformAmazonVerificationStatus())
  const mutations = {
    quantity: Number(status.ebayQuantityMutations ?? 0),
    price: Number(status.ebayPriceMutations ?? 0),
    end: Number(status.ebayEndMutations ?? 0),
    publish: Number(status.ebayPublishMutations ?? 0),
    realTotal: Number(status.ebayRealMutationTotal ?? 0),
  }
  const named: Record<string, unknown> = {}
  for (const asin of PREFERRED_ASINS) {
    const snap = snapshots.rows.find(s => s.asin === asin)
    const task = [...tasks.rows].reverse().find(t => t.asin === asin)
    const alert = await query<{ source_status: string; source_status_reason: string | null; review_status: string }>(
      `SELECT source_status, source_status_reason, review_status
       FROM stock_review_items
       WHERE asin = $1
         AND updated_at >= $2::timestamptz
       ORDER BY updated_at DESC
       LIMIT 1`,
      [asin, state.startedAt]
    )
    named[asin] = {
      keepa: snap
        ? {
            newPrice: snap.new_price,
            amazonPrice: snap.amazon_price,
            candidatePrice: snap.candidate_price,
            fba: snap.new_fba_count,
            fbm: snap.new_fbm_count,
            status: snap.status,
            signalClass: snap.signal_class,
          }
        : null,
      extension: task
        ? {
            status: task.status,
            reason: task.reason,
            resultPrice: task.result_price,
            isPrime: task.result_is_prime,
            isFba: task.result_is_fba,
            metadata: task.result_metadata,
            failureCode: task.failure_code,
          }
        : null,
      lastVerifiedDecision: decisionByAsin.get(asin) ?? null,
      stockAlert: alert.rows[0] ?? null,
    }
  }
  return {
    selectedUniqueAsins: asins.length,
    eligibleListingsRepresented: state.listingCount,
    keepa: state.keepa ?? null,
    keepaDirectStable,
    verificationRequested: verificationAsins.size,
    extensionTasks: tasks.rows.length,
    extensionCompleted: completed,
    extensionRetryable: retryable,
    extensionFailed: failed,
    VALID_SOURCE: validSource,
    PRICE_CHANGE: priceChange,
    NO_VALID_PRIME_FBA_SOURCE: noValid,
    ASIN_REDIRECT: redirect,
    TECHNICAL_UNCERTAINTY: technical,
    Other: other,
    stockAlertsCreatedOrUpdated: parseInt(alerts.rows[0]?.c ?? "0", 10) || 0,
    healthyNoOpStockAlerts: parseInt(healthyAlerts.rows[0]?.c ?? "0", 10) || 0,
    ebayQuantityMutations: mutations.quantity,
    ebayPriceMutations: mutations.price,
    ebayEndMutations: mutations.end,
    ebayPublishMutations: mutations.publish,
    ebayRealMutationTotal: mutations.realTotal,
    legacyDuplicateAutomatedScans: parseInt(legacyJobs.rows[0]?.c ?? "0", 10) || 0,
    onlineExtensionWorkers: Number(status.onlineWorkers ?? 0),
    stuckVerificationTasks: parseInt(stuck.rows[0]?.c ?? "0", 10) || 0,
    scannerMode: getStockGuardScannerMode(),
    verificationStatus: status,
    named,
    stopReason: state.stopReason ?? null,
  }
}

async function prepare(): Promise<{ userId: string; asins: string[]; listingCount: number }> {
  assertLocalDb()
  await query(`ALTER TABLE workspace_activity_events ADD COLUMN IF NOT EXISTS idempotency_key TEXT NULL`).catch(() => undefined)
  await query(
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_workspace_activity_idempotency
     ON workspace_activity_events (workspace_id, idempotency_key)
     WHERE idempotency_key IS NOT NULL`
  ).catch(() => undefined)
  const tokenSecret = envOrGenerate("EXTENSION_TOKEN_SECRET")
  const localTestKey = envOrGenerate("LOCAL_EXTENSION_TEST_AUTH_KEY")
  upsertEnv({
    EBAY_SIMULATION: "true",
    GLOBAL_KEEPA_MONITOR_ENABLED: "true",
    GLOBAL_KEEPA_PLANNER_ENABLED: "true",
    GLOBAL_KEEPA_TO_EXTENSION_DISPATCH_ENABLED: "true",
    GLOBAL_EXTENSION_VERIFICATION_ENABLED: "true",
    GLOBAL_EXTENSION_APPLY_SOURCE_PRICE: "true",
    ACTIVITY_CENTER_ENABLED: "true",
    VERIFIED_STOCK_ACTIONS_ENABLED: "false",
    GLOBAL_KEEPA_ACTIONS_ENABLED: "false",
    GLOBAL_KEEPA_CONTROLLED_RUN: "true",
    GLOBAL_KEEPA_TICK_INTERVAL_MS: "86400000",
    LOCAL_EXTENSION_TEST_AUTH: "true",
    EXTENSION_TOKEN_SECRET: tokenSecret,
    LOCAL_EXTENSION_TEST_AUTH_KEY: localTestKey,
  })
  process.env.EBAY_SIMULATION = "true"
  process.env.GLOBAL_KEEPA_MONITOR_ENABLED = "true"
  process.env.GLOBAL_KEEPA_PLANNER_ENABLED = "true"
  process.env.GLOBAL_KEEPA_TO_EXTENSION_DISPATCH_ENABLED = "true"
  process.env.GLOBAL_EXTENSION_VERIFICATION_ENABLED = "true"
  process.env.GLOBAL_EXTENSION_APPLY_SOURCE_PRICE = "true"
  process.env.ACTIVITY_CENTER_ENABLED = "true"
  process.env.VERIFIED_STOCK_ACTIONS_ENABLED = "false"
  process.env.GLOBAL_KEEPA_ACTIONS_ENABLED = "false"
  process.env.GLOBAL_KEEPA_CONTROLLED_RUN = "true"
  process.env.LOCAL_EXTENSION_TEST_AUTH = "true"
  const user = await ensureLocalTestUser()
  upsertEnv({ LOCAL_EXTENSION_TEST_USER_ID: user.userId })
  process.env.LOCAL_EXTENSION_TEST_USER_ID = user.userId
  copyTestExtension()
  const issued = issueExtensionToken(user.userId)
  writeLocalTestConfig({
    accessToken: issued.accessToken,
    expiresAt: issued.expiresAt,
    localTestKey,
  })
  const batch = await selectBatch()
  console.log("PREPARE_OK", {
    uniqueAsins: batch.asins.length,
    listings: batch.listingCount,
    preferredPresent: batch.preferredPresent,
    testUserEmail: user.email,
    testExtensionDir: TEST_EXT_DIR,
    secretPresent: tokenSecret.length >= 32,
  })
  return { userId: user.userId, asins: batch.asins, listingCount: batch.listingCount }
}

async function main(): Promise<void> {
  assertLocalDb()
  const collectOnly = process.argv.includes("--collect")
  const prepareOnly = process.argv.includes("--prepare-only")
  if (!collectOnly) {
    const prep = await prepare()
    if (prepareOnly) return
    const cfg = loadAmazonVerificationConfig()
    const keepaCfg = loadGlobalKeepaFoundationConfig()
    if (!cfg.verificationEnabled || !cfg.keepaDispatchEnabled || !keepaCfg.monitorEnabled || !keepaCfg.plannerEnabled) {
      throw new Error("V2 flags are not enabled in this process — restart backend after env upsert")
    }
    if (cfg.verifiedStockActionsEnabled) throw new Error("VERIFIED_STOCK_ACTIONS_ENABLED must stay false")
    if (keepaCfg.actionsEnabled) throw new Error("GLOBAL_KEEPA_ACTIONS_ENABLED must stay false")
    await assertNoQty0InBatch(prep.asins)
    const startedAt = new Date().toISOString()
    const state: RunState = {
      startedAt,
      asins: prep.asins,
      listingCount: prep.listingCount,
    }
    saveState(state)
    const keepa = await runGlobalKeepaPlannerForAsins({
      asins: prep.asins,
      live: true,
      batchSize: 10,
    })
    state.keepa = keepa as unknown as Record<string, unknown>
    if (!keepa.ok && keepa.errorCode) {
      state.stopReason = `Keepa technical failure ${keepa.errorCode}`
    }
    const serverStatus = await fetchServerVerificationStatus()
    if (Number(serverStatus?.ebayRealMutationTotal ?? 0) > 0) {
      state.stopReason = "REAL_EBAY_MUTATION"
    }
    saveState(state)
    console.log("KEEPA_BATCH", keepa)
  }
  const raw = fs.existsSync(STATE_FILE) ? (JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as RunState) : null
  if (!raw) throw new Error("No E2E state file — run without --collect first")
  const report = await collectReport(raw)
  const reportPath = path.join(LOCAL_STATE_DIR, "stock-guard-v2-50-report.json")
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n")
  const pass =
    (report.ebayRealMutationTotal as number) === 0 &&
    (report.legacyDuplicateAutomatedScans as number) === 0 &&
    (report.stuckVerificationTasks as number) === 0 &&
    (report.healthyNoOpStockAlerts as number) === 0 &&
    !raw.stopReason
  console.log("STOCK_GUARD_V2_LOCAL_50_E2E =", pass ? "PASS" : "FAIL")
  console.log(JSON.stringify(report, null, 2))
}

main()
  .catch(err => {
    console.error(err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
  .finally(() => closeDbPool())

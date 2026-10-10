/**
 * FAZ 1.1 local/staging DB validation. No Keepa API, no eBay mutations.
 * Usage:
 *   npx ts-node --transpile-only scripts/global-keepa-phase11-validate.ts [--apply-migration]
 */
import "dotenv/config"
import fs from "fs"
import path from "path"
import { Pool } from "pg"
import { closeDbPool, query } from "../db/client"
import { UPSERT_GLOBAL_AMAZON_ASIN_SQL } from "../modules/globalKeepa/globalAsinBackfillCore"
import { syncGlobalAsinConsumerForCatalog } from "../modules/globalKeepa/globalAsinConsumerSync"
import { UPSERT_GLOBAL_KEEPA_SNAPSHOT_SQL } from "../modules/globalKeepa/globalKeepaSnapshot"
import { recordPlatformKeepaTokensFromResponse } from "../modules/globalKeepa/keepaPlatformTokenState"

const connectionString = process.env.DATABASE_URL
if (!connectionString) throw new Error("DATABASE_URL is not defined")
const dbUrl: string = connectionString

function assertLocalOrStagingDb(): void {
  const u = new URL(dbUrl)
  const host = (u.hostname || "").toLowerCase()
  const allowed =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    process.env.ALLOW_GLOBAL_KEEPA_PHASE11 === "1"
  if (!allowed) {
    throw new Error(
      `Refusing FAZ 1.1 DB writes: host=${host} is not local. Set ALLOW_GLOBAL_KEEPA_PHASE11=1 for staging.`
    )
  }
  console.log("DB_TARGET", { host, port: u.port || "5432", database: u.pathname.replace(/^\//, "") })
}

async function tableExists(name: string): Promise<boolean> {
  const res = await query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM information_schema.tables
     WHERE table_schema='public' AND table_name=$1`,
    [name]
  )
  return (parseInt(res.rows[0]?.c ?? "0", 10) || 0) > 0
}

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const res = await query<{ c: string }>(sql, params)
  return parseInt(res.rows[0]?.c ?? "0", 10) || 0
}

async function safeCount(table: string): Promise<number | null> {
  if (!(await tableExists(table))) return null
  return count(`SELECT COUNT(*)::text AS c FROM ${table}`)
}

async function productionFingerprint() {
  const pick = async (table: string, extraSql?: string) => {
    if (!(await tableExists(table))) return { exists: false as const }
    const c = await count(`SELECT COUNT(*)::text AS c FROM ${table}`)
    const extra = extraSql
      ? (await query<{ m: string | null }>(extraSql)).rows[0] ?? null
      : null
    return { exists: true as const, count: c, extra }
  }
  return {
    asin_registry: await pick("asin_registry", "SELECT MAX(updated_at)::text AS m FROM asin_registry"),
    store_catalog_state: await pick(
      "store_catalog_state",
      "SELECT MAX(id)::text || '|' || COALESCE(MAX(updated_at)::text,'') AS m FROM store_catalog_state"
    ),
    amazon_product_cache: await pick(
      "amazon_product_cache",
      "SELECT MAX(updated_at)::text AS m FROM amazon_product_cache"
    ),
    stock_guard_scan_jobs: await pick(
      "stock_guard_scan_jobs",
      "SELECT MAX(id)::text AS m FROM stock_guard_scan_jobs"
    ),
    stock_review_items: await pick(
      "stock_review_items",
      "SELECT MAX(updated_at)::text AS m FROM stock_review_items"
    ),
    keepa_token_state: await pick(
      "keepa_token_state",
      "SELECT COUNT(*)::text || '|' || COALESCE(MAX(tokens_updated_at)::text,'') AS m FROM keepa_token_state"
    ),
  }
}

async function applyMigrationIfRequested(): Promise<void> {
  if (process.argv.includes("--fingerprint-only")) {
    console.log("MIGRATION_SKIP fingerprint-only")
    return
  }
  const tables = ["global_amazon_asins", "global_asin_consumers", "global_keepa_snapshots", "keepa_platform_token_state"]
  const missing = []
  for (const t of tables) {
    if (!(await tableExists(t))) missing.push(t)
  }
  const shouldApply = process.argv.includes("--apply-migration") || missing.length > 0
  if (!shouldApply) {
    console.log("MIGRATION_SKIP existing foundation tables present")
    return
  }
  assertLocalOrStagingDb()
  const sql = fs.readFileSync(
    path.join(__dirname, "../migrations/054_global_keepa_foundation.sql"),
    "utf8"
  )
  const pool = new Pool({ connectionString: dbUrl })
  await pool.query(sql)
  await pool.end()
  console.log("APPLIED migrations/054_global_keepa_foundation.sql")
}

async function main(): Promise<void> {
  assertLocalOrStagingDb()
  const before = await productionFingerprint()
  console.log("PRODUCTION_FINGERPRINT_BEFORE", JSON.stringify(before))

  await applyMigrationIfRequested()
  if (process.argv.includes("--fingerprint-only")) {
    const existing = []
    for (const t of [
      "global_amazon_asins",
      "global_asin_consumers",
      "global_keepa_snapshots",
      "keepa_platform_token_state",
    ]) {
      existing.push({ table: t, exists: await tableExists(t) })
    }
    console.log("FOUNDATION_TABLES_BEFORE_MIGRATION", existing)
    return
  }

  const tables = await query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema='public' AND table_name IN (
       'global_amazon_asins','global_asin_consumers','global_keepa_snapshots','keepa_platform_token_state'
     )
     ORDER BY table_name`
  )
  console.log("FOUNDATION_TABLES", tables.rows.map(r => r.table_name))

  const constraints = await query<{ table_name: string; conname: string; def: string }>(
    `SELECT c.conrelid::regclass::text AS table_name, c.conname, pg_get_constraintdef(c.oid) AS def
     FROM pg_constraint c
     WHERE c.conrelid::regclass::text IN ('global_amazon_asins','global_asin_consumers','global_keepa_snapshots','keepa_platform_token_state')
     ORDER BY 1, 2`
  )
  console.log("CONSTRAINTS", constraints.rows)

  const indexes = await query<{ tablename: string; indexname: string; indexdef: string }>(
    `SELECT tablename, indexname, indexdef FROM pg_indexes
     WHERE schemaname='public'
       AND tablename IN ('global_amazon_asins','global_asin_consumers','global_keepa_snapshots','keepa_platform_token_state')
     ORDER BY tablename, indexname`
  )
  console.log("INDEXES", indexes.rows)

  if (process.argv.includes("--schema-only")) {
    const after = await productionFingerprint()
    console.log("PRODUCTION_FINGERPRINT_AFTER", JSON.stringify(after))
    console.log("PRODUCTION_FINGERPRINT_EQUAL", JSON.stringify(before) === JSON.stringify(after))
    return
  }

  const foundationCounts = {
    global_amazon_asins: await safeCount("global_amazon_asins"),
    global_asin_consumers: await safeCount("global_asin_consumers"),
    global_keepa_snapshots: await safeCount("global_keepa_snapshots"),
    keepa_platform_token_state: await safeCount("keepa_platform_token_state"),
  }
  console.log("FOUNDATION_COUNTS", foundationCounts)

  const orphan = await count(`
    SELECT COUNT(*)::text AS c FROM global_asin_consumers c
    LEFT JOIN global_amazon_asins g ON g.id = c.global_asin_id
    WHERE g.id IS NULL
  `)
  const dupCatalog = await count(`
    SELECT COUNT(*)::text AS c FROM (
      SELECT catalog_state_id FROM global_asin_consumers GROUP BY catalog_state_id HAVING COUNT(*) > 1
    ) x
  `)
  const dupGlobal = await count(`
    SELECT COUNT(*)::text AS c FROM (
      SELECT keepa_domain, asin FROM global_amazon_asins GROUP BY keepa_domain, asin HAVING COUNT(*) > 1
    ) x
  `)
  const mismatch = await count(`
    SELECT COUNT(*)::text AS c
    FROM global_asin_consumers c
    JOIN store_catalog_state scs ON scs.id = c.catalog_state_id
    WHERE scs.workspace_id IS DISTINCT FROM c.workspace_id
       OR scs.store_id IS DISTINCT FROM c.store_id
  `)
  console.log("INTEGRITY", { orphan, dupCatalog, dupGlobal, mismatch })
  if (orphan !== 0 || dupCatalog !== 0 || dupGlobal !== 0 || mismatch !== 0) {
    throw new Error(`INTEGRITY failed ${JSON.stringify({ orphan, dupCatalog, dupGlobal, mismatch })}`)
  }

  const crossWs = await query<{
    asin: string
    global_asin_id: string
    workspace_id: string
    store_id: string
    catalog_state_id: string
  }>(
    `WITH shared AS (
       SELECT g.asin
       FROM global_asin_consumers c
       JOIN global_amazon_asins g ON g.id = c.global_asin_id
       GROUP BY g.keepa_domain, g.asin
       HAVING COUNT(DISTINCT c.workspace_id) > 1
       ORDER BY COUNT(*) DESC
       LIMIT 8
     )
     SELECT g.asin,
            c.global_asin_id::text,
            c.workspace_id::text,
            c.store_id::text,
            c.catalog_state_id::text
     FROM global_asin_consumers c
     JOIN global_amazon_asins g ON g.id = c.global_asin_id
     JOIN shared s ON s.asin = g.asin
     ORDER BY g.asin, c.workspace_id, c.store_id`
  )
  console.log("CROSS_WORKSPACE_SAMPLES", crossWs.rows)

  const multiStore = await query<{
    asin: string
    global_asin_id: string
    workspace_id: string
    store_id: string
    catalog_state_id: string
  }>(
    `WITH multi AS (
       SELECT g.asin, c.workspace_id
       FROM global_asin_consumers c
       JOIN global_amazon_asins g ON g.id = c.global_asin_id
       GROUP BY g.asin, c.workspace_id
       HAVING COUNT(DISTINCT c.store_id) > 1
       ORDER BY COUNT(*) DESC
       LIMIT 5
     )
     SELECT g.asin, c.global_asin_id::text, c.workspace_id::text, c.store_id::text, c.catalog_state_id::text
     FROM global_asin_consumers c
     JOIN global_amazon_asins g ON g.id = c.global_asin_id
     JOIN multi m ON m.asin = g.asin AND m.workspace_id = c.workspace_id
     ORDER BY g.asin, c.store_id`
  )
  console.log("MULTI_STORE_SAMPLES", multiStore.rows)

  const reusedAsins = await query<{
    asin: string
    global_asin_id: string
    workspace_id: string
    store_id: string
    catalog_state_id: string
  }>(
    `WITH reused AS (
       SELECT g.asin
       FROM global_asin_consumers c
       JOIN global_amazon_asins g ON g.id = c.global_asin_id
       GROUP BY g.keepa_domain, g.asin
       HAVING COUNT(*) > 1
       ORDER BY COUNT(*) DESC
       LIMIT 5
     )
     SELECT g.asin, c.global_asin_id::text, c.workspace_id::text, c.store_id::text, c.catalog_state_id::text
     FROM global_asin_consumers c
     JOIN global_amazon_asins g ON g.id = c.global_asin_id
     JOIN reused r ON r.asin = g.asin
     ORDER BY g.asin, c.store_id, c.catalog_state_id`
  )
  console.log("REUSED_ASIN_SAMPLES", reusedAsins.rows)

  const sample = await query<{
    workspace_id: string
    store_id: number
    catalog_state_id: number
    asin: string
    global_asin_id: string
  }>(
    `SELECT c.workspace_id::text, c.store_id, c.catalog_state_id, g.asin, c.global_asin_id::text
     FROM global_asin_consumers c
     JOIN global_amazon_asins g ON g.id = c.global_asin_id
     ORDER BY c.id
     LIMIT 1`
  )
  if (sample.rows[0]) {
    const row = sample.rows[0]
    const originalAsin = row.asin
    const originalGid = row.global_asin_id
    await syncGlobalAsinConsumerForCatalog({
      workspaceId: row.workspace_id,
      storeId: Number(row.store_id),
      catalogStateId: Number(row.catalog_state_id),
      asin: "B0FAZ11LC1",
    })
    const moved = await query<{ global_asin_id: string; asin: string; n: string }>(
      `SELECT c.global_asin_id::text, g.asin, COUNT(*) OVER ()::text AS n
       FROM global_asin_consumers c
       JOIN global_amazon_asins g ON g.id = c.global_asin_id
       WHERE c.catalog_state_id = $1`,
      [row.catalog_state_id]
    )
    await syncGlobalAsinConsumerForCatalog({
      workspaceId: row.workspace_id,
      storeId: Number(row.store_id),
      catalogStateId: Number(row.catalog_state_id),
      asin: originalAsin,
    })
    const restored = await query<{ global_asin_id: string; asin: string }>(
      `SELECT c.global_asin_id::text, g.asin
       FROM global_asin_consumers c
       JOIN global_amazon_asins g ON g.id = c.global_asin_id
       WHERE c.catalog_state_id = $1`,
      [row.catalog_state_id]
    )
    console.log("SOURCE_ASIN_LIFECYCLE", {
      catalog_state_id: row.catalog_state_id,
      original_asin: originalAsin,
      original_global_asin_id: originalGid,
      after_move: moved.rows,
      after_restore: restored.rows[0],
      restored_ok: restored.rows[0]?.asin === originalAsin,
      still_one_consumer: moved.rows.length === 1,
    })
    if (moved.rows[0]?.asin !== "B0FAZ11LC1") {
      throw new Error("SOURCE_ASIN_LIFECYCLE move failed")
    }
    if (moved.rows.length !== 1) {
      throw new Error("SOURCE_ASIN_LIFECYCLE duplicate consumer after move")
    }
    if (restored.rows[0]?.asin !== originalAsin) {
      throw new Error("SOURCE_ASIN_LIFECYCLE restore failed")
    }
  } else {
    console.log("SOURCE_ASIN_LIFECYCLE", { skipped: true, reason: "no consumers yet" })
  }

  const dummy = await query<{ id: number; inserted: boolean }>(UPSERT_GLOBAL_AMAZON_ASIN_SQL, [
    1,
    "B0FAZ11SN1",
    2,
  ])
  const gid = Number(dummy.rows[0]?.id)
  const t0 = new Date("2026-08-01T00:00:00Z")
  const t1 = new Date("2026-08-02T00:00:00Z")
  await query(UPSERT_GLOBAL_KEEPA_SNAPSHOT_SQL, [
    gid, 24.99, 2, 0, null, null, null, t0, t0, 1, 1, t0, null, "KEEPA_OK", "CONFIRMED_FBA",
  ])
  await query(UPSERT_GLOBAL_KEEPA_SNAPSHOT_SQL, [
    gid, 29.99, 1, 3, 24.99, 2, 0, t1, t1, 2, 2, t1, t0, "PRICE_AMBIGUOUS", "AMBIGUOUS",
  ])
  const snap = await query<{
    new_price: string
    new_fba_count: number
    new_fbm_count: number
    previous_new_price: string | null
    previous_new_fba_count: number | null
    previous_new_fbm_count: number | null
    status: string
    price_confidence: string
  }>(
    `SELECT new_price::text, new_fba_count, new_fbm_count,
            previous_new_price::text, previous_new_fba_count, previous_new_fbm_count,
            status, price_confidence
     FROM global_keepa_snapshots WHERE global_asin_id=$1`,
    [gid]
  )
  console.log("SNAPSHOT_ROW", snap.rows[0])
  if (
    Number(snap.rows[0]?.new_price) !== 29.99 ||
    Number(snap.rows[0]?.new_fba_count) !== 1 ||
    Number(snap.rows[0]?.new_fbm_count) !== 3 ||
    Number(snap.rows[0]?.previous_new_price) !== 24.99 ||
    Number(snap.rows[0]?.previous_new_fba_count) !== 2 ||
    Number(snap.rows[0]?.previous_new_fbm_count) !== 0
  ) {
    throw new Error("SNAPSHOT previous/current fixture failed")
  }

  const tokenBefore = await query<{ c: string; m: string | null }>(
    `SELECT COUNT(*)::text AS c, MAX(tokens_updated_at)::text AS m FROM keepa_token_state`
  )
  await recordPlatformKeepaTokensFromResponse(
    { tokensLeft: 777, refillRate: 60, refillIn: 1000, tokensConsumed: 2, processingTimeInMs: 5 },
    { rollingTokensConsumed1h: 10, rollingTokensConsumed24h: 80 }
  )
  const platform = await query(
    `SELECT tokens_left, refill_rate, refill_in, last_tokens_consumed,
            rolling_tokens_consumed_1h, rolling_tokens_consumed_24h, last_api_response_at
     FROM keepa_platform_token_state WHERE id=1`
  )
  const tokenAfter = await query<{ c: string; m: string | null }>(
    `SELECT COUNT(*)::text AS c, MAX(tokens_updated_at)::text AS m FROM keepa_token_state`
  )
  console.log("PLATFORM_TOKEN", platform.rows[0])
  console.log("WORKSPACE_TOKEN_UNCHANGED", {
    before: tokenBefore.rows[0],
    after: tokenAfter.rows[0],
    unchanged:
      tokenBefore.rows[0]?.c === tokenAfter.rows[0]?.c &&
      tokenBefore.rows[0]?.m === tokenAfter.rows[0]?.m,
  })
  if (
    tokenBefore.rows[0]?.c !== tokenAfter.rows[0]?.c ||
    tokenBefore.rows[0]?.m !== tokenAfter.rows[0]?.m
  ) {
    throw new Error("workspace keepa_token_state mutated by platform token fixture")
  }
  if (Number(platform.rows[0]?.tokens_left) !== 777) {
    throw new Error("platform token state fixture failed")
  }

  const explains = [
    ["active_asins", `EXPLAIN SELECT id FROM global_amazon_asins WHERE is_active = TRUE ORDER BY next_check_at NULLS FIRST`],
    ["consumers_by_global", `EXPLAIN SELECT * FROM global_asin_consumers WHERE global_asin_id = 1`],
    ["catalog_to_global", `EXPLAIN SELECT global_asin_id FROM global_asin_consumers WHERE catalog_state_id = 1`],
    ["domain_asin", `EXPLAIN SELECT id FROM global_amazon_asins WHERE keepa_domain = 1 AND asin = 'B0FAZ11SN1'`],
    ["asin_consumer_count", `EXPLAIN SELECT COUNT(*) FROM global_asin_consumers c JOIN global_amazon_asins g ON g.id=c.global_asin_id WHERE g.asin='B0FAZ11SN1'`],
    ["workspace_consumers", `EXPLAIN SELECT COUNT(*) FROM global_asin_consumers WHERE workspace_id = '00000000-0000-0000-0000-000000000001'`],
  ] as const
  for (const [name, sql] of explains) {
    const plan = await query(sql)
    const text = plan.rows.map(r => Object.values(r)[0]).join(" | ")
    console.log("EXPLAIN", name, text)
  }

  const after = await productionFingerprint()
  console.log("PRODUCTION_FINGERPRINT_AFTER", JSON.stringify(after))
  console.log(
    "PRODUCTION_FINGERPRINT_EQUAL",
    JSON.stringify(before) === JSON.stringify(after)
  )
}

void main()
  .catch(e => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => {
    void closeDbPool()
  })

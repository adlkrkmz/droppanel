/**
 * Isolated LIVE Keepa /product contract test.
 * READ-only HTTP. No DB. Not imported by production runtime.
 */
import "dotenv/config"
import { shouldCreatePriceVerificationTask } from "../modules/amazonVerification/amazonVerificationPolicy"
import { loadAmazonVerificationConfig } from "../modules/amazonVerification/amazonVerificationConfig"
import { loadGlobalKeepaFoundationConfig } from "../modules/globalKeepa/globalKeepaConfig"
import {
  buildGlobalKeepaProductUrl,
  fetchGlobalKeepaProducts,
} from "../modules/globalKeepa/globalKeepaProductClient"
import { classifyKeepaRadarProduct } from "../modules/globalKeepa/keepaRadarClassifier"
import {
  extractKeepaRadarProductFields,
  extractKeepaTokenFields,
  mapKeepaProductsByAsin,
} from "../modules/globalKeepa/keepaRadarParser"
import { KEEPA_CSV_INDEX } from "../modules/keepa/keepaPriceTypes"
import type { KeepaApiProduct, KeepaApiResponse } from "../modules/keepa/keepaTypes"

const LIVE_ASINS = [
  "B07FZ8S74R",
  "B08N5WRWNW",
  "B09B8V1LZ3",
  "B00OQVZDJM",
  "B0BRDZVJHV",
  "B09TV5SHFD",
  "B072ZV2M29",
  "B0D436YVRZ",
  "B0DS4RMGTQ",
  "B000HBNV58",
  "B093D7Y3F2",
  "B0CKXGVG2G",
  "B0CPFTDT6P",
  "B0GGQV6YRN",
  "B0G6F1X3GG",
  "B0GJ3WNWJQ",
  "B0GQSYKBG9",
  "B08CFSZLQ4",
  "B07XJ8C8F5",
  "B08F6P2NS8",
  "B07PGL2ZSL",
  "B09G9FPHY6",
  "B0BSHF7WHW",
  "B07L5H6P5Z",
  "B00K5W7K2S",
]

const INVALID_ASIN = "B0NOTFOUND"
const TOKEN_RESERVE_AFTER_100 = 40

type Row = {
  asin: string
  newUsd: number | null
  fba: number | null
  fbm: number | null
  lastUpdate: string | null
  lastPriceChange: string | null
  classification: string
  currentLen: number | null
  rawNew: number | null
  rawFba: number | null
  rawFbm: number | null
}

type BatchResult = {
  name: string
  requested: number
  returned: number
  missing: string[]
  httpStatus: number | null
  httpRequests: number
  tokensLeft: number | null
  refillRate: number | null
  refillIn: number | null
  tokensConsumed: number | null
  processingTimeInMs: number | null
  wallClockMs: number
  rows: Row[]
  ok: boolean
  stop?: string
  error?: string
}

let httpRequestCount = 0
const originalFetch = globalThis.fetch

function envFlagRaw(name: string): string {
  const raw = process.env[name]
  if (raw == null || raw.trim() === "") return "UNSET"
  return raw.trim()
}

function redact(message: string): string {
  const key = process.env.KEEPA_API_KEY?.trim()
  if (key && message.includes(key)) return message.split(key).join("[REDACTED]")
  return message.replace(/[?&]key=[^&]+/gi, "[REDACTED_KEY]")
}

function isoOrNull(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null
}

function csvSlot(product: KeepaApiProduct | undefined, index: number): { present: boolean; value: number | null } {
  const current = product?.stats?.current
  if (!Array.isArray(current) || index >= current.length) return { present: false, value: null }
  const v = current[index]
  if (v == null) return { present: true, value: null }
  if (typeof v !== "number" || !Number.isFinite(v)) return { present: true, value: null }
  return { present: true, value: v }
}

function installHttpCounter(): void {
  httpRequestCount = 0
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    httpRequestCount += 1
    return originalFetch(input, init)
  }) as typeof fetch
}

function restoreFetch(): void {
  globalThis.fetch = originalFetch
}

function tokenFields(body: KeepaApiResponse | null | undefined) {
  return extractKeepaTokenFields(body)
}

function assertUrlContract(domain: number, asins: string[]): void {
  const url = buildGlobalKeepaProductUrl({
    apiKey: "REDACTED_PLACEHOLDER",
    domain,
    asins,
  })
  const u = new URL(url)
  const names = [...u.searchParams.keys()].sort()
  if (u.searchParams.get("stats") !== "1") throw new Error("URL missing stats=1")
  if (u.searchParams.get("history") !== "0") throw new Error("URL missing history=0")
  if (names.includes("offers") || names.includes("buybox") || names.includes("stock") || names.includes("update")) {
    throw new Error(`URL has forbidden params: ${names.join(",")}`)
  }
  if (u.pathname !== "/product") throw new Error("URL path is not /product")
  console.log("URL_CONTRACT", {
    path: "/product",
    paramNames: names.filter(n => n !== "key"),
    stats: "1",
    history: "0",
    offers: "NO",
    buybox: "NO",
    stock: "NO",
    update: "NO",
    asinCount: asins.length,
    commaSeparatedAsin: asins.length > 1,
  })
}

function mapRows(requested: string[], body: KeepaApiResponse | null): { rows: Row[]; missing: string[] } {
  const byAsin = mapKeepaProductsByAsin(body?.products)
  const rows: Row[] = []
  const missing: string[] = []
  for (const asin of requested) {
    const product = byAsin.get(asin)
    const classified = classifyKeepaRadarProduct({ requestedAsin: asin, product })
    if (classified.status === "PRODUCT_NOT_RETURNED") missing.push(asin)
    const fields = product ? extractKeepaRadarProductFields(product) : null
    const rawNew = csvSlot(product, KEEPA_CSV_INDEX.NEW)
    const rawFba = csvSlot(product, KEEPA_CSV_INDEX.COUNT_NEW_FBA)
    const rawFbm = csvSlot(product, KEEPA_CSV_INDEX.COUNT_NEW_FBM)
    rows.push({
      asin,
      newUsd: fields?.newPriceUsd ?? null,
      fba: fields?.newFbaCount ?? null,
      fbm: fields?.newFbmCount ?? null,
      lastUpdate: isoOrNull(fields?.lastUpdateAt),
      lastPriceChange: isoOrNull(fields?.lastPriceChangeAt),
      classification: classified.status,
      currentLen: Array.isArray(product?.stats?.current) ? product!.stats!.current!.length : null,
      rawNew: rawNew.value,
      rawFba: rawFba.value,
      rawFbm: rawFbm.value,
    })
  }
  return { rows, missing }
}

async function runBatch(name: string, asins: string[], timeoutMs: number): Promise<BatchResult> {
  const unique = [...new Set(asins.map(a => a.trim().toUpperCase()))]
  installHttpCounter()
  const started = Date.now()
  try {
    const fetched = await fetchGlobalKeepaProducts({
      apiKey: process.env.KEEPA_API_KEY!.trim(),
      domain: loadGlobalKeepaFoundationConfig().keepaDomain,
      asins: unique,
      timeoutMs,
    })
    const wallClockMs = Date.now() - started
    const tokens = tokenFields(fetched.body)
    if (!fetched.ok) {
      return {
        name,
        requested: unique.length,
        returned: fetched.body?.products?.length ?? 0,
        missing: unique,
        httpStatus: fetched.status,
        httpRequests: httpRequestCount,
        tokensLeft: tokens.tokensLeft,
        refillRate: tokens.refillRate,
        refillIn: tokens.refillIn,
        tokensConsumed: tokens.tokensConsumed,
        processingTimeInMs: tokens.processingTimeInMs,
        wallClockMs,
        rows: [],
        ok: false,
        error: redact(fetched.message),
      }
    }
    const mapped = mapRows(unique, fetched.body)
    return {
      name,
      requested: unique.length,
      returned: unique.length - mapped.missing.length,
      missing: mapped.missing,
      httpStatus: fetched.status,
      httpRequests: httpRequestCount,
      tokensLeft: tokens.tokensLeft,
      refillRate: tokens.refillRate,
      refillIn: tokens.refillIn,
      tokensConsumed: tokens.tokensConsumed,
      processingTimeInMs: tokens.processingTimeInMs,
      wallClockMs,
      rows: mapped.rows,
      ok: fetched.status >= 200 && fetched.status < 300 && mapped.rows.length === unique.length,
    }
  } catch (e) {
    return {
      name,
      requested: unique.length,
      returned: 0,
      missing: unique,
      httpStatus: null,
      httpRequests: httpRequestCount,
      tokensLeft: null,
      refillRate: null,
      refillIn: null,
      tokensConsumed: null,
      processingTimeInMs: null,
      wallClockMs: Date.now() - started,
      rows: [],
      ok: false,
      error: redact(e instanceof Error ? e.message : String(e)),
    }
  } finally {
    restoreFetch()
  }
}

function printBatch(result: BatchResult): void {
  console.log(`\n=== ${result.name} ===`)
  console.log({
    httpStatus: result.httpStatus,
    requestedAsins: result.requested,
    returnedProducts: result.returned,
    missing: result.missing.length,
    missingAsins: result.missing,
    httpRequests: result.httpRequests,
    tokensLeft: result.tokensLeft,
    refillRate: result.refillRate,
    refillIn: result.refillIn,
    tokensConsumed: result.tokensConsumed,
    processingTimeInMs: result.processingTimeInMs,
    wallClockMs: result.wallClockMs,
    ok: result.ok,
    error: result.error ?? null,
  })
  for (const row of result.rows.slice(0, 20)) {
    console.log("ASIN_ROW", {
      asin: row.asin,
      NEW: row.newUsd,
      COUNT_NEW_FBA: row.fba,
      COUNT_NEW_FBM: row.fbm,
      lastUpdate: row.lastUpdate,
      lastPriceChange: row.lastPriceChange,
      classification: row.classification,
      currentLen: row.currentLen,
      rawCurrent1: row.rawNew,
      rawCurrent34: row.rawFba,
      rawCurrent35: row.rawFbm,
    })
  }
}

function fieldStatus(rows: Row[], kind: "new" | "fba" | "fbm" | "lastUpdate" | "lastPriceChange"): string {
  const present = rows.filter(r => r.classification !== "PRODUCT_NOT_RETURNED")
  if (present.length === 0) return "NOT_VERIFIED"
  const values = present.map(r => {
    if (kind === "new") return r.rawNew
    if (kind === "fba") return r.rawFba
    if (kind === "fbm") return r.rawFbm
    if (kind === "lastUpdate") return r.lastUpdate
    return r.lastPriceChange
  })
  const anyPresent = present.some(r => {
    if (kind === "new" || kind === "fba" || kind === "fbm") return r.currentLen != null && r.currentLen > (kind === "new" ? 1 : kind === "fba" ? 34 : 35)
    if (kind === "lastUpdate") return r.lastUpdate != null
    return r.lastPriceChange != null
  })
  const anyValid = values.some(v => v != null && v !== -1)
  const anyNull = values.some(v => v == null || v === -1)
  if (!anyPresent && (kind === "lastUpdate" || kind === "lastPriceChange")) return anyNull ? "FIELD_ABSENT" : "NOT_VERIFIED"
  if (!anyPresent) return "FIELD_ABSENT"
  if (anyValid) return "FIELD_PRESENT VALUE_VALID"
  if (anyNull) return "FIELD_PRESENT VALUE_NULL"
  return "FIELD_PRESENT"
}

function findCases(rows: Row[]): { a: Row | null; b: Row | null; c: Row | null } {
  const usable = rows.filter(r => r.classification !== "PRODUCT_NOT_RETURNED")
  return {
    a: usable.find(r => r.newUsd != null && r.newUsd > 0 && r.fba != null && r.fba > 0 && r.fbm === 0) ?? null,
    b: usable.find(r => r.fba != null && r.fba > 0 && r.fbm != null && r.fbm > 0) ?? null,
    c: usable.find(r => r.fba === 0) ?? null,
  }
}

async function runMockHttpFailures(): Promise<void> {
  const cfg = loadGlobalKeepaFoundationConfig()
  const cases: Array<{ name: string; impl: () => Promise<Response> | never; expect: string }> = [
    {
      name: "429",
      impl: async () => new Response(JSON.stringify({ error: "token bucket empty" }), { status: 429 }),
      expect: "HTTP_429",
    },
    {
      name: "500",
      impl: async () => new Response(JSON.stringify({ error: "internal" }), { status: 500 }),
      expect: "HTTP_5XX",
    },
    {
      name: "malformed JSON",
      impl: async () => new Response("{not-json", { status: 200 }),
      expect: "MALFORMED_JSON",
    },
    {
      name: "timeout",
      impl: async () => {
        throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "AbortError" })
      },
      expect: "TIMEOUT",
    },
    {
      name: "network failure",
      impl: async () => {
        throw new Error("fetch failed")
      },
      expect: "NETWORK",
    },
  ]
  for (const c of cases) {
    globalThis.fetch = (async () => c.impl()) as typeof fetch
    const result = await fetchGlobalKeepaProducts({
      apiKey: "mock-key",
      domain: cfg.keepaDomain,
      asins: ["B07FZ8S74R"],
      timeoutMs: 1000,
    })
    restoreFetch()
    if (result.ok || result.code !== c.expect) {
      throw new Error(`Mock ${c.name} expected ${c.expect}, got ok=${result.ok} code=${"code" in result ? result.code : "OK"}`)
    }
    const classified = classifyKeepaRadarProduct({
      requestedAsin: "B07FZ8S74R",
      product: null,
      checkFailed: true,
    })
    if (classified.status !== "CHECK_FAILED") throw new Error("checkFailed must be CHECK_FAILED")
    console.log("MOCK_HTTP", { name: c.name, code: result.code, classification: classified.status })
  }
  const firstFail = shouldCreatePriceVerificationTask({
    source: "planner",
    signal: "CHECK_FAILED",
    verificationEnabled: true,
    dispatchEnabled: true,
    pendingTaskCount: 0,
    fallbackTasksLastMinute: 0,
    maxPending: 400,
    maxPerMinute: 20,
    keepaFailureCount: 1,
    keepaMaxRetries: 3,
    keepaOutage: false,
  })
  if (firstFail.create) throw new Error("first Keepa failure must not create verification task")
  console.log("MOCK_NO_VERIFICATION_FLOOD", { firstHttpFailureCreatesTask: false, code: firstFail.code })
}

async function main(): Promise<void> {
  const cfg = loadGlobalKeepaFoundationConfig()
  const vcfg = loadAmazonVerificationConfig()
  const keyPresent = Boolean(process.env.KEEPA_API_KEY?.trim())

  console.log("SAFETY_START", {
    GLOBAL_KEEPA_MONITOR_ENABLED: envFlagRaw("GLOBAL_KEEPA_MONITOR_ENABLED"),
    GLOBAL_KEEPA_ACTIONS_ENABLED: envFlagRaw("GLOBAL_KEEPA_ACTIONS_ENABLED"),
    GLOBAL_KEEPA_PLANNER_ENABLED: envFlagRaw("GLOBAL_KEEPA_PLANNER_ENABLED"),
    GLOBAL_KEEPA_SHADOW_MODE: envFlagRaw("GLOBAL_KEEPA_SHADOW_MODE"),
    GLOBAL_EXTENSION_VERIFICATION_ENABLED: envFlagRaw("GLOBAL_EXTENSION_VERIFICATION_ENABLED"),
    GLOBAL_KEEPA_TO_EXTENSION_DISPATCH_ENABLED: envFlagRaw("GLOBAL_KEEPA_TO_EXTENSION_DISPATCH_ENABLED"),
    loadedMonitorEnabled: cfg.monitorEnabled,
    loadedActionsEnabled: cfg.actionsEnabled,
    loadedPlannerEnabled: cfg.plannerEnabled,
    loadedKeepaDispatchEnabled: vcfg.keepaDispatchEnabled,
    KEEPA_API_KEY_PRESENT: keyPresent ? "YES" : "NO",
    domain: cfg.keepaDomain,
    dbImported: false,
    schedulerImported: false,
  })

  if (!keyPresent) {
    console.log("STOPPED_AFTER_1_ASIN")
    console.log("ROOT_CAUSE", "KEEPA_API_KEY missing")
    process.exitCode = 1
    return
  }

  assertUrlContract(cfg.keepaDomain, LIVE_ASINS.slice(0, 2))
  await runMockHttpFailures()

  const asins1 = LIVE_ASINS.slice(0, 1)
  const testA = await runBatch("TEST_A_1_ASIN", asins1, 25_000)
  printBatch(testA)
  if (!testA.ok || testA.httpStatus !== 200) {
    console.log("STOPPED_AFTER_1_ASIN")
    console.log("ROOT_CAUSE", testA.error ?? `HTTP ${testA.httpStatus}`)
    printActivationEnd()
    process.exitCode = 1
    return
  }

  const asins5 = LIVE_ASINS.slice(0, 5)
  if (testA.tokensLeft != null && testA.tokensLeft < asins5.length + 5) {
    console.log("STOPPED_AFTER_1_ASIN")
    console.log("ROOT_CAUSE", "insufficient tokensLeft for 5-ASIN test")
    printActivationEnd()
    process.exitCode = 1
    return
  }
  const testB = await runBatch("TEST_B_5_ASIN", asins5, 25_000)
  printBatch(testB)
  if (!testB.ok || testB.httpStatus !== 200 || testB.httpRequests !== 1) {
    console.log("STOPPED_AFTER_5_ASIN")
    console.log("ROOT_CAUSE", testB.error ?? `HTTP ${testB.httpStatus} httpRequests=${testB.httpRequests}`)
    printActivationEnd()
    process.exitCode = 1
    return
  }

  const asins20 = LIVE_ASINS.slice(0, 20)
  if (testB.tokensLeft != null && testB.tokensLeft < asins20.length + 10) {
    console.log("STOPPED_AFTER_5_ASIN")
    console.log("ROOT_CAUSE", "insufficient tokensLeft for 20-ASIN test")
    printActivationEnd()
    process.exitCode = 1
    return
  }
  const testC = await runBatch("TEST_C_20_ASIN", asins20, 40_000)
  printBatch(testC)
  if (!testC.ok || testC.httpStatus !== 200 || testC.httpRequests !== 1) {
    console.log("STOPPED_AFTER_20_ASIN")
    console.log("ROOT_CAUSE", testC.error ?? `HTTP ${testC.httpStatus} httpRequests=${testC.httpRequests}`)
    printActivationEnd()
    process.exitCode = 1
    return
  }
  console.log("BATCH_SHAPE", {
    requested: 20,
    singleHttpRequest: testC.httpRequests === 1,
    commaSeparatedAsinParam: true,
    notTwentySeparateHttpRequests: testC.httpRequests === 1,
  })

  let testD: BatchResult | null = null
  let skip100: string | null = null
  if (LIVE_ASINS.length < 100) {
    skip100 = "100_ASIN_TEST_SKIPPED_INSUFFICIENT_UNIQUE_ASINS"
  } else if (testC.tokensLeft == null) {
    skip100 = "100_ASIN_TEST_SKIPPED_UNKNOWN_TOKEN_BALANCE"
  } else if (testC.tokensLeft < 100 + TOKEN_RESERVE_AFTER_100) {
    skip100 = "100_ASIN_TEST_SKIPPED_INSUFFICIENT_TOKEN_RESERVE"
  }
  if (skip100) {
    console.log("\n=== TEST_D_100_ASIN ===")
    console.log({ skipped: true, reason: skip100, uniqueAsinsAvailable: LIVE_ASINS.length, tokensLeft: testC.tokensLeft })
  } else {
    testD = await runBatch("TEST_D_100_ASIN", LIVE_ASINS.slice(0, 100), 60_000)
    printBatch(testD)
  }

  let partial: BatchResult | null = null
  const naturalMissing = [...testA.missing, ...testB.missing, ...testC.missing]
  if (naturalMissing.length > 0) {
    console.log("PARTIAL_NATURAL", { missing: [...new Set(naturalMissing)], classification: "PRODUCT_NOT_RETURNED" })
  } else if (testC.tokensLeft != null && testC.tokensLeft >= 8) {
    partial = await runBatch("TEST_PARTIAL_INVALID_ASIN", [INVALID_ASIN], 15_000)
    printBatch(partial)
    const classified = classifyKeepaRadarProduct({
      requestedAsin: INVALID_ASIN,
      product: null,
    })
    console.log("PARTIAL_INVALID", {
      classification: partial.rows[0]?.classification ?? classified.status,
      notRemoved: (partial.rows[0]?.classification ?? classified.status) !== "REMOVED",
      notOutOfStock: (partial.rows[0]?.classification ?? classified.status) !== "OUT_OF_STOCK",
    })
  } else {
    console.log("PARTIAL_RESPONSE", "NOT_TESTED (no natural missing; skipped extra token)")
  }

  const allRows = [...testA.rows, ...testB.rows, ...testC.rows, ...(testD?.rows ?? [])]
  const cases = findCases(allRows)
  console.log("FBA_FBM_CASES", {
    caseA_fbaOnly: cases.a ? { asin: cases.a.asin, NEW: cases.a.newUsd, FBA: cases.a.fba, FBM: cases.a.fbm } : "NO LIVE SAMPLE IN CURRENT TEST SET",
    caseB_ambiguous: cases.b ? { asin: cases.b.asin, NEW: cases.b.newUsd, FBA: cases.b.fba, FBM: cases.b.fbm } : "NO LIVE SAMPLE IN CURRENT TEST SET",
    caseC_fbaZero: cases.c ? { asin: cases.c.asin, NEW: cases.c.newUsd, FBA: cases.c.fba, FBM: cases.c.fbm } : "NO LIVE SAMPLE IN CURRENT TEST SET",
  })

  const present = allRows.filter(r => r.classification !== "PRODUCT_NOT_RETURNED")
  console.log("FIELD_CONTRACT", {
    "stats.current[1]_NEW": fieldStatus(present, "new"),
    "stats.current[34]_COUNT_NEW_FBA": fieldStatus(present, "fba"),
    "stats.current[35]_COUNT_NEW_FBM": fieldStatus(present, "fbm"),
    lastUpdate: fieldStatus(present, "lastUpdate"),
    lastPriceChange: fieldStatus(present, "lastPriceChange"),
    semanticNote: "VALUE OBSERVED, SEMANTIC CONTRACT NOT FULLY VERIFIED",
  })

  const tokenEvidence = {
    tokensLeftPresent: testA.tokensLeft != null,
    refillRatePresent: testA.refillRate != null,
    refillInPresent: testA.refillIn != null,
    tokensConsumedPresent: testA.tokensConsumed != null,
    processingTimeInMsPresent: testA.processingTimeInMs != null,
    consumed1: testA.tokensConsumed,
    consumed5: testB.tokensConsumed,
    consumed20: testC.tokensConsumed,
    consumed100: testD?.tokensConsumed ?? skip100,
    matchesOneTokenPerAsin:
      testA.tokensConsumed === 1 &&
      testB.tokensConsumed === 5 &&
      testC.tokensConsumed === 20,
  }
  console.log("TOKEN_CONTRACT", tokenEvidence)

  console.log("RESULT_TABLE", {
    a: { requested: testA.requested, returned: testA.returned, missing: testA.missing.length, http: testA.httpRequests, consumed: testA.tokensConsumed, left: testA.tokensLeft, refill: testA.refillRate, processing: testA.processingTimeInMs, result: "PASS" },
    b: { requested: testB.requested, returned: testB.returned, missing: testB.missing.length, http: testB.httpRequests, consumed: testB.tokensConsumed, left: testB.tokensLeft, refill: testB.refillRate, processing: testB.processingTimeInMs, result: "PASS" },
    c: { requested: testC.requested, returned: testC.returned, missing: testC.missing.length, http: testC.httpRequests, consumed: testC.tokensConsumed, left: testC.tokensLeft, refill: testC.refillRate, processing: testC.processingTimeInMs, result: "PASS" },
    d: testD
      ? { requested: testD.requested, returned: testD.returned, missing: testD.missing.length, http: testD.httpRequests, consumed: testD.tokensConsumed, left: testD.tokensLeft, refill: testD.refillRate, processing: testD.processingTimeInMs, result: testD.ok ? "PASS" : "FAIL" }
      : { result: skip100 },
  })

  console.log("PARSER_VERDICT", {
    NEW_PARSER: present.some(r => r.newUsd != null && r.newUsd > 0) || present.every(r => r.rawNew == null || r.rawNew <= 0) ? "PASS" : "FAIL",
    FBA_COUNT_PARSER: present.some(r => r.currentLen != null && r.currentLen > 34) ? "PASS" : "NOT_VERIFIED",
    FBM_COUNT_PARSER: present.some(r => r.currentLen != null && r.currentLen > 35) ? "PASS" : "NOT_VERIFIED",
    LAST_UPDATE_PARSER: present.some(r => r.lastUpdate) ? "PASS" : present.length ? "NOT_VERIFIED" : "NOT_VERIFIED",
    LAST_PRICE_CHANGE_PARSER: present.some(r => r.lastPriceChange) ? "PASS" : "NOT_VERIFIED",
    TOKEN_RESPONSE_PARSER: testA.tokensLeft != null ? "PASS" : "FAIL",
    PARTIAL_RESPONSE_CLASSIFICATION:
      naturalMissing.length > 0 || (partial && partial.rows[0]?.classification === "PRODUCT_NOT_RETURNED")
        ? "PASS"
        : "NOT_TESTED",
  })

  console.log("NO_MUTATION_PATH", {
    productionDbWrites: 0,
    listingSourcePriceChanges: 0,
    listingSourceStatusChanges: 0,
    stockReviewItemsCreated: 0,
    verificationProductionTasksCreated: 0,
    ebayMutations: 0,
    evidence: "script does not import db/client, planner tick, token-state writer, verification queue, or eBay modules",
  })
  printActivationEnd()
}

function printActivationEnd(): void {
  const cfg = loadGlobalKeepaFoundationConfig()
  const vcfg = loadAmazonVerificationConfig()
  console.log("ACTIVATION_END", {
    GLOBAL_KEEPA_PLANNER_ACTIVATED: cfg.plannerEnabled ? "YES" : "NO",
    GLOBAL_KEEPA_SCHEDULER_ACTIVATED: cfg.plannerEnabled && cfg.monitorEnabled ? "YES" : "NO",
    GLOBAL_KEEPA_ACTIONS_ACTIVATED: cfg.actionsEnabled ? "YES" : "NO",
    OLD_STOCK_GUARD_MODIFIED: "NO",
    AUTO_ZERO_MODIFIED: "NO",
    AUTO_REPRICE_MODIFIED: "NO",
    EBAY_MUTATION: "NO",
    PRODUCTION_DEPLOY: "NO",
    KEEP_TO_EXTENSION_DISPATCH: vcfg.keepaDispatchEnabled ? "YES" : "NO",
    extensionHeartbeatRequired: "NO",
    verificationClaim: "NO",
    amazonBackgroundTabOpened: "NO",
  })
}

void main().catch(e => {
  console.error(redact(e instanceof Error ? e.message : String(e)))
  printActivationEnd()
  process.exitCode = 1
})

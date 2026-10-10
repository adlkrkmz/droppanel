/**
 * One-off READ-ONLY replay of historical NOT_FBA cases through CURRENT Worker extract/classify.
 * Does NOT call submitVerificationResult / applyConfirmedNoValidSource / eBay / Keepa.
 * Uses the production amazon-browser-profile (stop PM2 worker first — no dual Chromium).
 */
import "dotenv/config"
import fs from "fs"
import path from "path"
import { chromium, type BrowserContext, type Page } from "playwright"
import {
  extractAmazonVerification,
  waitForProductOfferReady,
  pageLooksLikeAmazonNotFound,
} from "../modules/amazonBrowserWorker/amazonPageExtract"
import { evaluateOfferPrimeFbaSignals } from "../modules/amazonBrowserWorker/amazonOfferPrimeFbaGate"
import { classifyVerifiedAmazonSource } from "../modules/amazonVerification/verifiedSourceDecision"
import { detectAmazonSession } from "../modules/amazonBrowserWorker/amazonLoginManager"
import { amazonBrowserProfileDir } from "../modules/amazonBrowserWorker/amazonBrowserWorkerConstants"

type HistRow = {
  asin: string
  storeId: number
  workspaceId: string
  catalogStateId: number
  ebayItemId: string
  oldTaskId: number
  oldZeroAt: string
}

const SET_PATH = path.join(process.cwd(), "var/diagnostics/historical-not-fba-28-set.tsv")
const PROFILE = amazonBrowserProfileDir()
const OUT_DIR = path.join(process.cwd(), "var/diagnostics")

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function productUrl(asin: string): string {
  return `https://www.amazon.com/dp/${encodeURIComponent(asin)}?th=1`
}

function loadSet(): HistRow[] {
  const lines = fs.readFileSync(SET_PATH, "utf8").trim().split(/\r?\n/).filter(Boolean)
  return lines.map((line) => {
    const [asin, storeId, workspaceId, catalogStateId, ebayItemId, oldTaskId, oldZeroAt] = line.split("\t")
    return {
      asin: asin.trim().toUpperCase(),
      storeId: Number(storeId),
      workspaceId,
      catalogStateId: Number(catalogStateId),
      ebayItemId,
      oldTaskId: Number(oldTaskId),
      oldZeroAt,
    }
  })
}

function mapClass(code: string, outcome: string): string {
  if (outcome === "VALID_SOURCE" || code === "VALID_SOURCE") return "VALID"
  if (code === "PRODUCT_NOT_FOUND") return "PRODUCT_NOT_FOUND"
  if (code === "SOURCE_ASIN_MISMATCH") return "SOURCE_ASIN_MISMATCH"
  if (code === "NOT_PRIME") return "NOT_PRIME"
  if (code === "NOT_FBA") return "NOT_FBA"
  if (code === "OUT_OF_STOCK") return "OUT_OF_STOCK"
  if (
    code === "SHIPPER_UNKNOWN" ||
    code === "PRIME_UNKNOWN" ||
    code === "ASIN_UNKNOWN" ||
    code === "STOCK_UNKNOWN" ||
    code === "PRICE_NOT_FOUND" ||
    code === "CAPTCHA" ||
    code === "LOGIN_REQUIRED" ||
    code === "TIMEOUT" ||
    code === "EXTRACTOR_FAILED" ||
    outcome === "UNKNOWN"
  ) {
    return "TECHNICAL"
  }
  return code || outcome || "TECHNICAL"
}

async function main(): Promise<void> {
  const rows = loadSet()
  if (rows.length !== 28) {
    console.error(`HISTORICAL_SET_COUNT=${rows.length} (expected 28) — abort`)
    process.exit(2)
  }

  if (fs.existsSync(path.join(PROFILE, "SingletonLock"))) {
    console.error("Profile SingletonLock present — stop amazon worker first")
    process.exit(3)
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19).replace("T", "-")
  const outFile = path.join(OUT_DIR, `historical-not-fba-replay-${stamp}.json`)
  const results: Record<string, unknown>[] = []
  let captchaTriggered = false
  let captchaAsin: string | null = null

  const headless = process.env.AMAZON_BROWSER_HEADLESS !== "false"
  console.log(`[replay] launching profile=${PROFILE} headless=${headless} n=${rows.length}`)

  let context: BrowserContext | null = null
  try {
    context = await chromium.launchPersistentContext(PROFILE, {
      headless,
      viewport: { width: 1280, height: 900 },
      locale: "en-US",
      args: ["--disable-dev-shm-usage", "--no-first-run"],
    })
    const page: Page = context.pages()[0] || (await context.newPage())
    for (const extra of context.pages().slice(1)) {
      await extra.close().catch(() => undefined)
    }

    const boot = await detectAmazonSession(page)
    if (boot === "CHALLENGE_REQUIRED") {
      console.error("[replay] CAPTCHA/challenge before start — abort")
      captchaTriggered = true
      fs.writeFileSync(
        outFile,
        JSON.stringify(
          {
            historicalSetCount: 28,
            replayStarted: true,
            replayCompleted: false,
            captchaTriggered: true,
            captchaAsin: null,
            completedBeforeStop: 0,
            remaining: 28,
            results: [],
          },
          null,
          2
        )
      )
      process.exit(4)
    }

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      console.log(`[replay] ${i + 1}/28 ${row.asin}`)
      const entry: Record<string, unknown> = {
        ...row,
        oldClass: "NOT_FBA",
        requestedAsin: row.asin,
        finalUrl: null,
        actualAsin: null,
        pageExists: null,
        pageUnavailable: null,
        prime: null,
        primeEvidence: null,
        shipsFrom: null,
        soldBy: null,
        shipsFromAmazon: null,
        availabilityText: null,
        inStock: null,
        purchasable: null,
        price: null,
        pageHealth: null,
        newClass: null,
        decisionCode: null,
        decisionOutcome: null,
        technicalError: null,
        parserFailure: false,
        parserFailureReason: null,
      }

      try {
        const session = await detectAmazonSession(page)
        if (session === "CHALLENGE_REQUIRED") {
          captchaTriggered = true
          captchaAsin = row.asin
          entry.newClass = "TECHNICAL"
          entry.decisionCode = "CAPTCHA"
          entry.technicalError = "CAPTCHA before navigation"
          results.push(entry)
          break
        }

        await page.goto(productUrl(row.asin), { waitUntil: "domcontentloaded", timeout: 45000 })
        const ready = await waitForProductOfferReady(page, 12000)
        entry.finalUrl = page.url()
        entry.pageHealth = ready

        if (ready === "captcha") {
          captchaTriggered = true
          captchaAsin = row.asin
          entry.newClass = "TECHNICAL"
          entry.decisionCode = "CAPTCHA"
          entry.technicalError = "CAPTCHA"
          results.push(entry)
          break
        }

        if (ready === "gone" || (await pageLooksLikeAmazonNotFound(page))) {
          entry.pageExists = false
          entry.pageUnavailable = true
          entry.newClass = "PRODUCT_NOT_FOUND"
          entry.decisionCode = "PRODUCT_NOT_FOUND"
          entry.decisionOutcome = "CONFIRMED_NO_VALID_SOURCE"
          results.push(entry)
          await sleep(800)
          continue
        }

        const extracted = await extractAmazonVerification(page, row.asin)
        if (!extracted.ok) {
          if (extracted.errorCode === "CAPTCHA") {
            captchaTriggered = true
            captchaAsin = row.asin
            entry.newClass = "TECHNICAL"
            entry.decisionCode = "CAPTCHA"
            entry.technicalError = "CAPTCHA"
            results.push(entry)
            break
          }
          entry.newClass = "TECHNICAL"
          entry.decisionCode = extracted.errorCode
          entry.technicalError = extracted.error
          results.push(entry)
          await sleep(800)
          continue
        }

        const data = extracted.data
        const signals = evaluateOfferPrimeFbaSignals(data)
        entry.pageExists = data.pageUnavailable !== true
        entry.pageUnavailable = data.pageUnavailable === true
        entry.actualAsin = data.finalAsin ?? data.asin
        entry.prime = signals.isPrime
        entry.primeEvidence = data.isPrime === true ? "buybox_prime_or_extract" : data.isPrime === false ? "explicit_not_prime" : "unknown"
        entry.shipsFrom = data.shipsFrom
        entry.soldBy = data.soldBy
        entry.shipsFromAmazon = signals.shipsFromAmazon
        entry.availabilityText = data.availabilityText
        entry.inStock =
          data.stockStatus === "IN_STOCK" || data.stockStatus === "LIMITED_STOCK"
            ? true
            : data.stockStatus === "OUT_OF_STOCK"
              ? false
              : null
        entry.purchasable = signals.purchasable
        entry.price = data.displayedPrice
        entry.finalUrl = data.pageUrl || page.url()

        const decision = classifyVerifiedAmazonSource({
          requestedAsin: row.asin,
          finalAsin: data.finalAsin ?? data.asin,
          displayedPrice: data.displayedPrice,
          condition: data.condition,
          isPrime: signals.isPrime,
          isFba: signals.isFba,
          shipsFromAmazon: signals.shipsFromAmazon,
          purchasable: signals.purchasable,
          stockStatus: data.stockStatus,
          availabilityText: data.availabilityText,
          pageUnavailable: data.pageUnavailable,
          redirected: data.redirected,
          captcha: data.captcha,
        })
        entry.decisionCode = decision.code
        entry.decisionOutcome = decision.outcome
        entry.newClass = mapClass(decision.code, decision.outcome)

        // Audit: healthy page but shipper unreadable → parser failure (observation only)
        const healthyOffer =
          data.pageUnavailable !== true &&
          (data.hasAddToCart || data.hasBuyNow || (data.displayedPrice != null && data.displayedPrice > 0)) &&
          signals.isPrime === true
        if (healthyOffer && !String(data.shipsFrom || "").trim() && decision.code === "SHIPPER_UNKNOWN") {
          entry.parserFailure = true
          entry.parserFailureReason = "INTERNAL_EXTRACTION_FAILURE: shipsFrom empty on otherwise healthy Prime offer page"
          entry.newClass = "PARSER_FAILURE"
        }

        results.push(entry)
      } catch (e) {
        const msg = e instanceof Error ? e.message.slice(0, 240) : String(e)
        if (/captcha|challenge/i.test(msg)) {
          captchaTriggered = true
          captchaAsin = row.asin
        }
        entry.newClass = "TECHNICAL"
        entry.technicalError = msg
        results.push(entry)
        if (captchaTriggered) break
      }

      await sleep(900)
    }
  } finally {
    if (context) await context.close().catch(() => undefined)
  }

  const completed = results.length
  const remaining = captchaTriggered ? 28 - completed + (captchaAsin && results[results.length - 1]?.asin === captchaAsin ? 0 : 0) : 28 - completed
  // remaining = not yet attempted
  const attemptedAsins = new Set(results.map((r) => String(r.asin)))
  const remainingCount = rows.filter((r) => !attemptedAsins.has(r.asin)).length

  const count = (cls: string) => results.filter((r) => r.newClass === cls).length
  const report = {
    generatedAt: new Date().toISOString(),
    historicalSetCount: 28,
    replayStarted: true,
    replayCompleted: !captchaTriggered && results.length === 28,
    workerSessionActiveBefore: true,
    concurrency: 1,
    oneNavigationPerAsin: true,
    captchaTriggered,
    captchaAsin,
    completedBeforeStop: results.filter((r) => r.decisionCode !== "CAPTCHA" || r.asin !== captchaAsin).length,
    remaining: remainingCount,
    ebayMutation: false,
    qtyChanged: false,
    stockAlertChanged: false,
    botZeroedChanged: false,
    keepaChanged: false,
    historicalTaskResultsOverwritten: false,
    coreWorkerLogicChanged: false,
    counts: {
      TOTAL: results.length,
      VALID: count("VALID"),
      PRODUCT_NOT_FOUND: count("PRODUCT_NOT_FOUND"),
      SOURCE_ASIN_MISMATCH: count("SOURCE_ASIN_MISMATCH"),
      NOT_PRIME: count("NOT_PRIME"),
      NOT_FBA: count("NOT_FBA"),
      OUT_OF_STOCK: count("OUT_OF_STOCK"),
      TECHNICAL: count("TECHNICAL"),
      PARSER_FAILURE: count("PARSER_FAILURE"),
    },
    results,
  }

  fs.writeFileSync(outFile, JSON.stringify(report, null, 2))
  console.log(`[replay] wrote ${outFile}`)
  console.log(JSON.stringify(report.counts, null, 2))
  console.log(`CAPTCHA=${captchaTriggered} remaining=${remainingCount}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

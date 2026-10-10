import fs from "fs"
import path from "path"
import type { Page } from "playwright"

const SCRIPT = fs
  .readFileSync(path.join(__dirname, "amazonPageExtract.browser.js"), "utf8")
  .split(/\r?\n/)
  .map(line => (/^\s*--/.test(line) ? `// ${line.trim()}` : line))
  .join("\n")

export type AmazonExtractOk = {
  ok: true
  data: {
    asin: string | null
    requestedAsin: string | null
    finalAsin: string | null
    redirected: boolean
    pageUnavailable: boolean
    displayedPrice: number | null
    currency: string
    condition: string
    shipsFrom: string
    soldBy: string
    isPrime: boolean | null
    hasAddToCart: boolean
    hasBuyNow: boolean
    availabilityText: string
    stockStatus: string
    pageUrl: string
    captcha: boolean
  }
}

export type AmazonExtractFail = {
  ok: false
  errorCode: string
  error: string
}

export type AmazonExtractResult = AmazonExtractOk | AmazonExtractFail

export async function extractAmazonVerification(page: Page, expectedAsin: string): Promise<AmazonExtractResult> {
  return page.evaluate(
    ({ src, asin }) => {
      const fn = new Function("expectedAsin", src) as (expectedAsin: string) => AmazonExtractResult
      return fn(asin)
    },
    { src: SCRIPT, asin: expectedAsin }
  )
}

/**
 * Bounded same-page readiness after a single navigation (not a second load).
 * Returns when buybox/product chrome appears, terminal gone/captcha, or timeout.
 */
export async function waitForProductOfferReady(page: Page, timeoutMs = 12000): Promise<"ready" | "gone" | "captcha" | "timeout"> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const state = await page
      .evaluate(() => {
        const title = String(document.title || "").toLowerCase()
        const body = String(document.body && document.body.innerText ? document.body.innerText.slice(0, 1200) : "").toLowerCase()
        if (
          document.querySelector("#captchacharacters, form[action*='validateCaptcha'], img[src*='captcha']") ||
          /enter the characters you see|opfcaptcha|validatecaptcha|solve this puzzle/.test(title)
        ) {
          return "captcha"
        }
        if (
          /sorry[\s!,.]*we couldn['\u2019]t find that page|page not found|meet the dogs of amazon|\bdogs of amazon\b/.test(
            `${title} ${body}`
          )
        ) {
          return "gone"
        }
        const productTitle = document.querySelector("#productTitle, #title")
        const buybox = document.querySelector("#desktop_buybox, #buybox, #qualifiedBuybox")
        const offerBits = document.querySelector(
          "#add-to-cart-button, #buy-now-button, #availability, #availabilityInsideBuyBox_feature_div, #tabular-buybox, #fulfillerInfoFeature_feature_div, #merchantInfoFeature_feature_div"
        )
        if (productTitle && (buybox || offerBits)) return "ready"
        return "wait"
      })
      .catch(() => "wait" as const)
    if (state === "ready" || state === "gone" || state === "captcha") return state
    await new Promise((r) => setTimeout(r, 300))
  }
  return "timeout"
}

export function isAmazonSorryPage(title: string, bodySnippet: string): boolean {
  const blob = `${title} ${bodySnippet}`.toLowerCase()
  return /sorry,\s*something went wrong|internal server error|service unavailable|\b503\b/.test(blob)
}

const PAGE_NOT_FOUND_RE =
  /sorry[\s!,.]*we couldn['\u2019]t find that page|page not found|meet the dogs of amazon|\bdogs of amazon\b|not a functioning page on our site/

/** Product gone / 404. Distinct from service Sorry pages and from Amazon Sign-In. */
export function isAmazonPageNotFound(title: string, bodySnippet: string, url = ""): boolean {
  const blob = `${title} ${bodySnippet} ${url}`.toLowerCase()
  return PAGE_NOT_FOUND_RE.test(blob)
}

export async function pageLooksLikeAmazonNotFound(page: Page): Promise<boolean> {
  const signals = await page
    .evaluate(() => {
      const title = String(document.title || "")
      let heading = ""
      const nodes = document.querySelectorAll("h1, h2")
      for (let i = 0; i < Math.min(nodes.length, 8); i++) {
        heading += ` ${nodes[i].textContent || ""}`
      }
      const body = String(document.body && document.body.innerText ? document.body.innerText.slice(0, 2500) : "")
      return { title, heading, body, url: String(location.href || "") }
    })
    .catch(() => ({ title: "", heading: "", body: "", url: page.url() }))
  return isAmazonPageNotFound(`${signals.title} ${signals.heading}`, signals.body, signals.url)
}

export function isAmazonChallengeUrl(url: string, title: string): boolean {
  const blob = `${url} ${title}`.toLowerCase()
  return /enter the characters you see|opfcaptcha|validatecaptcha|solve this puzzle|unusual activity|account has been locked/.test(
    blob
  )
}

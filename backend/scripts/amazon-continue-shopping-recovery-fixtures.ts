import assert from "assert"
import fs from "fs"
import path from "path"
import {
  canonicalAmazonDpUrl,
  decideContinueShoppingRecovery,
  recoverContinueShoppingInterstitial,
  type ContinueShoppingInspect,
} from "../modules/amazonPublicWorker/continueShoppingInterstitial"
import { AMAZON_SCAN_WORKER_VERSION } from "../modules/amazonPublicWorker/amazonScanWorkerVersion"
import { classifyAmazonObservation, type AmazonObservation } from "../modules/amazonPublicWorker/parsing"

assert.equal(AMAZON_SCAN_WORKER_VERSION, "1.0.5")
assert.equal(canonicalAmazonDpUrl("b0testasin"), "https://www.amazon.com/dp/B0TESTASIN?th=1")
assert.equal(canonicalAmazonDpUrl("B0TESTASIN"), "https://www.amazon.com/dp/B0TESTASIN?th=1")

const pdp: ContinueShoppingInspect = {
  hasHintText: false,
  continueButtonVisible: false,
  hasRealCaptcha: false,
}
const interstitial: ContinueShoppingInspect = {
  hasHintText: true,
  continueButtonVisible: true,
  hasRealCaptcha: false,
}
const interstitialNoButton: ContinueShoppingInspect = {
  hasHintText: true,
  continueButtonVisible: false,
  hasRealCaptcha: false,
}
const captcha: ContinueShoppingInspect = {
  hasHintText: true,
  continueButtonVisible: true,
  hasRealCaptcha: true,
}

assert.equal(decideContinueShoppingRecovery({ inspect: pdp, recoveryAttempted: false }), "none")
assert.equal(
  decideContinueShoppingRecovery({ inspect: interstitial, recoveryAttempted: false }),
  "click_once_then_fresh_goto"
)
assert.equal(
  decideContinueShoppingRecovery({ inspect: interstitial, recoveryAttempted: true }),
  "incomplete"
)
assert.equal(
  decideContinueShoppingRecovery({ inspect: captcha, recoveryAttempted: false }),
  "captcha_fail_closed"
)
assert.equal(
  decideContinueShoppingRecovery({ inspect: interstitialNoButton, recoveryAttempted: false }),
  "incomplete"
)

async function run(seq: ContinueShoppingInspect[]) {
  let i = 0
  let clicks = 0
  let gotos = 0
  let waits = 0
  const result = await recoverContinueShoppingInterstitial({
    inspect: async () => seq[Math.min(i, seq.length - 1)],
    clickContinueOnce: async () => {
      clicks += 1
      i += 1
      return true
    },
    freshGotoCanonicalDp: async () => {
      gotos += 1
    },
    waitPdpReady: async () => {
      waits += 1
    },
  })
  return { result, clicks, gotos, waits }
}

void (async () => {
  const normal = await run([pdp])
  assert.equal(normal.result.outcome, "none")
  assert.equal(normal.result.clicks, 0)
  assert.equal(normal.clicks, 0)
  assert.equal(normal.gotos, 0)
  console.log("PASS normal PDP → recovery 0")

  const recovered = await run([interstitial, pdp])
  assert.equal(recovered.result.outcome, "recovered")
  assert.equal(recovered.result.clicks, 1)
  assert.equal(recovered.clicks, 1)
  assert.equal(recovered.gotos, 1)
  assert.equal(recovered.waits, 1)
  const recoveredObs: AmazonObservation = {
    actualAsin: "B0TESTASIN",
    pageExists: true,
    mainPrice: 12.34,
    primeMemberPrice: null,
    regularPrice: null,
    primeVisible: true,
    shipsFrom: "Amazon",
    soldBy: "Amazon.com",
    availability: "In Stock",
    inStock: true,
    offerLabel: "Buy new",
    offerCondition: "NEW",
    newOfferAvailable: true,
    finalUrl: canonicalAmazonDpUrl("B0TESTASIN"),
  }
  assert.equal(classifyAmazonObservation(recoveredObs, "B0TESTASIN"), "AMAZON_CHECKED")
  console.log("PASS Continue-shopping interstitial → click 1 + yeniden PDP → VALID")

  const stuck = await run([interstitial, interstitial])
  assert.equal(stuck.result.outcome, "incomplete")
  assert.equal(stuck.clicks, 1)
  assert.equal(stuck.result.clicks, 1)
  console.log("PASS interstitial devam → ikinci click 0, INCOMPLETE")

  const captchaCase = await run([captcha])
  assert.equal(captchaCase.result.outcome, "captcha")
  assert.equal(captchaCase.clicks, 0)
  console.log("PASS gerçek CAPTCHA → click 0, fail-closed")

  const noBtn = await run([interstitialNoButton])
  assert.equal(noBtn.result.outcome, "incomplete")
  assert.equal(noBtn.clicks, 0)
  console.log("PASS button görünmüyor → click 0")

  const unknownObs: AmazonObservation = {
    actualAsin: "B0TESTASIN",
    pageExists: true,
    mainPrice: null,
    primeMemberPrice: null,
    regularPrice: null,
    primeVisible: null,
    shipsFrom: null,
    soldBy: null,
    availability: null,
    inStock: null,
    offerLabel: null,
    offerCondition: "UNKNOWN",
    newOfferAvailable: null,
    finalUrl: canonicalAmazonDpUrl("B0TESTASIN"),
  }
  assert.equal(classifyAmazonObservation(unknownObs, "B0TESTASIN"), "AMAZON_INCOMPLETE")

  const workerSrc = fs.readFileSync(path.join(__dirname, "../amazon-scan-worker.ts"), "utf8")
  assert.match(workerSrc, /requireFreshNavigation === true/)
  assert.match(workerSrc, /close\("FRESH"\)/)
  assert.match(workerSrc, /AMAZON_SCAN_WORKER_VERSION/)
  const observeSrc = fs.readFileSync(
    path.join(__dirname, "../modules/amazonPublicWorker/amazonPublicWorker.ts"),
    "utf8"
  )
  assert.match(observeSrc, /recoverContinueShoppingInterstitial/)
  assert.match(observeSrc, /canonicalAmazonDpUrl/)
  assert.match(observeSrc, /waitUntil:\s*'commit'/)
  assert.doesNotMatch(observeSrc, /waitForTimeout\(5000\)/)
  assert.doesNotMatch(observeSrc, /waitForTimeout\(10000\)/)
  console.log("PASS redirect/final ASIN canonical /dp + requireFreshNav=true korunuyor")
  console.log("PASS amazon continue-shopping recovery fixtures")
})().catch(e => {
  console.error(e)
  process.exit(1)
})

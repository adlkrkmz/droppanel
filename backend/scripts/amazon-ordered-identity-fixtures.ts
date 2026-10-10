/**
 * Amazon Ordered identity auto-match fixtures.
 * npx ts-node --transpile-only scripts/amazon-ordered-identity-fixtures.ts
 */
import { readFileSync } from "fs"
import { join } from "path"
import { parseAmazonOrderedEmail, parseDestination } from "../modules/mailbox/amazonEmailParser"
import {
  identityGatesPass,
  firstNameNorm,
  cityNorm,
  scoreAmazonCandidate,
} from "../modules/mailbox/orderMatchIdentity"

const root = join(__dirname, "..")
const processSrc = readFileSync(join(root, "modules/mailbox/mailboxProcessService.ts"), "utf8")
const matchSrc = readFileSync(join(root, "modules/mailbox/orderMatchService.ts"), "utf8")
const parser = readFileSync(join(root, "modules/mailbox/amazonEmailParser.ts"), "utf8")
const oauth = readFileSync(join(root, "modules/ebayOAuth/ebayOAuthService.ts"), "utf8")
const proof = readFileSync(join(root, "modules/mailbox/deliveryProofStore.ts"), "utf8")
const poller = readFileSync(join(root, "modules/orders/ebayRecentOrderPollService.ts"), "utf8")

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++
    console.log(`✓ ${name}`)
  } else {
    failed++
    console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`)
  }
}

const dashMail = `
Arriving Tuesday Matt - DANVILLE, PA
Order # 114-2599384-0555433
Grand Total: $9.75
`
const parsedDash = parseAmazonOrderedEmail(dashMail)
check("dash dest first name", parsedDash.recipientLabel === "Matt")
check("dash dest city", parsedDash.destinationCity?.toUpperCase() === "DANVILLE")
check("dash dest state", parsedDash.destinationState === "PA")
check("dash dest order number", parsedDash.amazonOrderNumber === "114-2599384-0555433")

const taxTrap = parseDestination(
  "to collect sales tax in select states in accordance with the applicable laws of that state. If your order contains one or more items from a seller other than Amazon.com, IT"
)
check("sales-tax boilerplate not a destination", taxTrap.city === null && taxTrap.recipientLabel === null)

const delivering = parseAmazonOrderedEmail(`
Delivering to Alex in Austin, TX
Amazon Order # 111-2222222-3333333
Grand Total: $42.99
`)
check("legacy delivering-to still parses", delivering.recipientLabel === "Alex" && delivering.destinationCity === "Austin")

check("Robert first name", firstNameNorm("Robert Rutkowski") === "robert")
check("ROBERT label", firstNameNorm("ROBERT") === "robert")
check("city case", cityNorm("TRUMBULL") === cityNorm("Trumbull"))

const robertOk = identityGatesPass({
  mailFirstName: "robert",
  mailCity: "TRUMBULL",
  mailState: "CT",
  orderFirstName: "robert",
  orderCity: "Trumbull",
  orderState: "CT",
  mailReceivedAt: new Date("2026-09-25T18:00:00Z"),
  orderCreatedAt: new Date("2026-09-25T15:11:16Z"),
  parsedAsin: null,
  orderAsin: "B00ABCDE12",
  parsedQty: null,
  orderQty: 1,
})
check("Robert unique gates pass without ASIN", robertOk.pass)

const twoJohnTime = identityGatesPass({
  mailFirstName: "john",
  mailCity: "new york",
  mailState: "NY",
  orderFirstName: "john",
  orderCity: "New York",
  orderState: "NY",
  mailReceivedAt: new Date("2026-09-25T18:00:00Z"),
  orderCreatedAt: new Date("2026-09-20T15:00:00Z"),
  parsedAsin: null,
  orderAsin: null,
  parsedQty: null,
  orderQty: null,
})
check("time window rejects 5-day-old order", twoJohnTime.pass === false)

const qtyMismatch = identityGatesPass({
  mailFirstName: "matt",
  mailCity: "danville",
  mailState: "PA",
  orderFirstName: "matt",
  orderCity: "Danville",
  orderState: "PA",
  mailReceivedAt: new Date("2026-09-27T16:00:00Z"),
  orderCreatedAt: new Date("2026-09-27T13:58:00Z"),
  parsedAsin: null,
  orderAsin: null,
  parsedQty: 2,
  orderQty: 1,
})
check("quantity mismatch rejects", qtyMismatch.pass === false)

const asinMismatch = identityGatesPass({
  mailFirstName: "matt",
  mailCity: "danville",
  mailState: "PA",
  orderFirstName: "matt",
  orderCity: "Danville",
  orderState: "PA",
  mailReceivedAt: new Date("2026-09-27T16:00:00Z"),
  orderCreatedAt: new Date("2026-09-27T13:58:00Z"),
  parsedAsin: "B00AAAAAAA",
  orderAsin: "B00BBBBBBB",
  parsedQty: null,
  orderQty: null,
})
check("ASIN mismatch rejects when both present", asinMismatch.pass === false)

const asinOld = scoreAmazonCandidate({
  parsedAsin: "B00SANIT12",
  parsedCity: "Austin",
  parsedState: "TX",
  parsedQty: 1,
  candidateAsin: "B00SANIT12",
  candidateCity: "Austin",
  candidateState: "TX",
  candidateQty: 1,
})
check("existing ASIN high-confidence still passes", asinOld.pass === true)

check("identity match only on ORDERED in matcher", matchSrc.includes('parsed.type === "AMAZON_ORDERED"'))
check("after match reuses exact link", processSrc.includes("linkExactAmazonMailsToOrder"))
check("no generic sales-tax to-in fallback", !parser.includes("?? text.match(/to\\s+"))
check("delivery proof store untouched by this suite", !processSrc.includes("captureDeliveryProofIfPresent") === false)
check("proof capture still after delivered apply", processSrc.includes("captureDeliveryProofIfPresent"))
check("OAuth connect list untouched", oauth.includes("commerce.message"))
check("poller cadence untouched", poller.includes("120_000"))
check("proof R2 helper not rewritten here", proof.includes("deliveryProofObjectKey"))

console.log(`\n${passed}/${passed + failed} passed`)
if (failed > 0) process.exit(1)

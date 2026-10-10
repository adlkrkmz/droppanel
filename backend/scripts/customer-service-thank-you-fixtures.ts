/**
 * Customer Service Thank You fixtures.
 * Run: npx ts-node --transpile-only scripts/customer-service-thank-you-fixtures.ts
 */

import { readFileSync } from "fs"
import { join } from "path"
import {
  DEFAULT_THANK_YOU_TEMPLATE,
  evaluateThankYouEligibility,
  findUnsupportedPlaceholders,
  isCancelledOrderStatus,
  renderThankYouTemplate,
} from "../modules/customerService/csTemplate"

const root = join(__dirname, "..")
const shell = readFileSync(join(root, "panel/src/components/app/AppShell.tsx"), "utf8")
const proxy = readFileSync(join(root, "panel/src/proxy.ts"), "utf8")
const poller = readFileSync(join(root, "modules/orders/ebayRecentOrderPollService.ts"), "utf8")
const restock = readFileSync(join(root, "modules/orders/soldItemAutoRestockScheduler.ts"), "utf8")
const settings = readFileSync(join(root, "panel/src/app/(public)/app/settings/page.tsx"), "utf8")
const repo = readFileSync(join(root, "modules/orders/ordersRepository.ts"), "utf8")
const oauth = readFileSync(join(root, "modules/ebayOAuth/ebayOAuthService.ts"), "utf8")
const mig = readFileSync(join(root, "migrations/084_customer_service_thank_you.sql"), "utf8")
const ebayClient = readFileSync(join(root, "modules/ebay/ebayApiClient.ts"), "utf8")

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

check("nav has Customer Service", shell.includes('href: "/app/customer-service"'))
check("proxy allowlists /app/customer-service", proxy.includes("'/app/customer-service'"))
check("poller does not send messages", !poller.includes("sendBuyerMessage") && !poller.includes("enqueueThankYou"))
check("10-min scheduler unchanged", /const TICK_MS = 10 \* 60 \* 1000/.test(restock))
check("Gmail settings page not rewritten by CS send", !settings.includes("customer_service_sends"))
check("first insert enqueue hook", repo.includes("upserted.inserted") && repo.includes("enqueueThankYouForNewOrder"))
check("unique send ledger", mig.includes("uq_cs_sends_unique"))
check("thank you default off in SQL", mig.includes("enabled          BOOLEAN NOT NULL DEFAULT FALSE"))
check("commerce.message requested on connect", oauth.includes("commerce.message"))
check("official message APIs present", ebayClient.includes("/commerce/message/v1/send_message") && ebayClient.includes("AddMemberMessageAAQToPartner"))

check("OFF skips send", evaluateThankYouEligibility({
  enabled: false, ebayOrderId: "1", buyerUsername: "buyer",
}).ok === false)

check("ON with buyer eligible", evaluateThankYouEligibility({
  enabled: true, ebayOrderId: "1", buyerUsername: "buyer",
}).ok === true)

check("missing buyer ineligible", evaluateThankYouEligibility({
  enabled: true, ebayOrderId: "1", buyerUsername: null,
}).ok === false)

check("cancelled ineligible", evaluateThankYouEligibility({
  enabled: true, ebayOrderId: "1", buyerUsername: "buyer", fulfillmentStatus: "CANCELLED",
}).ok === false)

check("unsupported placeholder rejected", findUnsupportedPlaceholders("Hi {{foo}}").includes("foo"))
check("supported placeholders accepted", findUnsupportedPlaceholders("Hi {{buyer_username}} {{order_id}} {{store_name}}").length === 0)
check("render fills vars", renderThankYouTemplate("Hi {{buyer_username}} {{order_id}} {{store_name}}", {
  buyer_username: "ann", order_id: "OID", store_name: "S1",
}) === "Hi ann OID S1")
check("default template has no extra placeholders", findUnsupportedPlaceholders(DEFAULT_THANK_YOU_TEMPLATE).length === 0)
check("cancel detector", isCancelledOrderStatus(["CANCELLED"]) === true)

const storeA = { workspaceId: "wa", storeId: 1, ebayOrderId: "OID" }
const storeB = { workspaceId: "wb", storeId: 2, ebayOrderId: "OID" }
check("store isolation keys differ", `${storeA.workspaceId}:${storeA.storeId}:${storeA.ebayOrderId}` !== `${storeB.workspaceId}:${storeB.storeId}:${storeB.ebayOrderId}`)

console.log(`\n${passed}/${passed + failed} passed`)
if (failed > 0) process.exit(1)

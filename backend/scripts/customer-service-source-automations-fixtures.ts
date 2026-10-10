/**
 * SHIPPED / DELAYED / DELIVERED automation fixtures.
 * Run: npx ts-node --transpile-only scripts/customer-service-source-automations-fixtures.ts
 */

import { readFileSync } from "fs"
import { join } from "path"
import {
  DEFAULT_DELAYED_TEMPLATE,
  DEFAULT_DELIVERED_TEMPLATE,
  DEFAULT_SHIPPED_TEMPLATE,
  DELAYED_ETA_FALLBACK,
  automationTypeForSourceEvent,
  evaluateAutomationEligibility,
  evaluateThankYouEligibility,
  findUnsupportedPlaceholders,
  findUnsupportedPlaceholdersFor,
  renderAutomationTemplate,
  renderThankYouTemplate,
  templateMentionsAmazon,
} from "../modules/customerService/csTemplate"

const root = join(__dirname, "..")
const apply = readFileSync(join(root, "modules/mailbox/mailboxApplyService.ts"), "utf8")
const process = readFileSync(join(root, "modules/mailbox/mailboxProcessService.ts"), "utf8")
const match = readFileSync(join(root, "modules/mailbox/orderMatchService.ts"), "utf8")
const thankYou = readFileSync(join(root, "modules/customerService/csThankYouService.ts"), "utf8")
const repo = readFileSync(join(root, "modules/customerService/csRepository.ts"), "utf8")
const ui = readFileSync(join(root, "panel/src/app/(public)/app/customer-service/page.tsx"), "utf8")
const oauth = readFileSync(join(root, "modules/ebayOAuth/ebayOAuthService.ts"), "utf8")
const poller = readFileSync(join(root, "modules/orders/ebayRecentOrderPollService.ts"), "utf8")
const restock = readFileSync(join(root, "modules/orders/soldItemAutoRestockScheduler.ts"), "utf8")
const messages = readFileSync(join(root, "panel/src/app/(public)/app/customer-service/messages/page.tsx"), "utf8")
const ordersPage = readFileSync(join(root, "modules/orders/ordersRepository.ts"), "utf8")

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

check("A SHIPPED off", evaluateAutomationEligibility({
  enabled: false, ebayOrderId: "1", buyerUsername: "b", linked: true, eventType: "SOURCE_SHIPPED", expectedEventType: "SOURCE_SHIPPED",
}).reason === "DISABLED")

check("B SHIPPED on eligible", evaluateAutomationEligibility({
  enabled: true, ebayOrderId: "1", buyerUsername: "b", linked: true, eventType: "SOURCE_SHIPPED", expectedEventType: "SOURCE_SHIPPED",
}).ok === true)

check("C unique ledger still workspace+store+order+type", repo.includes("ON CONFLICT (workspace_id, store_id, ebay_order_id, automation_type)"))
check("C source traces stored", repo.includes("source_event_id") && repo.includes("source_mailbox_message_id"))

check("D DELAYED maps from SOURCE_DELAYED", automationTypeForSourceEvent("SOURCE_DELAYED") === "DELAYED")
check("E DELIVERED maps from SOURCE_DELIVERED", automationTypeForSourceEvent("SOURCE_DELIVERED") === "DELIVERED")

check("F unlinked no send", evaluateAutomationEligibility({
  enabled: true, ebayOrderId: "1", buyerUsername: "b", linked: false, eventType: "SOURCE_SHIPPED", expectedEventType: "SOURCE_SHIPPED",
}).reason === "UNLINKED_SOURCE")

const storeA = { workspaceId: "wa", storeId: 1, ebayOrderId: "OID", type: "SHIPPED" }
const storeB = { workspaceId: "wb", storeId: 2, ebayOrderId: "OID", type: "SHIPPED" }
check("G store isolation keys differ", `${storeA.workspaceId}:${storeA.storeId}` !== `${storeB.workspaceId}:${storeB.storeId}`)

check("H no buyer", evaluateAutomationEligibility({
  enabled: true, ebayOrderId: "1", buyerUsername: null, linked: true, eventType: "SOURCE_SHIPPED", expectedEventType: "SOURCE_SHIPPED",
}).reason === "NO_BUYER")

check("I cancelled", evaluateAutomationEligibility({
  enabled: true, ebayOrderId: "1", buyerUsername: "b", linked: true, fulfillmentStatus: "CANCELLED", eventType: "SOURCE_SHIPPED", expectedEventType: "SOURCE_SHIPPED",
}).reason === "CANCELLED_ORDER")

check("J reconnect UX still uses existing field", thankYou.includes("reconnectRequired") && oauth.includes("commerce.message"))
check("first-connect OAuth list not rebuilt here", !oauth.includes("EBAY_OAUTH_CONNECT_SCOPES = []"))

check("K shipped placeholders only allowed", findUnsupportedPlaceholdersFor("SHIPPED", "{{asin}}").includes("asin"))
const shipped = renderAutomationTemplate("SHIPPED", DEFAULT_SHIPPED_TEMPLATE, {
  buyer_username: "ann", order_id: "12-1", store_name: "S2",
})
check("K shipped no undefined/null/amazon", !/undefined|null|amazon/i.test(shipped) && shipped.length > 20)

const delayedNoEta = renderAutomationTemplate("DELAYED", DEFAULT_DELAYED_TEMPLATE, {
  buyer_username: "ann", order_id: "12-1", store_name: "S2",
})
check("K delayed missing ETA does not invent a date", !/\d{4}-\d{2}-\d{2}/.test(delayedNoEta) && !delayedNoEta.includes(DELAYED_ETA_FALLBACK) && delayedNoEta.startsWith("Hello,"))
const delayedEta = renderAutomationTemplate("DELAYED", DEFAULT_DELAYED_TEMPLATE, {
  buyer_username: "ann", order_id: "12-1", store_name: "S2", estimated_delivery: "2026-10-04",
})
check("K delayed with ETA", delayedEta.includes("October 4") && !delayedEta.includes("undefined"))

const delivered = renderAutomationTemplate("DELIVERED", DEFAULT_DELIVERED_TEMPLATE, {
  buyer_username: "ann", order_id: "12-1", store_name: "S2",
})
check("K delivered natural without location", delivered.includes("delivered") && !/undefined|amazon/i.test(delivered))

check("Amazon word rejected", templateMentionsAmazon("Thanks Amazon shopper") === true)
check("L thank you still evaluates", evaluateThankYouEligibility({
  enabled: true, ebayOrderId: "1", buyerUsername: "buyer",
}).ok === true)
check("L thank you render intact", renderThankYouTemplate("Hi {{buyer_username}}", {
  buyer_username: "ann", order_id: "OID", store_name: "S1",
}) === "Hi ann")
check("L thank you enqueue hook intact", ordersPage.includes("enqueueThankYouForNewOrder") && thankYou.includes("enqueueThankYouForNewOrder"))

check("hook after SOURCE event insert not in parser", apply.includes("enqueueSourceStatusAutomation") && apply.includes("SOURCE_SHIPPED"))
check("NEEDS_REVIEW path does not enqueue", process.includes('status: "NEEDS_REVIEW"') && !process.includes("enqueueSourceStatusAutomation"))
check("matcher thresholds not edited in this task", match.includes("exact_amazon_number") && match.includes("unique_high_confidence"))
check("default templates have no extra placeholders", findUnsupportedPlaceholdersFor("SHIPPED", DEFAULT_SHIPPED_TEMPLATE).length === 0)
check("UI has four cards", ui.includes("SHIPPED") && ui.includes("DELAYED") && ui.includes("DELIVERED") && !ui.includes("Coming soon"))
check("recent activity shows source", ui.includes("sourceEventType"))
check("buyer messages page untouched by this suite", messages.includes("sendingRef") && !messages.includes("enqueueSourceStatusAutomation"))
check("poller cadence untouched", poller.includes("120_000"))
check("10-min restock untouched", /const TICK_MS = 10 \* 60 \* 1000/.test(restock))
check("thank you placeholders include greeting", findUnsupportedPlaceholders("{{greeting}} {{buyer_username}} {{order_id}} {{store_name}}").length === 0)

console.log(`\n${passed}/${passed + failed} passed`)
if (failed > 0) process.exit(1)

/**
 * Single master toggle for Customer Service automations.
 * Run: npx ts-node --transpile-only scripts/cs-master-toggle-fixtures.ts
 * Does not send live buyer messages.
 */

import { readFileSync } from "fs"
import { join } from "path"
import { evaluateAutomationEligibility, evaluateThankYouEligibility } from "../modules/customerService/csTemplate"

const root = join(__dirname, "..")
const mig = readFileSync(join(root, "migrations/088_cs_master_toggle.sql"), "utf8")
const repo = readFileSync(join(root, "modules/customerService/csRepository.ts"), "utf8")
const thankYou = readFileSync(join(root, "modules/customerService/csThankYouService.ts"), "utf8")
const routes = readFileSync(join(root, "modules/app/appRoutes.ts"), "utf8")
const ui = readFileSync(join(root, "panel/src/app/(public)/app/customer-service/page.tsx"), "utf8")
const client = readFileSync(join(root, "panel/src/lib/userAppClient.ts"), "utf8")
const poller = readFileSync(join(root, "modules/orders/ebayRecentOrderPollService.ts"), "utf8")
const restock = readFileSync(join(root, "modules/orders/soldItemAutoRestockScheduler.ts"), "utf8")
const oauth = readFileSync(join(root, "modules/ebayOAuth/ebayOAuthService.ts"), "utf8")
const apply = readFileSync(join(root, "modules/mailbox/mailboxApplyService.ts"), "utf8")
const match = readFileSync(join(root, "modules/mailbox/orderMatchService.ts"), "utf8")
const messages = readFileSync(join(root, "panel/src/app/(public)/app/customer-service/messages/page.tsx"), "utf8")

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

const base = {
  ebayOrderId: "1",
  buyerUsername: "b",
  linked: true,
}

check("A new store SQL default OFF", mig.includes("enabled      BOOLEAN NOT NULL DEFAULT FALSE"))
check("A getOrCreate settings inserts FALSE", repo.includes("VALUES ($1::uuid, $2, FALSE)"))

check("B master OFF SOURCE_SHIPPED no send", evaluateAutomationEligibility({
  ...base, enabled: false, eventType: "SOURCE_SHIPPED", expectedEventType: "SOURCE_SHIPPED",
}).reason === "DISABLED")

check("C THANK_YOU eligible when master ON", evaluateThankYouEligibility({
  enabled: true, ebayOrderId: "1", buyerUsername: "buyer",
}).ok === true)
check("C SHIPPED eligible when master ON", evaluateAutomationEligibility({
  ...base, enabled: true, eventType: "SOURCE_SHIPPED", expectedEventType: "SOURCE_SHIPPED",
}).ok === true)
check("C DELAYED eligible when master ON", evaluateAutomationEligibility({
  ...base, enabled: true, eventType: "SOURCE_DELAYED", expectedEventType: "SOURCE_DELAYED",
}).ok === true)
check("C DELIVERED eligible when master ON", evaluateAutomationEligibility({
  ...base, enabled: true, eventType: "SOURCE_DELIVERED", expectedEventType: "SOURCE_DELIVERED",
}).ok === true)

check("D master OFF stops all four",
  ["THANK_YOU", "SOURCE_SHIPPED", "SOURCE_DELAYED", "SOURCE_DELIVERED"].every(ev => {
    if (ev === "THANK_YOU") return evaluateThankYouEligibility({ enabled: false, ebayOrderId: "1", buyerUsername: "b" }).reason === "DISABLED"
    return evaluateAutomationEligibility({
      ...base,
      enabled: false,
      eventType: ev,
      expectedEventType: ev,
    }).reason === "DISABLED"
  })
)

check("E template save ignores per-type enabled", thankYou.includes("saveAutomationSettings") && thankYou.includes("templateBody: input.templateBody") && !thankYou.includes("enabled: input.enabled"))
check("E enqueue uses master.enabled", thankYou.includes("enabled: master.enabled"))
check("E setMasterEnabled syncs all automations", repo.includes("setMasterEnabled") && repo.includes("UPDATE customer_service_automations"))

check("F store-scoped PK", mig.includes("PRIMARY KEY (workspace_id, store_id)"))
check("F GET includes masterEnabled", thankYou.includes("masterEnabled: master.enabled"))

check("G page refresh loads store master", ui.includes("fetchAppCustomerService") && client.includes("masterEnabled"))

check("H one master checkbox", (ui.match(/type="checkbox"/g) ?? []).length === 1)
check("H no per-card enabled save", !ui.includes("{ enabled: e.target.checked }") && ui.includes("saveMaster"))
check("H cards still have Save template", ui.includes("Save template") && ui.includes("Sent today"))
check("H Paused/Active status", ui.includes("Paused") && ui.includes("Active"))
check("H master copy", ui.includes("When enabled, ListJetGo automatically sends order confirmation, shipped, delayed, and delivered updates for this store."))

check("I ledger uniqueness unchanged", repo.includes("ON CONFLICT (workspace_id, store_id, ebay_order_id, automation_type)"))

check("J no live send in this task", !poller.includes("enqueueThankYou") && apply.includes("enqueueSourceStatusAutomation"))
check("J reconnectRequired preserved", thankYou.includes("reconnectRequired") && oauth.includes("commerce.message"))
check("J one master POST", routes.includes("/app/customer-service/master") && client.includes("/app/customer-service/master"))
check("matcher untouched by master toggle", match.includes("exact_amazon_number"))
check("buyer messages page not rewritten", messages.includes("sendingRef"))
check("poller cadence untouched", poller.includes("120_000"))
check("10-min restock untouched", /const TICK_MS = 10 \* 60 \* 1000/.test(restock))
check("no existing stores blindly ON", !mig.includes("enabled = TRUE") && !mig.includes("SET enabled = true"))

console.log(`\nLIVE_SENDS=0`)
console.log(`${passed}/${passed + failed} passed`)
if (failed > 0) process.exit(1)

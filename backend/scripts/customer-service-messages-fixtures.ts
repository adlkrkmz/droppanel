/**
 * Customer Service submenu + buyer messages fixtures.
 * Run: npx ts-node --transpile-only scripts/customer-service-messages-fixtures.ts
 */

import { readFileSync } from "fs"
import { join } from "path"

const root = join(__dirname, "..")
const oauth = readFileSync(join(root, "modules/ebayOAuth/ebayOAuthService.ts"), "utf8")
const shell = readFileSync(join(root, "panel/src/components/app/AppShell.tsx"), "utf8")
const css = readFileSync(join(root, "panel/src/app/globals.css"), "utf8")
const routes = readFileSync(join(root, "modules/app/appRoutes.ts"), "utf8")
const ebay = readFileSync(join(root, "modules/ebay/ebayApiClient.ts"), "utf8")
const thankYou = readFileSync(join(root, "modules/customerService/csThankYouService.ts"), "utf8")
const msgs = readFileSync(join(root, "modules/customerService/csMessagesService.ts"), "utf8")
const ui = readFileSync(join(root, "panel/src/app/(public)/app/customer-service/messages/page.tsx"), "utf8")
const autoPage = readFileSync(join(root, "panel/src/app/(public)/app/customer-service/page.tsx"), "utf8")
const settings = readFileSync(join(root, "panel/src/app/(public)/app/settings/page.tsx"), "utf8")
const poller = readFileSync(join(root, "modules/orders/ebayRecentOrderPollService.ts"), "utf8")
const restock = readFileSync(join(root, "modules/orders/soldItemAutoRestockScheduler.ts"), "utf8")

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

const requiredScopes = [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/commerce.identity.readonly",
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.account",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
  "https://api.ebay.com/oauth/api_scope/sell.finances",
  "https://api.ebay.com/oauth/api_scope/sell.analytics.readonly",
  "https://api.ebay.com/oauth/api_scope/sell.marketing",
  "https://api.ebay.com/oauth/api_scope/commerce.message",
]

for (const scope of requiredScopes) {
  check(`connect scopes include ${scope.replace("https://api.ebay.com/oauth/api_scope", "scope") || "base"}`, oauth.includes(`"${scope}"`))
}

const connectBlock = oauth.slice(
  oauth.indexOf("export const EBAY_OAUTH_CONNECT_SCOPES"),
  oauth.indexOf("export const EBAY_SCOPES")
)
check(
  "commerce.message added once via EBAY_MESSAGE_SCOPE_URL",
  /EBAY_MESSAGE_SCOPE_URL = "https:\/\/api\.ebay\.com\/oauth\/api_scope\/commerce\.message"/.test(oauth) &&
    connectBlock.includes("EBAY_MESSAGE_SCOPE_URL") &&
    (connectBlock.match(/EBAY_MESSAGE_SCOPE_URL/g) || []).length === 1
)
check("sidebar still uses app-shell-nav-link", shell.includes("app-shell-nav-link") && css.includes(".app-shell-nav-link {"))
check("CS submenu Automations + Buyer Messages", shell.includes("Automations") && shell.includes("Buyer Messages") && shell.includes("CustomerServiceNav"))
check("sidebar width not replaced", !css.includes("collapsed-sidebar") && css.includes(".app-shell-nav-sub"))
check("automations page kept", autoPage.includes("Thank You") && autoPage.includes("saveAppCsAutomation") && autoPage.includes("SHIPPED") && autoPage.includes("DELAYED") && autoPage.includes("DELIVERED"))
check("thank you enqueue intact", thankYou.includes("enqueueThankYouForNewOrder"))
check("official list endpoint", ebay.includes("/commerce/message/v1/conversation?") && ebay.includes("conversation_type"))
check("official detail endpoint", ebay.includes("/commerce/message/v1/conversation/${") && ebay.includes("getMessageConversation"))
check("official send_message kept", ebay.includes("/commerce/message/v1/send_message"))
check("trading fallback not deleted", ebay.includes("AddMemberMessageAAQToPartner"))
check("reply uses conversationId", ebay.includes("sendConversationMessage") && ui.includes("sendingRef"))
check("no AI reply UI", !ui.includes("AI Reply") && !ui.includes("auto reply"))
check("store selection reused", ui.includes("useAppStoreSelection") && ui.includes("adoptStoreSelection"))
check("FROM_MEMBERS buyer filter", msgs.includes('conversationType: "FROM_MEMBERS"'))
check("order link only unique listing match", msgs.includes("relatedOrderForListingItem") && msgs.includes("LIMIT 3"))
check("routes store-scoped", routes.includes("/app/customer-service/conversations") && routes.includes("assertStoreInUserWorkspace"))
check("gmail settings untouched", !settings.includes("customer_service_sends") && !settings.includes("Buyer Messages"))
check("poller cadence file still 2 min default", poller.includes("120_000"))
check("10-min restock unchanged", /const TICK_MS = 10 \* 60 \* 1000/.test(restock))
check("sticky composer class", ui.includes("app-cs-messages-composer") && ui.includes("sendingRef"))
check("independent list and thread scroll", ui.includes("app-cs-messages-list-scroll") && ui.includes("app-cs-messages-thread"))
check("reconnect warning visible", ui.includes("commerce.message") && ui.includes("Reconnect eBay"))
check("notification status visible", ui.includes("Check notifications") && ui.includes("NEW_MESSAGE"))
check("first-connect OAuth not rebuilt with notification scope", !connectBlock.includes("commerce.notification.subscription"))
const notifySvc = readFileSync(join(root, "modules/customerService/csNotificationService.ts"), "utf8")
const webhook = readFileSync(join(root, "modules/customerService/ebayNotificationWebhook.ts"), "utf8")
const notifyApi = readFileSync(join(root, "modules/customerService/ebayNotificationApi.ts"), "utf8")
const http = readFileSync(join(root, "modules/http/httpServer.ts"), "utf8")
check("official destination path", notifyApi.includes("/commerce/notification/v1/destination"))
check("official subscription path", notifyApi.includes("/commerce/notification/v1/subscription"))
check("official getTopic path", notifyApi.includes("/commerce/notification/v1/topic/"))
check("official notification config path", notifyApi.includes("/commerce/notification/v1/config"))
check("NEW_MESSAGE and BUYER_QUESTION topics", notifySvc.includes('"NEW_MESSAGE"') && notifySvc.includes('"BUYER_QUESTION"'))
check("webhook challenge GET", http.includes("/webhooks/ebay-notifications") && notifySvc.includes("challengeResponse"))
check("webhook no auto-reply", !webhook.includes("sendConversationMessage") && !webhook.includes("sendBuyerMessage"))
check("store-scoped event mapping", webhook.includes("findStoreByEbayUserKeys") && webhook.includes("bumpInboxUnreadHint"))
check("related order only unique", msgs.includes("relatedOrderId: related?.orderId ?? null"))

console.log(`\n${passed}/${passed + failed} passed`)
if (failed > 0) process.exit(1)

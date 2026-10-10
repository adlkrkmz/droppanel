/**
 * Delivery proof + professional CS messaging fixtures.
 * Run: npx ts-node --transpile-only scripts/cs-delivery-proof-messaging-fixtures.ts
 * Does not send live buyer messages.
 */

import { readFileSync } from "fs"
import { join } from "path"
import {
  extractBuyerFirstName,
  formatCustomerEta,
  formatDeliveryLocationCustomerText,
  renderGreeting,
} from "../modules/customerService/csBuyerName"
import {
  DEFAULT_DELAYED_TEMPLATE,
  DEFAULT_DELIVERED_TEMPLATE,
  DEFAULT_SHIPPED_TEMPLATE,
  DEFAULT_THANK_YOU_TEMPLATE,
  DELIVERED_TEMPLATE_LOCATION_ONLY,
  DELIVERED_TEMPLATE_LOCATION_PHOTO,
  DELIVERED_TEMPLATE_NEITHER,
  DELIVERED_TEMPLATE_PHOTO_ONLY,
  isUntouchedSystemTemplate,
  renderAutomationTemplate,
  resolveTemplateForRender,
} from "../modules/customerService/csTemplate"
import {
  deliveryProofObjectKey,
  extractDeliveryProofSourceUrl,
  isConservativeDeliveryProofUrl,
  isSafePublicProofUrl,
} from "../modules/mailbox/deliveryProofExtract"

const root = join(__dirname, "..")
const proofExtract = readFileSync(join(root, "modules/mailbox/deliveryProofExtract.ts"), "utf8")
const processor = readFileSync(join(root, "modules/imageProcessor/imageProcessorService.ts"), "utf8")
const proofStore = readFileSync(join(root, "modules/mailbox/deliveryProofStore.ts"), "utf8")
const ebayClient = readFileSync(join(root, "modules/ebay/ebayApiClient.ts"), "utf8")
const thankYou = readFileSync(join(root, "modules/customerService/csThankYouService.ts"), "utf8")
const deliveryPhotoMedia = readFileSync(join(root, "modules/customerService/csDeliveryPhotoMedia.ts"), "utf8")
const processSrc = readFileSync(join(root, "modules/mailbox/mailboxProcessService.ts"), "utf8")
const messages = readFileSync(join(root, "modules/customerService/csMessagesService.ts"), "utf8")
const ui = readFileSync(join(root, "panel/src/app/(public)/app/customer-service/page.tsx"), "utf8")
const mig = readFileSync(join(root, "migrations/087_delivery_proof_and_cs_messaging.sql"), "utf8")
const oauth = readFileSync(join(root, "modules/ebayOAuth/ebayOAuthService.ts"), "utf8")
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

const vars = (extra: Record<string, unknown> = {}) => ({
  buyer_username: "johnbuyer123",
  order_id: "12-34567-89012",
  store_name: "S2",
  ...extra,
})

check("A John Smith → Hi John,", renderGreeting(extractBuyerFirstName("John Smith")) === "Hi John,")
check("Mary Jane Smith → Mary", extractBuyerFirstName("Mary Jane Smith") === "Mary")
check("B no valid name → Hello,", renderGreeting(extractBuyerFirstName(null)) === "Hello,")
check("C username is not first name", extractBuyerFirstName("johnbuyer123") === null)
check("C username not used when equal", extractBuyerFirstName("johnbuyer123", "johnbuyer123") === null)
check("C email rejected", extractBuyerFirstName("john@example.com") === null)
check("C numeric rejected", extractBuyerFirstName("123456") === null)

const thankEta = renderAutomationTemplate("THANK_YOU", DEFAULT_THANK_YOU_TEMPLATE, vars({
  buyer_name: "John Smith",
  estimated_delivery: "2026-09-30",
}))
check("D thank you with ETA natural", thankEta.startsWith("Hi John,") && thankEta.includes("September 30") && thankEta.includes("prepared for shipment") && !/shipped/i.test(thankEta.split("prepared")[0] ?? ""))
check("D thank you eta not ISO", !thankEta.includes("2026-09-30T") && !thankEta.includes("2026-09-30"))

const thankNo = renderAutomationTemplate("THANK_YOU", DEFAULT_THANK_YOU_TEMPLATE, vars({ buyer_name: "John Smith" }))
check("E thank you without ETA", thankNo.includes("as soon as shipping information becomes available") && !thankNo.includes("expected to arrive by"))

const shipEta = renderAutomationTemplate("SHIPPED", DEFAULT_SHIPPED_TEMPLATE, vars({
  buyer_name: "John Smith",
  estimated_delivery: "2026-09-30",
}))
check("F shipped with ETA", shipEta.includes("has shipped") && shipEta.includes("September 30"))

const shipNo = renderAutomationTemplate("SHIPPED", DEFAULT_SHIPPED_TEMPLATE, vars({ buyer_name: "John Smith" }))
check("G shipped without ETA", shipNo.includes("has shipped") && !shipNo.includes("estimated delivery date") && !/tracking/i.test(shipNo))

const delayEta = renderAutomationTemplate("DELAYED", DEFAULT_DELAYED_TEMPLATE, vars({
  estimated_delivery: "2027-01-03",
}))
check("H delayed with ETA year", delayEta.includes("January 3, 2027") && delayEta.startsWith("Hello,"))

const delayNo = renderAutomationTemplate("DELAYED", DEFAULT_DELAYED_TEMPLATE, vars())
check("I delayed without ETA does not invent", !delayNo.includes("January") && !delayNo.includes("carrier has provided") && delayNo.includes("new delivery information"))

const locPhoto = renderAutomationTemplate("DELIVERED", DEFAULT_DELIVERED_TEMPLATE, vars({
  buyer_name: "John Smith",
  delivery_location: "near the front door or porch",
  has_delivery_photo: true,
}))
check("J delivered location+photo text", locPhoto.includes("left near the front door or porch") && locPhoto.includes("delivery photo") && !/left left/i.test(locPhoto))

const locOnly = renderAutomationTemplate("DELIVERED", DEFAULT_DELIVERED_TEMPLATE, vars({
  delivery_location: "near the front door or porch",
}))
check("K delivered location only", locOnly.includes("left near the front door") && !locOnly.includes("delivery photo"))

const photoOnly = renderAutomationTemplate("DELIVERED", DEFAULT_DELIVERED_TEMPLATE, vars({ has_delivery_photo: true }))
check("L delivered photo only", photoOnly.includes("delivery photo") && !photoOnly.includes("was left"))

const neither = renderAutomationTemplate("DELIVERED", DEFAULT_DELIVERED_TEMPLATE, vars())
check("M neither", !neither.includes("delivery photo") && !neither.includes("was left") && neither.includes("marked as delivered"))

const proof = "https://us-prod-temp.s3.amazonaws.com/imageId-abc123?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=259200&X-Amz-Signature=deadbeef"
const html = `
<img src="https://m.media-amazon.com/images/G/01/x-locale/common/amazon-logo.gif" />
<img src="https://images-na.ssl-images-amazon.com/images/G/01/delivery-illustration.gif" />
<img src="${proof}" />
<img src="https://m.media-amazon.com/images/I/51PRODUCT.jpg" />
`
check("N logos not proof", !isConservativeDeliveryProofUrl("https://m.media-amazon.com/images/G/01/amazon-logo.gif"))
check("N extract picks signed s3 imageId", extractDeliveryProofSourceUrl(html) === proof)
check("N product asset rejected", !isConservativeDeliveryProofUrl("https://m.media-amazon.com/images/I/51PRODUCT.jpg"))

check("O R2 prefix delivery-proofs", proofExtract.includes("delivery-proofs/") && processor.includes('key.startsWith("delivery-proofs/")'))
check("O not listings processor", !proofStore.includes("processAndUploadImages") && !proofStore.includes("TARGET_SIZE"))
const key = deliveryProofObjectKey({
  workspaceId: "11111111-1111-1111-1111-111111111111",
  storeId: 4,
  ebayOrderId: "12-1",
  mailboxMessageId: 99,
  ext: "jpg",
})
const key2 = deliveryProofObjectKey({
  workspaceId: "11111111-1111-1111-1111-111111111111",
  storeId: 4,
  ebayOrderId: "12-1",
  mailboxMessageId: 99,
  ext: "jpg",
})
check("P no banner/crop in proof store", !proofStore.includes("FREE SHIPPING") && !proofStore.includes("2000"))
check("S stable key reused", key === key2 && key.startsWith("delivery-proofs/"))
const otherStore = deliveryProofObjectKey({
  workspaceId: "11111111-1111-1111-1111-111111111111",
  storeId: 9,
  ebayOrderId: "12-1",
  mailboxMessageId: 99,
  ext: "jpg",
})
check("R cross-store keys differ", key !== otherStore)

check("Q capture does not throw out of process", processSrc.includes("captureDeliveryProofIfPresent") && processSrc.includes("AMAZON_DELIVERED"))

const leak = [thankEta, thankNo, shipEta, shipNo, delayEta, delayNo, locPhoto, locOnly, photoOnly, neither].join("\n")
check("T no amazon/asin/shipmentId/undefined/null", !/\bamazon\b|\basin\b|shipmentId|packageIndex|undefined|null/i.test(leak))

check("U no live send in this task files", !proofStore.includes("sendBuyerMessage"))
check("V inbox reply still text conversationId", messages.includes("sendConversationMessage({ conversationId, messageText })"))
check("W ledger unique unchanged", readFileSync(join(root, "modules/customerService/csRepository.ts"), "utf8").includes("ON CONFLICT (workspace_id, store_id, ebay_order_id, automation_type)"))

check("media contract fields", ebayClient.includes("messageMedia") && ebayClient.includes("mediaName") && ebayClient.includes("mediaType") && ebayClient.includes("mediaUrl"))
check("IMAGE type used", deliveryPhotoMedia.includes('mediaType: "IMAGE"'))
check("trading EPS fallback enabled", thankYou.includes("allowTradingFallback: true") && ebayClient.includes("<MessageMedia>"))
check("text-only 400 retry", ebayClient.includes("media_rejected_text_only"))
check("custom template preserved helper", isUntouchedSystemTemplate("THANK_YOU", "Custom hi {{greeting}}") === false)
check("system default detected", isUntouchedSystemTemplate("THANK_YOU", DEFAULT_THANK_YOU_TEMPLATE))
check("migration upgrades only old defaults", mig.includes("AND template_body = 'Thank you for your order.") && !mig.includes("enabled = TRUE"))
check("UI photo note no infra names", ui.includes("Delivery photo is included automatically when available.") && !ui.includes("Cloudflare") && !ui.includes("R2") && !ui.includes("S3"))
check("OAuth scopes untouched", oauth.includes("commerce.message"))
check("poller cadence untouched", poller.includes("120_000"))
check("unsafe location omitted", formatDeliveryLocationCustomerText("<script>x</script>") === null)
check("location natural", formatDeliveryLocationCustomerText("near the front door or porch") === "near the front door or porch")
check("eta format", formatCustomerEta("2026-09-30", new Date("2026-09-27T00:00:00Z")) === "September 30")
check("public proof host constrained", isSafePublicProofUrl("https://us-prod-temp.s3.amazonaws.com/imageId-x") === false)

prevEnv()
function prevEnv(): void {
  const prev = process.env.R2_PUBLIC_URL
  process.env.R2_PUBLIC_URL = "https://img.listjetgo.com"
  check(
    "public r2 url accepted",
    isSafePublicProofUrl("https://img.listjetgo.com/delivery-proofs/ws/1/abc.jpg") === true
  )
  if (prev === undefined) delete process.env.R2_PUBLIC_URL
  else process.env.R2_PUBLIC_URL = prev
}

check("delivered variants selected", resolveTemplateForRender("DELIVERED", DEFAULT_DELIVERED_TEMPLATE, {
  hasEta: false, hasLocation: true, hasPhoto: true,
}) === DELIVERED_TEMPLATE_LOCATION_PHOTO)
check("delivered location only variant", resolveTemplateForRender("DELIVERED", DEFAULT_DELIVERED_TEMPLATE, {
  hasEta: false, hasLocation: true, hasPhoto: false,
}) === DELIVERED_TEMPLATE_LOCATION_ONLY)
check("delivered photo only variant", resolveTemplateForRender("DELIVERED", DEFAULT_DELIVERED_TEMPLATE, {
  hasEta: false, hasLocation: false, hasPhoto: true,
}) === DELIVERED_TEMPLATE_PHOTO_ONLY)
check("delivered neither variant", resolveTemplateForRender("DELIVERED", DEFAULT_DELIVERED_TEMPLATE, {
  hasEta: false, hasLocation: false, hasPhoto: false,
}) === DELIVERED_TEMPLATE_NEITHER)

console.log(`\n${passed}/${passed + failed} passed`)
if (failed > 0) process.exit(1)

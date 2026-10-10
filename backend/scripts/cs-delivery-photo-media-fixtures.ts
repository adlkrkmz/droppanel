/**
 * Delivery-photo media fixtures. No live eBay calls or buyer messages.
 * Run: npx ts-node --transpile-only -r dotenv/config scripts/cs-delivery-photo-media-fixtures.ts
 */
import assert from "node:assert/strict"
import sharp from "sharp"
import { prepareDeliveryPhotoMedia } from "../modules/customerService/csDeliveryPhotoMedia"
import {
  DEFAULT_DELIVERED_TEMPLATE,
  removeDeliveryPhotoClaim,
  renderAutomationTemplate,
} from "../modules/customerService/csTemplate"

const originalFetch = global.fetch
const baseVars = {
  buyer_username: "buyer",
  order_id: "order-1",
  store_name: "store",
  delivery_location: "near the front door",
}

async function run(): Promise<void> {
  const jpeg = await sharp({
    create: { width: 200, height: 200, channels: 3, background: "#ffffff" },
  }).jpeg().toBuffer()

  let uploads = 0
  const uploader = {
    async uploadImage(buffer: Buffer, fileName: string, contentType?: string): Promise<string> {
      uploads++
      assert.deepEqual(buffer, jpeg)
      assert.equal(fileName, "delivery-photo.jpg")
      assert.equal(contentType, "image/jpeg")
      return "https://i.ebayimg.com/images/g/test-proof/s-l1600.jpg"
    },
  }

  global.fetch = async () => new Response(jpeg, {
    status: 200,
    headers: { "content-type": "image/jpeg", "content-length": String(jpeg.length) },
  })
  const valid = await prepareDeliveryPhotoMedia(uploader, "https://img.listjetgo.test/proof.jpg")
  assert.equal(valid.ok, true)
  if (!valid.ok) throw new Error("expected prepared media")
  const withPhoto = renderAutomationTemplate("DELIVERED", DEFAULT_DELIVERED_TEMPLATE, {
    ...baseVars,
    has_delivery_photo: valid.ok,
  })
  assert.match(withPhoto, /delivery photo below/i)
  assert.equal(valid.media.mediaType, "IMAGE")
  assert.match(valid.media.mediaUrl, /ebayimg\.com/)
  console.log("✓ A valid image is verified, EPS-prepared, attached, and enables photo wording")

  global.fetch = async () => new Response("missing", { status: 404 })
  const missing = await prepareDeliveryPhotoMedia(uploader, "https://img.listjetgo.test/missing.jpg")
  assert.deepEqual(missing, { ok: false, reason: "http_404", sourceContentType: "text/plain" })
  const missingBody = renderAutomationTemplate("DELIVERED", DEFAULT_DELIVERED_TEMPLATE, {
    ...baseVars,
    has_delivery_photo: false,
  })
  assert.doesNotMatch(missingBody, /delivery photo/i)
  assert.match(missingBody, /marked as delivered/i)
  console.log("✓ B HTTP 404 produces valid text-only wording and no attachment")

  global.fetch = async () => new Response("<!doctype html><html>login</html>", {
    status: 200,
    headers: { "content-type": "text/html" },
  })
  const html = await prepareDeliveryPhotoMedia(uploader, "https://img.listjetgo.test/login.jpg")
  assert.deepEqual(html, { ok: false, reason: "not_image", sourceContentType: "text/html" })
  assert.equal(uploads, 1, "failed sources must never reach EPS upload")
  assert.doesNotMatch(
    removeDeliveryPhotoClaim("Delivered. We’ve included the delivery photo below for your reference. Please check outside."),
    /delivery photo/i
  )
  console.log("✓ C HTML/login response is rejected and never attached")
}

run().finally(() => { global.fetch = originalFetch }).catch(error => {
  console.error(error)
  process.exitCode = 1
})

import sharp from "sharp"
import { query } from "../../db/client"
import { uploadObjectToR2 } from "../imageProcessor/imageProcessorService"
import {
  deliveryProofObjectKey,
  extractDeliveryProofSourceUrl,
  stripSignedQuery,
} from "./deliveryProofExtract"

const LOG = "[DeliveryProof]"
const MAX_BYTES = 6 * 1024 * 1024
const FETCH_MS = 12_000
const MIN_DIM = 120
const MAX_DIM = 8000
const ALLOWED_TYPES = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"])

export async function captureDeliveryProofIfPresent(input: {
  workspaceId: string
  storeId: number
  orderPk: number
  mailboxMessageId: number
  htmlBody: string | null
}): Promise<{ stored: boolean; reason?: string }> {
  try {
    const existing = await query<{
      ebay_order_id: string
      delivery_proof_r2_url: string | null
      delivery_proof_source_mailbox_message_id: string | null
    }>(
      `SELECT ebay_order_id, delivery_proof_r2_url, delivery_proof_source_mailbox_message_id::text
       FROM ebay_orders
       WHERE workspace_id = $1::uuid AND store_id = $2 AND id = $3
       LIMIT 1`,
      [input.workspaceId, input.storeId, input.orderPk]
    )
    const row = existing.rows[0]
    if (!row) return { stored: false, reason: "order_not_found" }
    if (
      row.delivery_proof_r2_url &&
      Number(row.delivery_proof_source_mailbox_message_id) === input.mailboxMessageId
    ) {
      return { stored: true, reason: "already_stored" }
    }
    if (row.delivery_proof_r2_url) {
      return { stored: true, reason: "already_stored_other_message" }
    }

    const sourceUrl = extractDeliveryProofSourceUrl(input.htmlBody)
    if (!sourceUrl) return { stored: false, reason: "no_proof_url" }

    const copied = await copyDeliveryProofToR2({
      workspaceId: input.workspaceId,
      storeId: input.storeId,
      ebayOrderId: row.ebay_order_id,
      mailboxMessageId: input.mailboxMessageId,
      sourceUrl,
    })
    if (!copied.ok) {
      console.warn(`${LOG} fetch skipped mailbox_id=${input.mailboxMessageId} reason=${copied.reason}`)
      return { stored: false, reason: copied.reason }
    }

    await query(
      `UPDATE ebay_orders
       SET delivery_proof_source_url = $4,
           delivery_proof_r2_url = $5,
           delivery_proof_content_type = $6,
           delivery_proof_stored_at = NOW(),
           delivery_proof_source_mailbox_message_id = $7,
           updated_at = NOW()
       WHERE workspace_id = $1::uuid AND store_id = $2 AND id = $3
         AND delivery_proof_r2_url IS NULL`,
      [
        input.workspaceId,
        input.storeId,
        input.orderPk,
        stripSignedQuery(sourceUrl),
        copied.publicUrl,
        copied.contentType,
        input.mailboxMessageId,
      ]
    )
    console.log(
      `${LOG} stored store_id=${input.storeId} order_pk=${input.orderPk} mailbox_id=${input.mailboxMessageId} host=${hostOf(sourceUrl)}`
    )
    return { stored: true }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.warn(`${LOG} capture failed mailbox_id=${input.mailboxMessageId}: ${msg}`)
    return { stored: false, reason: "capture_error" }
  }
}

export async function copyDeliveryProofToR2(input: {
  workspaceId: string
  storeId: number
  ebayOrderId: string
  mailboxMessageId: number
  sourceUrl: string
}): Promise<
  | { ok: true; publicUrl: string; contentType: string }
  | { ok: false; reason: string; contentType?: string }
> {
  const fetched = await fetchProofImage(input.sourceUrl)
  if (!fetched.ok) return { ok: false, reason: fetched.reason }
  const key = deliveryProofObjectKey({
    workspaceId: input.workspaceId,
    storeId: input.storeId,
    ebayOrderId: input.ebayOrderId,
    mailboxMessageId: input.mailboxMessageId,
    ext: fetched.ext,
  })
  const publicUrl = await uploadObjectToR2(fetched.buffer, key, fetched.contentType)
  return { ok: true, publicUrl, contentType: fetched.contentType }
}

export async function fetchProofImage(sourceUrl: string): Promise<
  | { ok: true; buffer: Buffer; contentType: string; ext: string }
  | { ok: false; reason: string; contentType?: string }
> {
  let current = sourceUrl
  for (let hop = 0; hop < 4; hop++) {
    let target: URL
    try {
      target = new URL(current)
    } catch {
      return { ok: false, reason: "invalid_url" }
    }
    if (target.protocol !== "https:") return { ok: false, reason: "non_https" }

    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), FETCH_MS)
    let res: Response
    try {
      res = await fetch(current, {
        method: "GET",
        redirect: "manual",
        signal: ac.signal,
        headers: { Accept: "image/jpeg,image/png,image/webp,image/*;q=0.8" },
      })
    } catch {
      return { ok: false, reason: "fetch_failed" }
    } finally {
      clearTimeout(timer)
    }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location")
      if (!loc) return { ok: false, reason: "redirect_missing" }
      current = new URL(loc, current).toString()
      continue
    }
    if (!res.ok) {
      const failureType = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase()
      return { ok: false, reason: "http_" + res.status, contentType: failureType || undefined }
    }

    const declared = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase()
    if (declared.includes("html") || declared.includes("json") || declared.includes("text/")) {
      return { ok: false, reason: "not_image", contentType: declared || undefined }
    }
    const len = Number(res.headers.get("content-length") ?? "0")
    if (len > MAX_BYTES) return { ok: false, reason: "too_large" }

    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length < 32 || buf.length > MAX_BYTES) return { ok: false, reason: "invalid_size" }
    if (looksLikeHtml(buf)) return { ok: false, reason: "html_body", contentType: declared || undefined }

    const sniffed = sniffImage(buf, declared)
    if (!sniffed) return { ok: false, reason: "unsupported_type", contentType: declared || undefined }

    try {
      const meta = await sharp(buf, { failOn: "none" }).metadata()
      const w = meta.width ?? 0
      const h = meta.height ?? 0
      if (w && h && (w < MIN_DIM || h < MIN_DIM || w > MAX_DIM || h > MAX_DIM)) {
        return { ok: false, reason: "invalid_dimensions" }
      }
    } catch {
      // Magic bytes already validated; metadata is optional.
    }

    return { ok: true, buffer: buf, contentType: sniffed.contentType, ext: sniffed.ext }
  }
  return { ok: false, reason: "too_many_redirects" }
}

function sniffImage(buf: Buffer, declared: string): { contentType: string; ext: string } | null {
  const jpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff
  const png = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
  const webp = buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP"
  if (jpeg) return { contentType: "image/jpeg", ext: "jpg" }
  if (png) return { contentType: "image/png", ext: "png" }
  if (webp) return { contentType: "image/webp", ext: "webp" }
  if (ALLOWED_TYPES.has(declared) && declared.includes("jpeg")) return { contentType: "image/jpeg", ext: "jpg" }
  return null
}

function looksLikeHtml(buf: Buffer): boolean {
  const head = buf.subarray(0, 64).toString("utf8").toLowerCase()
  return head.includes("<html") || head.includes("<!doctype")
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return "unknown"
  }
}

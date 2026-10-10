/**
 * One-message historical delivery-proof verification. Never sends buyer messages.
 * Run: npx ts-node --transpile-only scripts/verify-delivery-proof-historical.ts
 */
import path from "path"
import dotenv from "dotenv"
import { Pool } from "pg"
import { extractDeliveryProofSourceUrl } from "../modules/mailbox/deliveryProofExtract"

dotenv.config({ path: path.join(__dirname, "../.env") })

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error("DATABASE_URL is not defined")
  const { captureDeliveryProofIfPresent, copyDeliveryProofToR2 } = await import("../modules/mailbox/deliveryProofStore")
  const pool = new Pool({ connectionString: dbUrl })
  const automations = await pool.query<{ automation_type: string; enabled: boolean }>(
    `SELECT automation_type, enabled FROM customer_service_automations`
  )
  console.log(
    `automations_rows=${automations.rows.length} enabled=${automations.rows.filter(r => r.enabled).length}`
  )

  const res = await pool.query<{
    id: number
    workspace_id: string
    store_id: number
    matched_ebay_order_pk: number | null
    html_body: string | null
    classified_type: string | null
  }>(
    `SELECT id, workspace_id::text, store_id, matched_ebay_order_pk, html_body, classified_type
     FROM mailbox_messages
     WHERE classified_type = 'AMAZON_DELIVERED'
       AND html_body IS NOT NULL
       AND (
         html_body ILIKE '%imageId-%'
         OR html_body ILIKE '%us-prod-temp%'
         OR html_body ILIKE '%X-Amz-Signature%'
       )
     ORDER BY id DESC
     LIMIT 8`
  )
  console.log(`candidates=${res.rows.length}`)
  let used: number | null = null
  for (const row of res.rows) {
    const url = extractDeliveryProofSourceUrl(row.html_body)
    const host = url ? new URL(url).hostname : "none"
    console.log(`mailbox_id=${row.id} store_id=${row.store_id} proof_host=${host} detected=${Boolean(url)} matched=${row.matched_ebay_order_pk != null}`)
    if (url && used == null) {
      used = row.id
      if (row.matched_ebay_order_pk) {
        const stored = await captureDeliveryProofIfPresent({
          workspaceId: row.workspace_id,
          storeId: row.store_id,
          orderPk: row.matched_ebay_order_pk,
          mailboxMessageId: row.id,
          htmlBody: row.html_body,
        })
        console.log(`capture_result stored=${stored.stored} reason=${stored.reason ?? "ok"}`)
      } else {
        const copied = await copyDeliveryProofToR2({
          workspaceId: row.workspace_id,
          storeId: row.store_id,
          ebayOrderId: `unmatched-mailbox-${row.id}`,
          mailboxMessageId: row.id,
          sourceUrl: url,
        })
        if (!copied.ok) {
          console.log(`copy_result stored=false reason=${copied.reason}`)
        } else {
          console.log(`copy_result stored=true r2_path_ok=${copied.publicUrl.includes("/delivery-proofs/")}`)
          console.log(`r2_host=${new URL(copied.publicUrl).hostname}`)
          console.log(`content_type=${copied.contentType}`)
          const head = await fetch(copied.publicUrl, { method: "HEAD" })
          console.log(`public_head=${head.status} content_type=${head.headers.get("content-type")}`)
        }
      }
    }
  }
  if (used == null) console.log("HISTORICAL_EMAIL_TEST=no_usable_candidate")
  else console.log("HISTORICAL_EMAIL_TEST=ran")
  console.log("LIVE_SENDS=0")
  await pool.end()
}

void main().catch(e => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})

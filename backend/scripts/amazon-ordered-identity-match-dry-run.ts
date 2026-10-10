/**
 * Dry-run: last 7 days AMAZON_ORDERED identity match. Does not write amazon_order_number.
 * npx ts-node --transpile-only scripts/amazon-ordered-identity-match-dry-run.ts
 */
import path from "path"
import dotenv from "dotenv"
import { Pool } from "pg"
import { htmlToText, parseAmazonOrderedEmail } from "../modules/mailbox/amazonEmailParser"

dotenv.config({ path: path.join(__dirname, "../.env") })

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error("DATABASE_URL is not defined")
  const { matchAmazonParseToEbayOrder } = await import("../modules/mailbox/orderMatchService")
  const pool = new Pool({ connectionString: dbUrl })
  const mails = await pool.query<{
    id: number
    workspace_id: string
    store_id: number
    received_at: Date
    processing_status: string
    text_body: string | null
    html_body: string | null
  }>(
    `SELECT id, workspace_id::text, store_id, received_at, processing_status, text_body, html_body
     FROM mailbox_messages
     WHERE classified_type = 'AMAZON_ORDERED'
       AND received_at >= NOW() - INTERVAL '7 days'
     ORDER BY id ASC`
  )

  let unique = 0
  let exact = 0
  let asinHigh = 0
  let ambiguous = 0
  let none = 0
  let conflict = 0
  let parseFail = 0
  const uniqueSamples: string[] = []

  for (const row of mails.rows) {
    const text = (row.text_body?.trim() || htmlToText(row.html_body ?? "")).trim()
    const parsed = parseAmazonOrderedEmail(text)
    if (!parsed.amazonOrderNumber || !parsed.recipientLabel || !parsed.destinationCity || !parsed.destinationState) {
      parseFail++
      continue
    }
    const result = await matchAmazonParseToEbayOrder({
      workspaceId: row.workspace_id,
      parsed,
      receivedAt: row.received_at,
    })
    if (result.ok && result.reason === "exact_amazon_number") exact++
    else if (result.ok && result.reason === "unique_high_confidence") asinHigh++
    else if (result.ok && result.reason === "unique_name_city_state") {
      unique++
      if (uniqueSamples.length < 8) {
        uniqueSamples.push(
          `mail=${row.id} store=${row.store_id} orderPk=${result.orderPk} name=${parsed.recipientLabel} ${parsed.destinationCity} ${parsed.destinationState}`
        )
      }
    } else if (!result.ok && result.reason === "ambiguous") ambiguous++
    else if (!result.ok && result.reason === "weak_evidence") conflict++
    else none++
  }

  console.log(
    JSON.stringify(
      {
        total_ordered_mails: mails.rows.length,
        parse_missing_name_city_state_or_order: parseFail,
        exact_amazon_number: exact,
        unique_asin_high_confidence: asinHigh,
        unique_name_city_state: unique,
        ambiguous: ambiguous,
        no_candidate: none,
        existing_order_number_conflict: conflict,
        unique_samples: uniqueSamples,
      },
      null,
      2
    )
  )
  await pool.end()
}

void main().catch(e => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})

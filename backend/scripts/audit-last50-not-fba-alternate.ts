/**
 * READ-ONLY audit: last N store_catalog_state rows bot_zeroed for NOT_FBA / qty0.
 * Re-opens Amazon with public worker logic (alternate select) — no submit / no eBay mutation.
 */
import path from 'node:path'
import fs from 'node:fs'
import { Pool } from 'pg'
import {
  AmazonPublicWorker,
} from '../modules/amazonPublicWorker/amazonPublicWorker'
import type { AppConfig } from '../modules/amazonPublicWorker/types'
import { mapPublicObservationToVerificationPayload } from '../modules/amazonPublicWorker/mapPublicObservationToVerificationPayload'
import { classifyVerifiedAmazonSource } from '../modules/amazonVerification/verifiedSourceDecision'
import { shipsFromAmazon } from '../modules/amazonVerification/amazonVerificationNormalize'
import { setPublicWorkerPersistenceSink } from '../modules/amazonPublicWorker/persistence'

require('dotenv').config()

const LIMIT = Number(process.argv[2] || 50)

async function main(): Promise<void> {
  process.env.AMAZON_PUBLIC_US_ZIP = process.env.AMAZON_PUBLIC_US_ZIP || '10001'
  setPublicWorkerPersistenceSink({
    logEvent: (e, a, _w, d) => {
      if (/TECHNICAL|CHALLENGE|US_ZIP/.test(e)) console.log(`[audit] ${e} ${a ?? ''} ${d ?? ''}`)
    },
    updateItem: () => undefined,
  })

  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const { rows } = await pool.query<{
    catalog_id: string
    asin: string
    ebay_item_id: string | null
    ebay_quantity: number | null
    bot_zeroed_at: string
    bot_zeroed_reason: string
  }>(
    `SELECT scs.id::text AS catalog_id,
            scs.last_verified_asin AS asin,
            scs.ebay_item_id,
            scs.ebay_quantity,
            scs.bot_zeroed_at::text,
            scs.bot_zeroed_reason
     FROM store_catalog_state scs
     WHERE scs.bot_zeroed_reason = 'NOT_FBA'
       AND scs.ebay_quantity = 0
       AND scs.last_verified_asin IS NOT NULL
       AND scs.last_verified_asin <> ''
     ORDER BY scs.bot_zeroed_at DESC NULLS LAST
     LIMIT $1`,
    [LIMIT]
  )
  await pool.end()

  console.log(`AUDITING ${rows.length} NOT_FBA qty0 ASINs (read-only)`)

  const config: AppConfig = {
    localPort: 0,
    keepaConcurrency: 1,
    amazonMode: 'FAILOVER',
    amazonWorkers: ['C'],
    amazonActiveConcurrency: 1,
    amazonHeadless: true,
    navigationTimeout: 90000,
    keepaHeadless: true,
    keepaDelayMs: 1500,
    amazonDelayMs: 2500,
    technicalRetryMax: 1,
  }
  const worker = new AmazonPublicWorker('C', config)

  const results: Array<Record<string, unknown>> = []
  let falseNotFba = 0
  let alternateMissed = 0
  let errors = 0
  let stillNotFba = 0

  try {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      const asin = String(row.asin).toUpperCase()
      process.stdout.write(`[${i + 1}/${rows.length}] ${asin} ... `)
      try {
        const result = await worker.observe(asin)
        if (result.kind !== 'done' || !result.observation || !result.selection) {
          errors += 1
          console.log(`${result.kind} ${result.reason?.slice(0, 60) || ''}`)
          results.push({
            asin,
            catalogId: row.catalog_id,
            error: result.kind,
            reason: result.reason,
            alternateFound: false,
            wouldBeValid: false,
          })
          continue
        }
        const sel = result.selection
        const mapped = mapPublicObservationToVerificationPayload({
          requestedAsin: asin,
          observation: result.observation,
          publicStatus: result.status || 'AMAZON_CHECKED',
        })
        const decision = classifyVerifiedAmazonSource({
          requestedAsin: asin,
          finalAsin: mapped.payload.finalAsin,
          displayedPrice: typeof mapped.payload.displayedPrice === 'number' ? mapped.payload.displayedPrice : null,
          condition: typeof mapped.payload.condition === 'string' ? mapped.payload.condition : null,
          isPrime: typeof mapped.payload.isPrime === 'boolean' ? mapped.payload.isPrime : null,
          isFba: typeof mapped.payload.isFba === 'boolean' ? mapped.payload.isFba : null,
          shipsFromAmazon: shipsFromAmazon(mapped.shipsFromNormalized),
          purchasable:
            mapped.payload.metadata && typeof mapped.payload.metadata.purchasable === 'string'
              ? (mapped.payload.metadata.purchasable as 'TRUE' | 'FALSE' | 'UNKNOWN')
              : null,
          stockStatus: typeof mapped.payload.stockStatus === 'string' ? mapped.payload.stockStatus : null,
          availabilityText: typeof mapped.payload.availabilityText === 'string' ? mapped.payload.availabilityText : null,
          pageUnavailable: mapped.payload.pageUnavailable === true,
          redirected: mapped.payload.redirected === true,
          offerPageHealthy: mapped.payload.metadata?.offerPageHealthy === true,
        })
        const wouldBeValid = decision.outcome === 'VALID_SOURCE'
        const missed =
          sel.alternateFound &&
          sel.finalSelectedSource === 'ALTERNATE' &&
          wouldBeValid
        if (missed) {
          falseNotFba += 1
          alternateMissed += 1
        } else if (decision.code === 'NOT_FBA') {
          stillNotFba += 1
        } else if (wouldBeValid && sel.finalSelectedSource === 'PRIMARY') {
          // primary now valid (offer changed) — count as false NOT_FBA too
          falseNotFba += 1
        }

        console.log(
          `src=${sel.finalSelectedSource} alt=${sel.alternateFound ? 'Y' : 'N'} ` +
            `price=${result.observation.mainPrice} ships=${(result.observation.shipsFrom || '').slice(0, 20)} ` +
            `dec=${decision.code}${missed ? ' **FALSE_NOT_FBA**' : ''}`
        )
        results.push({
          asin,
          catalogId: row.catalog_id,
          ebayItemId: row.ebay_item_id,
          botZeroedAt: row.bot_zeroed_at,
          primary: sel.primary,
          alternateFound: sel.alternateFound,
          alternate: sel.alternate,
          finalSelectedSource: sel.finalSelectedSource,
          finalPrice: result.observation.mainPrice,
          shipsFrom: result.observation.shipsFrom,
          soldBy: result.observation.soldBy,
          decision: decision.code,
          outcome: decision.outcome,
          wouldBeValid,
          falseNotFbaMissedAlternate: missed,
        })
        await new Promise((r) => setTimeout(r, 1800))
      } catch (e) {
        errors += 1
        console.log('ERR', e instanceof Error ? e.message : e)
        results.push({ asin, catalogId: row.catalog_id, error: String(e) })
      }
    }
  } finally {
    await worker.close()
    setPublicWorkerPersistenceSink(null)
  }

  const summary = {
    LAST_50_NOT_FBA_AUDITED: results.length,
    FALSE_NOT_FBA_FOUND: falseNotFba,
    ALTERNATE_MISSED_NOW_VALID: alternateMissed,
    STILL_NOT_FBA: stillNotFba,
    ERRORS: errors,
    FALSE_ASINS: results
      .filter((r) => r.falseNotFbaMissedAlternate || (r.wouldBeValid && !r.error))
      .map((r) => ({
        asin: r.asin,
        source: r.finalSelectedSource,
        price: r.finalPrice,
        shipsFrom: r.shipsFrom,
        soldBy: r.soldBy,
        decision: r.decision,
        alternateFound: r.alternateFound,
      })),
  }
  const outPath = path.resolve('var/audit-last50-not-fba-alternate.json')
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify({ summary, results }, null, 2))
  console.log(JSON.stringify(summary, null, 2))
  console.log(`WROTE ${outPath}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

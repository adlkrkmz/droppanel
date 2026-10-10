import "dotenv/config"
import { closeDbPool, query } from "../db/client"
import { GLOBAL_KEEPA_ACTIVE_CONSUMER_WHERE } from "../modules/globalKeepa/globalKeepaEligibility"
import { runGlobalKeepaPlannerForAsins } from "../modules/globalKeepa/globalKeepaPlannerTick"
import { markGlobalAsinImmediatelyDue } from "../modules/globalKeepa/globalKeepaPlannerState"

const WORKSPACE_ID = process.env.WORKSPACE_ID || "00000000-0000-0000-0000-000000000001"
const PREFERRED = ["B0CVVX47K8", "B00367HAV6"]

function assertLocalDb(): void {
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error("DATABASE_URL is not defined")
  const host = new URL(dbUrl).hostname.toLowerCase()
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
    throw new Error(`Refusing: DATABASE_URL host=${host} is not local`)
  }
}

async function main(): Promise<void> {
  assertLocalDb()
  await query(
    `INSERT INTO workspace_members (workspace_id, user_id, role)
     SELECT $1::uuid, u.id, 'member'
     FROM users u
     WHERE u.approval_status = 'active'
     ON CONFLICT (workspace_id, user_id) DO NOTHING`,
    [WORKSPACE_ID]
  )
  await query(
    `INSERT INTO user_product_access (user_id, product, status)
     SELECT u.id, 'EBAY', 'ACTIVE'
     FROM users u
     WHERE u.approval_status = 'active'
     ON CONFLICT (user_id, product) DO NOTHING`
  )
  const rows = await query<{ asin: string; global_asin_id: string }>(
    `SELECT g.asin, g.id::text AS global_asin_id
     FROM global_asin_consumers c
     JOIN global_amazon_asins g ON g.id = c.global_asin_id
     JOIN store_catalog_state scs ON scs.id = c.catalog_state_id
     JOIN stores st ON st.id = c.store_id AND st.workspace_id = c.workspace_id
     WHERE ${GLOBAL_KEEPA_ACTIVE_CONSUMER_WHERE}
     GROUP BY g.id, g.asin
     ORDER BY CASE WHEN g.asin = ANY($1::text[]) THEN 0 ELSE 1 END, g.asin ASC
     LIMIT 50`,
    [PREFERRED]
  )
  const asins = rows.rows.map(r => r.asin)
  for (const row of rows.rows) {
    await markGlobalAsinImmediatelyDue(Number(row.global_asin_id))
  }
  const keepa = await runGlobalKeepaPlannerForAsins({ asins, live: true, batchSize: 10 })
  console.log("FIRST_50", {
    uniqueAsins: asins.length,
    preferredPresent: PREFERRED.filter(a => asins.includes(a)),
    keepa,
  })
}

main()
  .catch(err => {
    console.error(err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
  .finally(() => closeDbPool())

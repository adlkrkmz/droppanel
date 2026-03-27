import "dotenv/config"
import { query, closeDbPool } from "./db/client"
async function main() {
  const r = await query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'amazon_product_cache' ORDER BY ordinal_position`)
  console.log(JSON.stringify(r.rows, null, 2))
  await closeDbPool()
}
main().catch(console.error)

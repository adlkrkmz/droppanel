import "dotenv/config"
import { query, closeDbPool } from "./db/client"

async function main() {
  const result = await query(
    `SELECT column_name, data_type 
     FROM information_schema.columns 
     WHERE table_name = 'asin_locks' 
     ORDER BY ordinal_position`
  )
  console.log(JSON.stringify(result.rows, null, 2))
  await closeDbPool()
}

main().catch(console.error)

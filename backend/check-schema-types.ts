import "dotenv/config"
import { query, closeDbPool } from "./db/client"

async function main() {
  // stores tablosunun id tipi
  const stores = await query(`
    SELECT column_name, data_type, column_default, is_nullable
    FROM information_schema.columns
    WHERE table_name = 'stores'
    ORDER BY ordinal_position
  `)
  console.log("=== stores ===")
  console.log(JSON.stringify(stores.rows, null, 2))

  // workspaces id tipi
  const ws = await query(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name = 'workspaces'
    ORDER BY ordinal_position
  `)
  console.log("=== workspaces ===")
  console.log(JSON.stringify(ws.rows, null, 2))

  await closeDbPool()
}
main().catch(console.error)

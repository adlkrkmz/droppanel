import "dotenv/config"
import { query, closeDbPool } from "./db/client"

async function main() {
  const workspaceId = process.env.WORKSPACE_ID!

  // Test 1: asin_registry
  try {
    const r = await query("SELECT COUNT(*) as c FROM asin_registry WHERE workspace_id = $1", [workspaceId])
    console.log("asin_registry:", r.rows[0])
  } catch(e) { console.error("asin_registry FAIL:", e) }

  // Test 2: asin_pool
  try {
    const r = await query("SELECT COUNT(*) as c FROM asin_pool WHERE workspace_id = $1", [workspaceId])
    console.log("asin_pool:", r.rows[0])
  } catch(e) { console.error("asin_pool FAIL:", e) }

  // Test 3: stores
  try {
    const r = await query("SELECT COUNT(*) as c FROM stores WHERE workspace_id = $1", [workspaceId])
    console.log("stores:", r.rows[0])
  } catch(e) { console.error("stores FAIL:", e) }

  // Test 4: stores columns
  try {
    const r = await query("SELECT column_name FROM information_schema.columns WHERE table_name='stores' ORDER BY ordinal_position")
    console.log("stores columns:", r.rows.map((x: any) => x.column_name))
  } catch(e) { console.error("stores columns FAIL:", e) }

  // Test 5: listing_history columns
  try {
    const r = await query("SELECT column_name FROM information_schema.columns WHERE table_name='listing_history' ORDER BY ordinal_position")
    console.log("listing_history columns:", r.rows.map((x: any) => x.column_name))
  } catch(e) { console.error("listing_history FAIL:", e) }

  // Test 6: asin_pool columns
  try {
    const r = await query("SELECT column_name FROM information_schema.columns WHERE table_name='asin_pool' ORDER BY ordinal_position")
    console.log("asin_pool columns:", r.rows.map((x: any) => x.column_name))
  } catch(e) { console.error("asin_pool FAIL:", e) }

  await closeDbPool()
}
main().catch(console.error)

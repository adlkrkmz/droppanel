import dotenv from "dotenv"

dotenv.config()

import { getValidAccessToken } from "../modules/ebayOAuth/ebayOAuthService"
import { query } from "../db/client"

async function main() {
  const stores = await query<{
    id: number
    store_code: string
    name: string
  }>(`
    SELECT s.id, s.store_code, s.name 
    FROM stores s
    JOIN ebay_accounts ea ON ea.store_id = s.id
    WHERE s.workspace_id = '00000000-0000-0000-0000-000000000001'
  `)

  for (const store of stores.rows) {
    try {
      const token = await getValidAccessToken(
        "00000000-0000-0000-0000-000000000001",
        store.store_code,
        false
      )
      const res = await fetch("https://apiz.ebay.com/commerce/identity/v1/user/", {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      })
      const data = (await res.json()) as { username?: string }
      console.log(`${store.store_code}: username=${data.username} status=${res.status}`)

      if (data.username) {
        await query(`UPDATE stores SET name = $1 WHERE id = $2`, [data.username, store.id])
        console.log(`${store.store_code}: name updated to ${data.username}`)
      }
    } catch (e) {
      console.error(`${store.store_code}: failed -`, e instanceof Error ? e.message : String(e))
    }
  }
}

main().catch(console.error)

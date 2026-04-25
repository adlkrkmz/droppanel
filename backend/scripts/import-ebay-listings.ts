import dotenv from 'dotenv'
dotenv.config()
import { syncStoreFromTrading } from '../modules/monitor/monitorSyncService'

async function main() {
  const storeIdRaw = process.argv[2] ?? ''
  const storeCode  = (process.argv[3] ?? '').trim()
  const storeId    = parseInt(storeIdRaw, 10)
  if (!Number.isFinite(storeId) || storeId <= 0 || !storeCode) {
    console.error('Usage: npx ts-node scripts/import-ebay-listings.ts <storeId> <storeCode>')
    process.exit(1)
  }

  console.log(`Syncing eBay Trading listings for store id=${storeId} code=${storeCode}...`)
  const result = await syncStoreFromTrading(storeId, storeCode)
  console.log('Done:', result)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

import dotenv from 'dotenv'
dotenv.config()
import { syncAllStores } from '../modules/monitor/monitorSyncService'

async function main() {
  console.log('Starting eBay price sync...')
  await syncAllStores()
  console.log('Sync completed')
  process.exit(0)
}

main().catch(console.error)

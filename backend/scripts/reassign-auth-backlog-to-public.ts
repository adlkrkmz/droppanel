import "dotenv/config"
import { reassignAuthBacklogToPublic } from "../modules/amazonScan/amazonScanAuthBacklog"

async function main(): Promise<void> {
  const execute = process.argv.includes("--execute")
  const result = await reassignAuthBacklogToPublic({ execute, limit: 500, spreadMinutes: 180 })
  console.log(JSON.stringify({ execute, ...result }, null, 2))
}

void main().catch(e => {
  console.error(e)
  process.exit(1)
})

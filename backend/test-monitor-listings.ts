import "dotenv/config"
import { closeDbPool } from "./db/client"
import { getMonitorListings } from "./modules/monitor/monitorService"

const workspaceId = process.env.WORKSPACE_ID
if (!workspaceId) throw new Error("WORKSPACE_ID missing")
const WID: string = workspaceId
if (!workspaceId) throw new Error("WORKSPACE_ID is not defined in .env")

const STORE_CODE = process.env.MONITOR_STORE_CODE ?? "S1"

function sep(len = 60): void { console.log("  " + "─".repeat(len)) }
function usd(n: number | null): string { return n !== null ? `$${n.toFixed(2)}` : "—" }
function pct(n: number | null): string { return n !== null ? `${n.toFixed(1)}%` : "—" }

async function main(): Promise<void> {
  console.log("═".repeat(60))
  console.log("  test-monitor-listings")
  console.log("═".repeat(60))

  const result = await getMonitorListings(WID, STORE_CODE, {
    oauthToken:     process.env.EBAY_OAUTH_TOKEN ?? "SIM_TOKEN",
    sandbox:        true,
    simulationMode: true,
  })

  console.log(`  Store      : ${result.store}`)
  console.log(`  Mode       : ${result.simulationMode ? "simulation" : "live"}`)
  console.log(`  Total      : ${result.total}`)
  console.log(`  Tracked    : ${result.tracked}`)
  console.log(`  Untracked  : ${result.untracked}`)
  console.log("")

  console.log(`  ${"".padEnd(4)}${"SKU".padEnd(28)}${"Status".padEnd(12)}${"Price".padEnd(9)}${"Cost".padEnd(9)}${"Margin".padEnd(9)}Qty`)
  sep()

  for (const item of result.items) {
    const icon = item.status === "TRACKED" ? "✓" : "—"
    console.log(
      `  ${icon.padEnd(4)}${item.sku.slice(0, 26).padEnd(28)}${item.status.padEnd(12)}` +
      `${usd(item.ebayPrice).padEnd(9)}${usd(item.cost).padEnd(9)}${pct(item.margin).padEnd(9)}${item.quantity}`
    )
  }

  console.log("")
  console.log("═".repeat(60))
  console.log(`  Total listings : ${result.total}`)
  console.log(`  Tracked        : ${result.tracked}`)
  console.log(`  Untracked      : ${result.untracked}`)
  console.log("═".repeat(60))
}

main()
  .catch((err: unknown) => { console.error("[HATA]", err instanceof Error ? err.message : err); process.exit(1) })
  .finally(async () => { await closeDbPool() })

import "dotenv/config"
import { closeDbPool }        from "./db/client"
import {
  buildAuthUrl,
  handleCallback,
  getAccountStatus,
  refreshAccessToken,
  getAllAccounts,
  getValidAccessToken,
} from "./modules/ebayOAuth/ebayOAuthService"

const workspaceId = process.env.WORKSPACE_ID
if (!workspaceId) throw new Error("WORKSPACE_ID missing")
const WID: string = workspaceId

const STORE_CODE      = "S1"
const SIMULATION_MODE = true   // gerçek eBay'e gitme

function sep(len = 60): void { console.log("  " + "─".repeat(len)) }

async function main(): Promise<void> {
  console.log("═".repeat(60))
  console.log("  test-ebay-oauth-flow  (simulation mode)")
  console.log("═".repeat(60))
  console.log(`  workspace : ${WID}`)
  console.log(`  storeCode : ${STORE_CODE}`)
  console.log("")

  // ── 1. Auth URL üret ─────────────────────────────────────────

  console.log("[1/5] Auth URL üret")
  sep()
  const urlResult = await buildAuthUrl(WID, STORE_CODE, SIMULATION_MODE)
  console.log(`  storeCode : ${urlResult.storeCode}`)
  console.log(`  authUrl   : ${urlResult.authUrl.slice(0, 80)}...`)
  console.log(`  state     : ${urlResult.state.slice(0, 40)}...`)

  // ── 2. Callback işle (sim code) ───────────────────────────────

  console.log("")
  console.log("[2/5] Callback işle (SIM_CODE ile)")
  sep()

  const callbackResult = await handleCallback(WID, "SIM_CODE", urlResult.state, SIMULATION_MODE)
  console.log(`  success      : ${callbackResult.success}`)
  console.log(`  storeCode    : ${callbackResult.storeCode}`)
  console.log(`  ebayUserId   : ${callbackResult.ebayUserId}`)
  console.log(`  accessToken  : ${callbackResult.accessToken.slice(0, 30)}...`)
  console.log(`  refreshToken : ${callbackResult.refreshToken.slice(0, 30)}...`)
  console.log(`  expiresAt    : ${callbackResult.expiresAt}`)
  console.log(`  scope        : ${callbackResult.scope.slice(0, 50)}...`)

  // ── 3. Account status ─────────────────────────────────────────

  console.log("")
  console.log("[3/5] Account status")
  sep()

  const status = await getAccountStatus(WID, STORE_CODE)
  console.log(`  connected    : ${status.connected}`)
  console.log(`  storeName    : ${status.storeName}`)
  console.log(`  ebayUserId   : ${status.ebayUserId}`)
  console.log(`  expired      : ${status.expired}`)
  console.log(`  expiresIn    : ${status.expiresIn ? Math.round(status.expiresIn / 60) + " min" : "—"}`)

  // ── 4. Token refresh ──────────────────────────────────────────

  console.log("")
  console.log("[4/5] Token refresh")
  sep()

  const refreshResult = await refreshAccessToken(WID, STORE_CODE, SIMULATION_MODE)
  console.log(`  new accessToken : ${refreshResult.accessToken.slice(0, 30)}...`)
  console.log(`  expiresAt       : ${refreshResult.expiresAt}`)

  // ── 5. getValidAccessToken ────────────────────────────────────

  console.log("")
  console.log("[5/5] getValidAccessToken")
  sep()

  const token = await getValidAccessToken(WID, STORE_CODE, SIMULATION_MODE)
  console.log(`  token : ${token}`)

  // ── All accounts ──────────────────────────────────────────────

  console.log("")
  console.log("  ► All Accounts in Workspace")
  sep()

  const accounts = await getAllAccounts(WID)
  for (const acc of accounts) {
    const expStr = acc.expiresAt ? new Date(acc.expiresAt).toLocaleString("en-GB") : "—"
    console.log(`  ${acc.storeCode.padEnd(6)} connected=${acc.connected}  user=${acc.ebayUserId ?? "—"}  expires=${expStr}`)
  }

  // ── Final ─────────────────────────────────────────────────────

  console.log("")
  console.log("═".repeat(60))
  console.log("  eBay OAuth flow simulation tamamlandı")
  console.log("  Gerçek flow için .env'e ekle:")
  console.log("    EBAY_CLIENT_ID=...")
  console.log("    EBAY_CLIENT_SECRET=...")
  console.log("    EBAY_REDIRECT_URI=...")
  console.log("    EBAY_SIMULATION=false")
  console.log("    EBAY_SANDBOX=true  (önce sandbox test)")
  console.log("═".repeat(60))
}

main()
  .catch((e: unknown) => { console.error("[HATA]", e instanceof Error ? e.message : e); process.exit(1) })
  .finally(async () => { await closeDbPool() })

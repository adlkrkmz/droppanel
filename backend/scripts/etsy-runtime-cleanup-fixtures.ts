import assert from "assert"
import fs from "fs"
import path from "path"

const root = path.join(__dirname, "..")
const read = (...parts: string[]) => fs.readFileSync(path.join(root, ...parts), "utf8")
const exists = (...parts: string[]) => fs.existsSync(path.join(root, ...parts))

const http = read("modules", "http", "httpServer.ts")
assert(!http.includes("/api/etsy/"))
assert(!http.includes('from "../etsy'))
assert(http.includes("registerAuthRoutes(app)"))
assert(http.includes("registerAppRoutes(app)"))
assert(http.includes("/admin/ebay/callback"))
console.log("PASS Etsy API registration absent; auth/app/eBay routes retained")

for (const file of [
  ["panel", "src", "app", "dashboard", "etsy", "page.tsx"],
  ["panel", "src", "components", "layout", "EtsySidebar.tsx"],
  ["panel", "src", "components", "settings", "EtsyConnectSection.tsx"],
]) assert(!exists(...file))
console.log("PASS Etsy frontend navigation and routes absent")

const routing = read("panel", "src", "lib", "productAccess", "routing.ts")
const register = read("panel", "src", "app", "(public)", "register", "page.tsx")
assert(!routing.includes("dashboard/etsy"))
assert(register.includes('product: "EBAY"'))
assert(!register.toLowerCase().includes("etsy"))
console.log("PASS eBay-only onboarding contract")
for (const directory of ["etsyOAuth", "etsyListings", "etsyOrders", "etsyPanelDrafts"]) {
  const target = path.join(root, "modules", directory)
  assert(!fs.existsSync(target) || fs.readdirSync(target).length === 0)
}
const mcp = read("modules", "chatgptApp", "mcpServer.ts")
assert(!mcp.toLowerCase().includes("etsy"))
assert(exists("migrations", "019_etsy_accounts.sql"))
assert(exists("migrations", "046_etsy_listing_sources.sql"))
assert(exists("migrations", "047_etsy_order_item_operations.sql"))
assert(exists("migrations", "048_etsy_receipt_shipment_submissions.sql"))
assert(exists("migrations", "050_etsy_panel_drafts.sql"))
console.log("PASS Etsy backend and ChatGPT runtime absent; historical migrations retained")

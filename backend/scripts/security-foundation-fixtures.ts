import assert from "assert"
import fs from "fs"
import path from "path"
import {
  signLegacyAdminOAuthState, signOAuthStateForTest, verifyUserOAuthState,
} from "../modules/ebayOAuth/ebayOAuthState"
import {
  configuredBrowserOrigins, createRateLimiter, csrfProtection, isAllowedBrowserOrigin,
  isLoopbackAddress, publicInternalError, resetRateLimitBucketsForTests,
} from "../modules/security/httpSecurity"

process.env.AUTH_JWT_SECRET ||= "security-fixture-secret-at-least-32-bytes"
process.env.EBAY_OAUTH_STATE_SECRET ||= "oauth-fixture-secret-at-least-32-bytes"

function rejects(fn: () => unknown): void { assert.throws(fn) }
const valid = signLegacyAdminOAuthState({ workspaceId: "ws-a", storeCode: "store-a" })
assert.equal(verifyUserOAuthState(valid).flow, "legacy_admin")
const expired = signOAuthStateForTest({ userId: "legacy-admin", workspaceId: "ws-a", storeCode: "store-a", flow: "legacy_admin", createdAt: Date.now() - 16 * 60_000 })
rejects(() => verifyUserOAuthState(expired))
rejects(() => verifyUserOAuthState(""))
rejects(() => verifyUserOAuthState("malformed"))
const [body, sig] = valid.split(".")
const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"))
for (const change of [{ workspaceId: "ws-b" }, { storeCode: "store-b" }]) {
  const tampered = Buffer.from(JSON.stringify({ ...payload, ...change })).toString("base64url") + "." + sig
  rejects(() => verifyUserOAuthState(tampered))
}
rejects(() => verifyUserOAuthState(`${body}.${sig.slice(0, -1)}x`))
console.log("PASS OAuth security tests")

assert(isLoopbackAddress("127.0.0.1")); assert(isLoopbackAddress("::1")); assert(!isLoopbackAddress("203.0.113.1"))
const authMiddleware = fs.readFileSync(path.join(__dirname, "../modules/auth/authMiddleware.ts"), "utf8")
const httpServer = fs.readFileSync(path.join(__dirname, "../modules/http/httpServer.ts"), "utf8")
assert.match(authMiddleware, /ctx\.user\.role !== "admin"/)
assert.match(authMiddleware, /approvalStatus !== "active"/)
assert.match(httpServer, /requireLegacyAdminAccess/)
assert.match(httpServer, /ADMIN_INTERNAL_API_KEY|requireLegacyAdminAccess/)
console.log("PASS Admin auth tests (mocked/static, no DB)")

function mockReq(overrides: Record<string, unknown> = {}): any {
  return { method: "POST", headers: {}, cookies: {}, body: {}, ip: "203.0.113.2", socket: { remoteAddress: "203.0.113.2" }, ...overrides }
}
function mockRes(): any {
  return { code: 200, body: null, headers: {} as Record<string,string>, status(n: number) { this.code=n; return this }, json(v: unknown) { this.body=v; return this }, setHeader(k:string,v:string){this.headers[k]=v} }
}
process.env.NODE_ENV = "production"
let next = 0, res = mockRes()
csrfProtection(mockReq({ cookies: { listjetgo_session: "x" }, headers: { origin: "https://evil.example" } }), res, () => { next++ })
assert.equal(res.code, 403); assert.equal(next, 0)
res = mockRes(); csrfProtection(mockReq({ cookies: { listjetgo_session: "x" }, headers: { origin: "https://panel.listjetgo.com" } }), res, () => { next++ })
assert.equal(next, 1); assert(!configuredBrowserOrigins().has("http://localhost:3000"))
assert(!isAllowedBrowserOrigin("chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef"))
process.env.CHROME_EXTENSION_IDS = "cfjinofglmlecbhocckbbfeagppnlbpf"
assert(isAllowedBrowserOrigin("chrome-extension://cfjinofglmlecbhocckbbfeagppnlbpf"))
assert(!isAllowedBrowserOrigin("chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef"))
delete process.env.CHROME_EXTENSION_IDS
process.env.NODE_ENV = "development"
assert(isAllowedBrowserOrigin("chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef"))
assert(isAllowedBrowserOrigin("http://localhost:3000"))
next = 0; res = mockRes()
csrfProtection(mockReq({ cookies: { listjetgo_session: "x" }, headers: { origin: "chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef" } }), res, () => { next++ })
assert.equal(next, 1)
process.env.NODE_ENV = "production"
console.log("PASS CSRF tests")

resetRateLimitBucketsForTests(); const limiter = createRateLimiter({ windowMs: 60_000, max: 2, includeEmail: true })
for (let i=0;i<2;i++) limiter(mockReq({ body:{email:"USER@EXAMPLE.COM"} }), mockRes(), () => {})
res=mockRes(); limiter(mockReq({ body:{email:"user@example.com"} }), res, () => {}); assert.equal(res.code,429)
console.log("PASS Rate-limit tests")

assert.deepEqual(publicInternalError(), { error: "INTERNAL_ERROR", message: "An internal error occurred" })
assert(!JSON.stringify(publicInternalError()).match(/sql|token|secret|path/i))
console.log("PASS Error sanitization tests")

const ownership = fs.readFileSync(path.join(__dirname, "../modules/app/appOwnership.ts"), "utf8")
const orders = fs.readFileSync(path.join(__dirname, "../modules/orders/ordersRepository.ts"), "utf8")
assert.match(ownership, /scs\.workspace_id = \$2::uuid/)
assert.match(ownership, /FROM stores[\s\S]*workspace_id = \$1::uuid/)
assert.match(orders, /WHERE o\.workspace_id = \$1::uuid AND o\.id = \$2/)
assert.match(httpServer, /requireLegacyAdminAccess/)
console.log("PASS Tenant isolation tests (repository contract, no production DB)")

const panelRoot = path.join(__dirname, "../panel/src")
const forbidden = /EBAY_CLIENT_SECRET|AUTH_JWT_SECRET|TOKEN_ENCRYPTION_KEY|DATABASE_URL|R2_SECRET_ACCESS_KEY|AWS_SECRET_ACCESS_KEY|OPENAI_API_KEY|GEMINI_API_KEY/
const walk = (dir:string): string[] => fs.readdirSync(dir,{withFileTypes:true}).flatMap(e => e.isDirectory()?walk(path.join(dir,e.name)):[path.join(dir,e.name)])
const leaks = walk(panelRoot).filter(f => /\.(ts|tsx|js|mjs)$/.test(f)).filter(f => forbidden.test(fs.readFileSync(f,"utf8")))
assert.deepEqual(leaks.map(f => path.relative(panelRoot,f)), [path.join("app","api","auth","login","route.ts"), path.join("app","api","admin","users","pending","route.ts"), path.join("app","api","admin","users","[userId]","[action]","route.ts")].filter(expected => leaks.some(f => path.relative(panelRoot,f)===expected)))
for (const file of leaks) assert(file.includes(`${path.sep}app${path.sep}api${path.sep}`), `client secret reference: ${file}`)
console.log("PASS Secret exposure check")

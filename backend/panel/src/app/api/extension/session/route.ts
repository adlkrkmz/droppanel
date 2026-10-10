import { NextRequest, NextResponse } from "next/server"
import crypto from "crypto"
import { panelApiBase, USER_SESSION_COOKIE } from "@/lib/panelAuthServer"

const EXTENSION_ID = "ncegpfpjfgemblbcpnbobeaobkannlfk"
const TTL = 20 * 60
function secret(): string { const s = process.env.EXTENSION_TOKEN_SECRET?.trim(); if (!s || s.length < 32) throw new Error("EXTENSION_TOKEN_SECRET is not configured"); return s }
function b64(v: string | Buffer): string { return Buffer.from(v).toString("base64url") }
function isLocalPanelHost(request: NextRequest): boolean {
  const host = (request.headers.get("host") ?? "").split(":")[0].toLowerCase()
  return host === "localhost" || host === "127.0.0.1"
}
function mintToken(userId: string): { accessToken: string; expiresAt: string } {
  const now = Math.floor(Date.now() / 1000)
  const payload = { sub: userId, iss: "listjetgo", aud: "listjetgo-extension", purpose: "extension_access", ext: EXTENSION_ID, iat: now, exp: now + TTL }
  const header = b64(JSON.stringify({ alg: "HS256", typ: "JWT" })); const body = b64(JSON.stringify(payload)); const input = `${header}.${body}`
  const token = `${input}.${b64(crypto.createHmac("sha256", secret()).update(input).digest())}`
  return { accessToken: token, expiresAt: new Date((now + TTL) * 1000).toISOString() }
}
export async function POST(request: NextRequest) {
  try {
    if (isLocalPanelHost(request) && request.cookies.get("admin_session")?.value === "authenticated") {
      const localUserId = process.env.LOCAL_EXTENSION_TEST_USER_ID?.trim()
      if (localUserId) {
        const minted = mintToken(localUserId)
        return NextResponse.json({ accessToken: minted.accessToken, expiresAt: minted.expiresAt })
      }
    }
    const session = request.cookies.get(USER_SESSION_COOKIE)?.value
    if (!session) return NextResponse.json({ ok: false, error: "Authentication required" }, { status: 401 })
    const cookie = `${USER_SESSION_COOKIE}=${encodeURIComponent(session)}`
    const me = await fetch(`${panelApiBase()}/auth/me`, { headers: { cookie }, cache: "no-store" })
    if (!me.ok) return NextResponse.json({ ok: false, error: "Authentication required" }, { status: 401 })
    const data = await me.json() as { user?: { id?: string; approvalStatus?: string } }
    if (!data.user?.id || data.user.approvalStatus !== "active") return NextResponse.json({ ok: false, error: "Account is not active" }, { status: 403 })
    const minted = mintToken(data.user.id)
    return NextResponse.json({ accessToken: minted.accessToken, expiresAt: minted.expiresAt })
  } catch (e) { console.error("[ExtensionSession]", e); return NextResponse.json({ ok: false, error: "Extension authentication unavailable" }, { status: 503 }) }
}

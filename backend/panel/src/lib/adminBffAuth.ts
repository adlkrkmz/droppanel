import { NextRequest, NextResponse } from "next/server"
import { USER_SESSION_COOKIE, panelApiBase } from "@/lib/panelAuthServer"

export type AppAdminUser = {
  id: string
  email: string
  role: string
  approvalStatus: string
}

/**
 * Browser admin BFF gate: listjetgo_session + active admin role.
 * Does NOT use admin_session or expose ADMIN_INTERNAL_API_KEY to the client.
 *
 * After the browser admin is verified, the server-to-server hop to the API may
 * use ADMIN_INTERNAL_API_KEY (panel server env only) so CSRF trusts the BFF as
 * an internal caller. Browser Origin is also forwarded when present.
 */
export async function assertAppAdmin(
  request: NextRequest
): Promise<{ ok: true; cookieHeader: string; user: AppAdminUser } | { ok: false; response: NextResponse }> {
  const token = request.cookies.get(USER_SESSION_COOKIE)?.value?.trim()
  if (!token) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Unauthorized", message: "Authentication required" }, { status: 401 }),
    }
  }

  const cookieHeader = `${USER_SESSION_COOKIE}=${token}`
  const meRes = await fetch(`${panelApiBase()}/auth/me`, {
    headers: { Cookie: cookieHeader, Accept: "application/json" },
    cache: "no-store",
  })

  if (!meRes.ok) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Unauthorized", message: "Authentication required" }, { status: 401 }),
    }
  }

  const data = (await meRes.json().catch(() => ({}))) as { user?: AppAdminUser }
  const user = data.user
  if (!user || user.role !== "admin" || user.approvalStatus !== "active") {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Forbidden", message: "Admin role required" },
        { status: 403 }
      ),
    }
  }

  return { ok: true, cookieHeader, user }
}

export async function appAdminBackendFetch(
  request: NextRequest,
  path: string,
  init?: RequestInit
): Promise<NextResponse> {
  const gate = await assertAppAdmin(request)
  if (!gate.ok) return gate.response

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Cookie: gate.cookieHeader,
    ...(init?.headers as Record<string, string> | undefined),
  }

  // Server-only internal hop (never sent to the browser). Marks this as a
  // trusted BFF→API call after listjetgo_session + admin role were verified.
  const internalKey = process.env.ADMIN_INTERNAL_API_KEY?.trim()
  if (internalKey) {
    headers["X-Admin-Internal-Key"] = internalKey
  }

  // Preserve canonical browser Origin when the client sent one (e.g. https://app.listjetgo.com)
  const browserOrigin = request.headers.get("origin")?.trim()
  if (browserOrigin) {
    headers["Origin"] = browserOrigin
  }

  const res = await fetch(`${panelApiBase()}${path}`, {
    ...init,
    headers,
    cache: "no-store",
  })

  const text = await res.text()
  return new NextResponse(text, {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  })
}

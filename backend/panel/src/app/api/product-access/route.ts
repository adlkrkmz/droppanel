import { NextRequest, NextResponse } from "next/server"
import { USER_SESSION_COOKIE, panelApiBase } from "@/lib/panelAuthServer"
import { resolveMockProductAccess } from "@/lib/productAccess/resolve"
import type { ProductAccessRecord } from "@/lib/productAccess/types"

function mapDbAccess(rows: { product: string; status: string }[]): ProductAccessRecord[] {
  return rows
    .filter(
      (row) =>
        row.product === "EBAY" &&
        (row.status === "ACTIVE" || row.status === "TRIAL")
    )
    .map((row) => ({
      product: row.product as ProductAccessRecord["product"],
      status: row.status as ProductAccessRecord["status"],
    }))
}

export async function GET(request: NextRequest) {
  const adminSession = request.cookies.get("admin_session")
  if (adminSession?.value) {
    const snapshot = resolveMockProductAccess()
    return NextResponse.json({ ok: true, ...snapshot })
  }

  const userToken = request.cookies.get(USER_SESSION_COOKIE)?.value
  if (!userToken) {
    return NextResponse.json({ ok: false, error: "Not authenticated" }, { status: 401 })
  }

  try {
    const res = await fetch(`${panelApiBase()}/auth/product-access`, {
      headers: { Cookie: `${USER_SESSION_COOKIE}=${encodeURIComponent(userToken)}` },
      cache: "no-store",
    })
    if (!res.ok) {
      return NextResponse.json({ ok: false, error: "Not authenticated" }, { status: 401 })
    }
    const data = (await res.json()) as {
      source?: string
      userId?: string | null
      access?: { product: string; status: string }[]
    }
    return NextResponse.json({
      ok: true,
      source: data.source ?? "db",
      userId: data.userId ?? null,
      access: mapDbAccess(Array.isArray(data.access) ? data.access : []),
    })
  } catch (e) {
    console.error("[ProductAccess] backend fetch failed:", e)
    return NextResponse.json({ ok: false, error: "Product access unavailable" }, { status: 503 })
  }
}

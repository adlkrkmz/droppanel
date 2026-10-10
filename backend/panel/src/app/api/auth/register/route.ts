import { NextRequest, NextResponse } from "next/server"
import { panelApiBase } from "@/lib/panelAuthServer"

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const email = String(body?.email ?? "").trim()
    const password = String(body?.password ?? "")
    const name = body?.name ? String(body.name).trim() : undefined
    const product = body?.product ? String(body.product).trim() : undefined

    if (!email || !password) {
      return NextResponse.json({ error: "Email and password are required" }, { status: 400 })
    }

    const res = await fetch(`${panelApiBase()}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, name, product }),
      cache: "no-store",
    })

    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      return NextResponse.json(
        { ok: false, error: data.error || `Registration failed (HTTP ${res.status})` },
        { status: res.status }
      )
    }

    console.log(`[Auth] register success email=${email.toLowerCase()} status=${data.status ?? "unknown"}`)
    return NextResponse.json({ ok: true, ...data }, { status: 201 })
  } catch (e) {
    console.error("[Auth] register handler error:", e)
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
  }
}

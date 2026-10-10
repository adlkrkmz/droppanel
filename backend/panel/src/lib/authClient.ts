/**
 * Panel auth — Next.js route handlers at /api/auth/* (not Express backend for login).
 */

export function getAuthLoginUrl(): string {
  if (typeof window !== "undefined") {
    return new URL("/api/auth/login", window.location.origin).href
  }
  return "/api/auth/login"
}

export function getAuthRegisterUrl(): string {
  if (typeof window !== "undefined") {
    return new URL("/api/auth/register", window.location.origin).href
  }
  return "/api/auth/register"
}

export type LoginResult =
  | { ok: true; kind?: "admin" | "user" }
  | { ok: false; message: string; status?: number; blocked?: boolean }

export type RegisterResult =
  | { ok: true; status?: string; message?: string }
  | { ok: false; message: string; status?: number }

export async function postPanelLogin(
  username: string,
  password: string
): Promise<LoginResult> {
  const url = getAuthLoginUrl()

  let res: Response
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
      credentials: "same-origin",
    })
  } catch (e) {
    console.error("[Login] fetch failed:", e)
    return {
      ok: false,
      message: "Backend connection failed",
    }
  }

  let data: {
    error?: string
    ok?: boolean
    blocked?: boolean
    message?: string
    status?: string
    kind?: string
  } = {}
  const text = await res.text().catch(() => "")
  if (text) {
    try {
      data = JSON.parse(text) as typeof data
    } catch {
      console.error("[Login] non-JSON response:", res.status, text.slice(0, 200))
      return {
        ok: false,
        status: res.status,
        message:
          res.status === 404
            ? "Login route not found — restart panel dev server (npm run dev)"
            : `Server error (HTTP ${res.status})`,
      }
    }
  }

  if (res.ok) {
    return { ok: true, kind: data.kind === "user" ? "user" : "admin" }
  }

  if (res.status === 403 && data.blocked) {
    return {
      ok: false,
      blocked: true,
      status: 403,
      message: data.message || "Your account is waiting for admin approval.",
    }
  }

  if (res.status === 401) {
    return { ok: false, status: 401, message: "Invalid email or password" }
  }
  if (res.status === 500) {
    return {
      ok: false,
      status: 500,
      message: data.error || "Server error",
    }
  }

  return {
    ok: false,
    status: res.status,
    message: data.error || data.message || `Login failed (HTTP ${res.status})`,
  }
}

export async function postPanelRegister(input: {
  email: string
  password: string
  name?: string
  product?: string
}): Promise<RegisterResult> {
  const url = getAuthRegisterUrl()

  let res: Response
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      credentials: "same-origin",
    })
  } catch (e) {
    console.error("[Register] fetch failed:", e)
    return { ok: false, message: "Backend connection failed" }
  }

  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      message: data.error || `Registration failed (HTTP ${res.status})`,
    }
  }
  return { ok: true, status: data.status, message: data.message }
}

import { getBackendApiBase } from "./api"

export type UserPublic = {
  id: string
  email: string
  role: string
  approvalStatus: string
  emailVerifiedAt: string | null
  workspaceId: string | null
  needsPasswordSetup?: boolean
}

export async function postRegister(email: string, password: string) {
  const res = await fetch(`${getBackendApiBase()}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ email, password }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data as { ok: boolean; status: string; message: string }
}

export async function verifyEmailToken(token: string) {
  const res = await fetch(
    `${getBackendApiBase()}/auth/verify-email?token=${encodeURIComponent(token)}`,
    { cache: "no-store" }
  )
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data as { ok: boolean; status: string }
}

export async function postUserLogin(email: string, password: string) {
  const res = await fetch(`${getBackendApiBase()}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ email, password }),
  })
  const data = await res.json().catch(() => ({}))
  if (res.status === 403 && data.status) {
    return { ok: false as const, blocked: true as const, status: data.status as string, message: data.message as string }
  }
  if (!res.ok) throw new Error(data.error || data.message || `HTTP ${res.status}`)
  return { ok: true as const, blocked: false as const, user: data.user as UserPublic }
}

export async function fetchAuthMe(): Promise<UserPublic | null> {
  const res = await fetch(`${getBackendApiBase()}/auth/me`, {
    credentials: "include",
    cache: "no-store",
  })
  if (!res.ok) {
    return null
  }
  const data = await res.json()
  return data.user as UserPublic
}

export async function postUserLogout() {
  try {
    await fetch(`${getBackendApiBase()}/auth/logout`, {
      method: "POST",
      credentials: "include",
    })
  } catch {
    /* ignore */
  }
}

export type SessionPublic = { sessionId:string;createdAt:string;lastSeenAt:string;expiresAt:string;ipAddress:string|null;userAgent:string|null;isCurrent:boolean }
export async function fetchGoogleConfig():Promise<{clientId:string;nonce:string}|null>{const r=await fetch(`${getBackendApiBase()}/auth/google/config`,{credentials:"include",cache:"no-store"});if(r.status===404)return null;if(!r.ok)throw new Error("Google sign-in unavailable");return r.json()}
export async function postGoogleCredential(credential:string){const r=await fetch(`${getBackendApiBase()}/auth/google/credential`,{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},body:JSON.stringify({credential})});const data=await r.json().catch(()=>({}));if(r.status===403&&data.status)return{ok:false as const,blocked:true as const,status:data.status as string,message:data.message as string};if(!r.ok)throw new Error(data.error||data.message||"Google sign-in failed");return{ok:true as const,blocked:false as const,user:data.user as UserPublic}}
export async function postSetPassword(password: string, confirmPassword: string) {
  const r = await fetch(`${getBackendApiBase()}/auth/password/set`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password, confirmPassword }),
  })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(data.error || data.message || "Could not set password")
  return data as { ok: boolean; user: UserPublic }
}

export async function postChangePassword(
  currentPassword: string,
  newPassword: string,
  confirmPassword: string
) {
  const r = await fetch(`${getBackendApiBase()}/auth/password/change`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ currentPassword, newPassword, confirmPassword }),
  })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(data.error || data.message || "Could not change password")
  return data as { ok: boolean; user: UserPublic }
}

export async function postForgotPassword(email: string) {
  const r = await fetch(`${getBackendApiBase()}/auth/password/forgot`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(data.error || data.message || "Could not start password reset")
  return data as { ok: boolean; message: string }
}

export async function postResetPassword(
  token: string,
  password: string,
  confirmPassword: string
) {
  const r = await fetch(`${getBackendApiBase()}/auth/password/reset`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, password, confirmPassword }),
  })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(data.error || data.message || "Could not reset password")
  return data as { ok: boolean; message: string }
}

export async function fetchLoginMethods(){const r=await fetch(`${getBackendApiBase()}/auth/login-methods`,{credentials:"include",cache:"no-store"});if(!r.ok)throw new Error(`HTTP ${r.status}`);return r.json() as Promise<{password:{connected:boolean};google:{available:boolean;connected:boolean;email:string|null};needsPasswordSetup?:boolean}>} 
export async function fetchSessions(): Promise<SessionPublic[]> {
  const res=await fetch(`${getBackendApiBase()}/auth/sessions`,{credentials:"include",cache:"no-store"}); if(!res.ok) throw new Error(`HTTP ${res.status}`); return (await res.json()).sessions
}
export async function revokeSession(sessionId:string): Promise<void> {
  const res=await fetch(`${getBackendApiBase()}/auth/sessions/${encodeURIComponent(sessionId)}`,{method:"DELETE",credentials:"include"}); if(!res.ok) throw new Error(`HTTP ${res.status}`)
}
export async function logoutAllSessions(): Promise<void> {
  const res=await fetch(`${getBackendApiBase()}/auth/logout-all`,{method:"POST",credentials:"include"}); if(!res.ok) throw new Error(`HTTP ${res.status}`)
}

export async function logoutUser(): Promise<void> {
  await postUserLogout()
  window.location.href = "/login"
}

import { getBackendApiBase } from "@/lib/api"

/**
 * Canonical /app/admin browser → API calls.
 * Uses listjetgo_session on api.listjetgo.com (credentials: include).
 * Do not use panel-host cookies or admin_session here.
 */
export async function adminApiFetch(
  path: string,
  init?: RequestInit
): Promise<Response> {
  const headers = new Headers(init?.headers)
  if (!headers.has("Content-Type") && init?.body != null) {
    headers.set("Content-Type", "application/json")
  }
  headers.set("Accept", "application/json")

  return fetch(`${getBackendApiBase()}${path}`, {
    cache: "no-store",
    credentials: "include",
    ...init,
    headers,
  })
}

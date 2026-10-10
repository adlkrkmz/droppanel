"use client"

import { useCallback, useEffect, useState } from "react"
import { adminApiFetch } from "@/lib/adminApiClient"

type PendingRow = {
  id: string
  email: string
  approvalStatus: string
  emailVerifiedAt: string | null
  displayName: string | null
  requestedProduct: "EBAY" | null
  createdAt: string
  workspaceId: string | null
  workspaceName: string | null
}

function productLabel(product: PendingRow["requestedProduct"]): string {
  if (product === "EBAY") return "eBay"
  return "—"
}

export default function AdminPendingUsersPage() {
  const [rows, setRows] = useState<PendingRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [acting, setActing] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError("")
    try {
      const res = await adminApiFetch("/admin/users/pending")
      if (!res.ok) {
        const t = await res.text()
        throw new Error(t || `HTTP ${res.status}`)
      }
      const data = (await res.json()) as { rows?: PendingRow[] }
      setRows(Array.isArray(data.rows) ? data.rows : [])
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load")
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function act(userId: string, action: "approve" | "reject" | "suspend") {
    setActing(userId)
    try {
      const res = await adminApiFetch(`/admin/users/${encodeURIComponent(userId)}/${action}`, {
        method: "POST",
      })
      if (!res.ok) {
        const t = await res.text()
        throw new Error(t || `HTTP ${res.status}`)
      }
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed")
    } finally {
      setActing(null)
    }
  }

  return (
    <div>
      <h1 className="text-xl font-display font-bold mb-2" style={{ fontFamily: "'Syne', sans-serif" }}>
        Pending users
      </h1>
      <p className="text-sm font-mono mb-6" style={{ color: "var(--dim)" }}>
        New registrations awaiting admin approval.
      </p>
      {error && (
        <p className="text-sm mb-4" style={{ color: "#f87171" }}>
          {error}
        </p>
      )}
      {loading ? (
        <p style={{ color: "var(--dim)" }}>Loading…</p>
      ) : rows.length === 0 ? (
        <p style={{ color: "var(--dim)" }}>No pending users.</p>
      ) : (
        <div className="overflow-x-auto rounded border" style={{ borderColor: "var(--border)" }}>
          <table className="w-full text-sm font-mono">
            <thead>
              <tr style={{ background: "var(--surface)", borderBottom: "1px solid var(--border)" }}>
                <th className="text-left p-3">Email</th>
                <th className="text-left p-3">Name</th>
                <th className="text-left p-3">Product</th>
                <th className="text-left p-3">Created</th>
                <th className="text-right p-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td className="p-3">{r.email}</td>
                  <td className="p-3">{r.displayName ?? "—"}</td>
                  <td className="p-3">{productLabel(r.requestedProduct)}</td>
                  <td className="p-3">{new Date(r.createdAt).toLocaleString()}</td>
                  <td className="p-3 text-right space-x-2">
                    <button
                      type="button"
                      disabled={acting === r.id}
                      onClick={() => void act(r.id, "approve")}
                      className="px-2 py-1 rounded text-xs"
                      style={{ background: "var(--accent)", color: "#000" }}
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      disabled={acting === r.id}
                      onClick={() => void act(r.id, "reject")}
                      className="px-2 py-1 rounded text-xs border"
                      style={{ borderColor: "var(--border)" }}
                    >
                      Reject
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

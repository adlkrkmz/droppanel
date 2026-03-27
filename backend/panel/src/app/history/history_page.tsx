"use client"

import { useState, useEffect } from "react"
import { getHistory }          from "@/lib/api"
import type { ListingHistoryRow } from "@/lib/api"
import DataTable               from "@/components/ui/DataTable"
import Badge                   from "@/components/ui/Badge"

function fmt(iso: string | null): string {
  if (!iso) return "—"
  return new Date(iso).toLocaleString("en-GB", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false,
  })
}

const columns = [
  { key: "id",          label: "ID",          mono: true,  width: "60px"  },
  { key: "asin",        label: "ASIN",         mono: true,  width: "130px" },
  { key: "internalSku", label: "SKU",          mono: true,  width: "200px" },
  { key: "ebayItemId",  label: "eBay Item ID", mono: true,  width: "160px" },
  { key: "storeName",   label: "Store",        mono: false, width: "120px" },
  {
    key: "status", label: "Status", width: "90px",
    render: (row: Record<string, unknown>) => (
      <Badge value={String(row.status ?? "")} />
    ),
  },
  {
    key: "listedAt", label: "Listed At", mono: true, width: "160px",
    render: (row: Record<string, unknown>) => (
      <span style={{ color: "var(--sub)", fontSize: "11px" }}>
        {fmt(row.listedAt as string | null)}
      </span>
    ),
  },
]

export default function HistoryPage() {
  const [rows,    setRows]    = useState<ListingHistoryRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)

  useEffect(() => {
    getHistory(50)
      .then(data => setRows(data.rows))
      .catch(err  => setError(err instanceof Error ? err.message : String(err)))
      .finally(()  => setLoading(false))
  }, [])

  const successCount = rows.filter(r => r.status === "success").length
  const failedCount  = rows.filter(r => r.status === "failed").length

  if (error) {
    return (
      <div
        className="max-w-xl p-5 rounded-sm text-sm font-mono"
        style={{ background: "rgba(255,68,85,0.06)", border: "1px solid rgba(255,68,85,0.2)", color: "var(--danger)" }}
      >
        <p className="font-bold mb-1">Connection Error</p>
        <p style={{ color: "var(--sub)" }}>{error}</p>
      </div>
    )
  }

  return (
    <div className="max-w-6xl animate-fade-in">
      {/* Summary strip */}
      <div className="flex items-center gap-6 mb-5">
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-mono font-bold" style={{ color: "var(--text)" }}>
            {loading ? "…" : rows.length}
          </span>
          <span className="text-xs font-mono uppercase tracking-widest" style={{ color: "var(--dim)" }}>
            entries
          </span>
        </div>
        <div className="w-px h-5" style={{ background: "var(--border)" }} />
        <div className="flex items-baseline gap-2">
          <span className="text-xl font-mono font-bold" style={{ color: "var(--accent)" }}>{successCount}</span>
          <span className="text-xs" style={{ color: "var(--dim)" }}>success</span>
        </div>
        <div className="flex items-baseline gap-2">
          <span className="text-xl font-mono font-bold" style={{ color: "var(--danger)" }}>{failedCount}</span>
          <span className="text-xs" style={{ color: "var(--dim)" }}>failed</span>
        </div>
      </div>

      {loading ? (
        <div style={{ color: "var(--dim)", fontFamily: "'JetBrains Mono', monospace", fontSize: "13px", padding: "32px 0" }}>
          Loading…
        </div>
      ) : (
        <DataTable
          columns={columns}
          rows={rows as unknown as Record<string, unknown>[]}
          emptyMsg="No listing history yet"
        />
      )}
    </div>
  )
}

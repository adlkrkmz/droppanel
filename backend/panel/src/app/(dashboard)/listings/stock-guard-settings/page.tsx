"use client"

import { useEffect, useState } from "react"
import { useStore } from "@/lib/storeContext"
import { getStores, getStockGuardSettings } from "@/lib/api"
import type { StoreRow } from "@/lib/api"

const mono: React.CSSProperties = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: "11px",
}

export default function StockGuardSettingsPage() {
  const { selectedStore, setSelectedStore, isStoreReady } = useStore()
  const [stores, setStores] = useState<StoreRow[]>([])
  const [status, setStatus] = useState<{ storeName: string; enabled: boolean } | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    void getStores()
      .then(d => setStores(d.rows ?? []))
      .catch(() => setStores([]))
  }, [])

  useEffect(() => {
    const active = stores.filter(s => s.status === "active")
    const list = active.length > 0 ? active : stores
    if (list.length > 0 && !list.some(s => s.storeCode === selectedStore)) {
      setSelectedStore(list[0]!.storeCode)
    }
  }, [stores, selectedStore, setSelectedStore])

  useEffect(() => {
    if (!isStoreReady || !selectedStore) return
    setLoading(true)
    void getStockGuardSettings(selectedStore)
      .then(s => setStatus({ storeName: s.storeName, enabled: s.enabled }))
      .catch(() => setStatus(null))
      .finally(() => setLoading(false))
  }, [isStoreReady, selectedStore])

  const storeOptions = stores.filter(s => s.status === "active").length
    ? stores.filter(s => s.status === "active")
    : stores

  return (
    <div style={{ maxWidth: 560, ...mono }}>
      <h1 style={{ fontSize: 14, fontWeight: 700, color: "var(--accent)", marginBottom: 8 }}>
        Stock Guard
      </h1>
      <p style={{ color: "var(--dim)", marginBottom: 20, lineHeight: 1.5 }}>
        Stock Guard is automatic for eligible listings on connected stores. Source verification,
        price protection, and confirmed stock protection run in the background.
      </p>

      <div
        style={{
          padding: "16px",
          border: "1px solid var(--border)",
          borderRadius: 4,
          background: "var(--surface)",
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ color: "var(--dim)", textTransform: "uppercase", fontSize: 10 }}>Store</span>
          <select
            value={selectedStore}
            onChange={e => setSelectedStore(e.target.value)}
            disabled={!isStoreReady || storeOptions.length === 0}
            style={{
              padding: "8px 10px",
              background: "var(--bg)",
              border: "1px solid var(--border)",
              color: "var(--text)",
              borderRadius: 3,
            }}
          >
            {storeOptions.map(s => (
              <option key={s.storeCode} value={s.storeCode}>
                {s.name?.trim() || s.storeCode}
              </option>
            ))}
          </select>
        </label>

        {loading ? (
          <div style={{ color: "var(--dim)" }}>Loading…</div>
        ) : (
          <div style={{ lineHeight: 1.6 }}>
            <div style={{ color: "var(--accent)", fontWeight: 700 }}>
              {status?.enabled === false ? "Automatic monitoring unavailable" : "Automatic monitoring active"}
            </div>
            <div style={{ color: "var(--dim)", marginTop: 6 }}>
              Eligible listings are enrolled automatically after store sync. To exclude one listing,
              use Listings → Disable Guard. Enable Guard restores that listing to the normal flow.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

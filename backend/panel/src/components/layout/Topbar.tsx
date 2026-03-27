"use client"

import { usePathname, useRouter } from "next/navigation"
import { useState, useEffect, type CSSProperties } from "react"
import { getStores } from "@/lib/api"
import type { StoreRow } from "@/lib/api"
import { useStore } from "@/lib/storeContext"

const TITLES: Record<string, { label: string; desc: string }> = {
  "/import":    { label: "Import",      desc: "Bulk ASIN import & duplicate protection"   },
  "/dashboard": { label: "Dashboard",  desc: "Pipeline overview & runtime status"        },
  "/queue":     { label: "Queue",       desc: "Pending scrape / AI / publish jobs"        },
  "/history":   { label: "History",     desc: "Recent eBay listing activity"              },
  "/stores":    { label: "Stores",      desc: "Connected eBay store accounts"             },
  "/monitor":   { label: "Monitor",     desc: "Live eBay listings — track margin & stock" },
  "/pool":      { label: "Pool",        desc: "ASIN pool — view, filter & dispatch"      },
  "/dispatch":  { label: "Dispatch",    desc: "Dispatch ASINs & run listing"        },
}

// Saat bileşeni — sadece client-side mount sonrası render edilir.
// SSR sırasında boş string döner → hydration uyuşmazlığı olmaz.
function LiveClock() {
  const [time,    setTime]    = useState<string>("")
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
    const fmt = () =>
      new Date().toLocaleTimeString("en-GB", { hour12: false })
    setTime(fmt())
    const id = setInterval(() => setTime(fmt()), 1000)
    return () => clearInterval(id)
  }, [])

  // Mounted olmadan hiçbir şey render etme — server ve ilk client render eşleşir
  if (!mounted) return null

  return (
    <span className="text-xs font-mono" style={{ color: "var(--dim)" }}>
      {time}
    </span>
  )
}

function LiveDot() {
  return (
    <span className="flex items-center gap-1.5">
      <span
        className="inline-block w-1.5 h-1.5 rounded-full"
        style={{ background: "var(--accent)", animation: "pulse-dot 1.4s ease infinite" }}
      />
      <span className="text-xs font-mono" style={{ color: "var(--accent)" }}>LIVE</span>
    </span>
  )
}

const storeSelectStyle: CSSProperties = {
  background:    "var(--surface)",
  border:        "1px solid var(--border)",
  color:         "var(--accent)",
  padding:       "4px 10px",
  borderRadius:  "3px",
  fontSize:      "11px",
  fontFamily:    "'JetBrains Mono', monospace",
  cursor:        "pointer",
  outline:       "none",
}

export default function Topbar() {
  const path = usePathname()
  const router = useRouter()
  const page = TITLES[path] ?? { label: "Panel", desc: "" }
  const { selectedStore, setSelectedStore } = useStore()
  const [stores, setStores] = useState<StoreRow[]>([])

  useEffect(() => {
    getStores()
      .then((d) => setStores(d.rows))
      .catch(() => setStores([]))
  }, [])

  useEffect(() => {
    const active = stores.filter((s) => s.status === "active")
    const list = active.length > 0 ? active : stores
    if (list.length === 0) return
    if (!list.some((s) => s.storeCode === selectedStore)) {
      setSelectedStore(list[0].storeCode)
    }
  }, [stores, selectedStore, setSelectedStore])

  const activeStores = stores.filter((s) => s.status === "active")
  const storeOptions = activeStores.length > 0 ? activeStores : stores
  const selectedOption = storeOptions.find((s) => s.storeCode === selectedStore)
  const selectedLabel = selectedOption ? `${selectedOption.name} (${selectedOption.storeCode})` : selectedStore

  return (
    <header
      className="fixed top-0 right-0 z-10 flex items-center justify-between px-6 py-0"
      style={{
        left:         "208px",
        height:       "56px",
        background:   "var(--bg)",
        borderBottom: "1px solid var(--border)",
      }}
    >
      {/* Left: Page title */}
      <div className="flex items-baseline gap-3">
        <h1
          className="text-base font-bold tracking-tight"
          style={{ fontFamily: "'Syne', sans-serif", color: "var(--text)" }}
        >
          {page.label}
        </h1>
        {page.desc && (
          <span className="text-xs hidden sm:inline" style={{ color: "var(--dim)" }}>
            — {page.desc}
          </span>
        )}
      </div>

      {/* Right: store + clock + live dot */}
      <div className="flex items-center gap-4">
        <button
          type="button"
          aria-label="Change store"
          onClick={() => router.push("/settings")}
          style={storeSelectStyle}
        >
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            {selectedLabel} <span style={{ color: "var(--dim)", fontSize: 10 }}>▾</span>
          </span>
        </button>
        <LiveClock />
        <LiveDot />
      </div>
    </header>
  )
}

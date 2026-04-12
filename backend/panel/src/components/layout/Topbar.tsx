"use client"

import { usePathname, useRouter } from "next/navigation"
import { useState, useEffect, useRef, useCallback, type CSSProperties } from "react"
import { getStores, getNotifications, markNotificationsRead, markAllNotificationsRead } from "@/lib/api"
import type { StoreRow, PersistedNotificationRow } from "@/lib/api"
import { useStore } from "@/lib/storeContext"

const TITLES: Record<string, { label: string; desc: string }> = {
  "/scan":      { label: "Scan",        desc: "Amazon search scan & ASIN discovery"      },
  "/pool":      { label: "Pool",        desc: "ASIN pool — view, filter & dispatch"      },
  "/monitor":   { label: "Monitor",     desc: "Live eBay listings — track margin & stock" },
  "/settings":  { label: "Settings",    desc: "Store settings & eBay configuration"      },
}

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

const POLL_MS = 15_000

function typeColor(t: string): string {
  switch (t) {
    case "success": return "var(--accent)"
    case "error":   return "var(--danger)"
    case "warning": return "#ffaa00"
    default:        return "var(--info)"
  }
}

export default function Topbar() {
  const path = usePathname()
  const router = useRouter()
  const page = TITLES[path] ?? { label: "Panel", desc: "" }
  const { selectedStore, setSelectedStore } = useStore()
  const [stores, setStores] = useState<StoreRow[]>([])
  const [notifOpen, setNotifOpen] = useState(false)
  const [persisted, setPersisted] = useState<PersistedNotificationRow[]>([])
  const notifWrapRef = useRef<HTMLDivElement | null>(null)

  const loadPersisted = useCallback(async () => {
    try {
      const { rows } = await getNotifications(50)
      setPersisted(rows ?? [])
    } catch {
      /* sessiz */
    }
  }, [])

  useEffect(() => {
    getStores()
      .then((d) => setStores(d.rows))
      .catch(() => setStores([]))
  }, [])

  useEffect(() => {
    void loadPersisted()
    const id = window.setInterval(() => void loadPersisted(), POLL_MS)
    return () => clearInterval(id)
  }, [loadPersisted])

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!notifOpen) return
      const el = notifWrapRef.current
      if (el && !el.contains(e.target as Node)) setNotifOpen(false)
    }
    document.addEventListener("mousedown", onDoc)
    return () => document.removeEventListener("mousedown", onDoc)
  }, [notifOpen])

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
  const selectedLabel = selectedOption
    ? (selectedOption.name?.trim() || selectedOption.storeCode)
    : selectedStore

  const unreadCount = persisted.filter((n) => !n.read).length

  const onMarkAllRead = async () => {
    try {
      await markAllNotificationsRead()
      await loadPersisted()
    } catch {
      /* */
    }
  }

  const onRowClick = async (row: PersistedNotificationRow) => {
    if (row.read) return
    try {
      await markNotificationsRead([row.id])
      setPersisted((prev) =>
        prev.map((n) => (n.id === row.id ? { ...n, read: true } : n))
      )
    } catch {
      /* */
    }
  }

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

        <div ref={notifWrapRef} style={{ position: "relative" }}>
          <button
            type="button"
            aria-label="Bildirimler"
            aria-expanded={notifOpen}
            onClick={() => {
              setNotifOpen((o) => !o)
              void loadPersisted()
            }}
            style={{
              position: "relative",
              background: "transparent",
              border: "1px solid var(--border)",
              borderRadius: "3px",
              padding: "4px 10px",
              cursor: "pointer",
              color: "var(--dim)",
              fontSize: "14px",
              lineHeight: 1,
            }}
          >
            🔔
            {unreadCount > 0 ? (
              <span
                style={{
                  position: "absolute",
                  top: -4,
                  right: -4,
                  minWidth: 18,
                  height: 18,
                  padding: "0 5px",
                  borderRadius: 9,
                  background: "var(--danger)",
                  color: "#fff",
                  fontSize: 10,
                  fontWeight: 800,
                  fontFamily: "'JetBrains Mono', monospace",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {unreadCount > 99 ? "99+" : unreadCount}
              </span>
            ) : null}
          </button>

          {notifOpen ? (
            <div
              style={{
                position: "absolute",
                right: 0,
                top: "calc(100% + 8px)",
                width: 360,
                maxHeight: 400,
                overflow: "hidden",
                display: "flex",
                flexDirection: "column",
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: 4,
                boxShadow: "0 12px 40px rgba(0,0,0,0.45)",
                zIndex: 200,
              }}
            >
              <div
                style={{
                  padding: "10px 12px",
                  borderBottom: "1px solid var(--border)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                }}
              >
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 800,
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                    color: "var(--dim)",
                    fontFamily: "'JetBrains Mono', monospace",
                  }}
                >
                  Bildirimler
                </span>
                <button
                  type="button"
                  onClick={() => void onMarkAllRead()}
                  style={{
                    fontSize: 10,
                    fontFamily: "'JetBrains Mono', monospace",
                    color: "var(--accent)",
                    background: "transparent",
                    border: "1px solid rgba(0,255,136,0.35)",
                    borderRadius: 3,
                    padding: "4px 8px",
                    cursor: "pointer",
                    fontWeight: 700,
                  }}
                >
                  Tümünü Okundu İşaretle
                </button>
              </div>
              <div style={{ overflowY: "auto", maxHeight: 320 }}>
                {persisted.length === 0 ? (
                  <div
                    style={{
                      padding: 20,
                      textAlign: "center",
                      color: "var(--dim)",
                      fontSize: 12,
                      fontFamily: "'JetBrains Mono', monospace",
                    }}
                  >
                    Son 24 saatte bildirim yok
                  </div>
                ) : (
                  persisted.map((n) => (
                    <button
                      key={n.id}
                      type="button"
                      onClick={() => void onRowClick(n)}
                      style={{
                        width: "100%",
                        textAlign: "left",
                        padding: "10px 12px",
                        border: "none",
                        borderBottom: "1px solid var(--border)",
                        background: n.read ? "transparent" : "rgba(0,255,136,0.04)",
                        cursor: n.read ? "default" : "pointer",
                        display: "block",
                      }}
                    >
                      <div
                        style={{
                          fontSize: 10,
                          fontWeight: 700,
                          textTransform: "uppercase",
                          color: typeColor(n.type),
                          fontFamily: "'JetBrains Mono', monospace",
                          marginBottom: 4,
                        }}
                      >
                        {n.type}
                      </div>
                      <div
                        style={{
                          fontSize: 12,
                          fontWeight: 700,
                          color: "var(--text)",
                          fontFamily: "'JetBrains Mono', monospace",
                          marginBottom: n.message ? 4 : 0,
                        }}
                      >
                        {n.title}
                      </div>
                      {n.message ? (
                        <div
                          style={{
                            fontSize: 11,
                            color: "var(--sub)",
                            lineHeight: 1.45,
                            wordBreak: "break-word",
                            fontFamily: "'JetBrains Mono', monospace",
                          }}
                        >
                          {n.message}
                        </div>
                      ) : null}
                      <div style={{ fontSize: 9, color: "var(--dim)", marginTop: 6 }}>
                        {n.createdAt ? n.createdAt.slice(0, 19).replace("T", " ") : ""}
                      </div>
                    </button>
                  ))
                )}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </header>
  )
}

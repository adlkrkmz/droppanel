"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import { deletePoolItems, getPool, getStores } from "@/lib/api"
import type { PoolRow, PoolResult, StoreRow } from "@/lib/api"
import { useStore } from "@/lib/storeContext"
import { useToast } from "@/lib/toastContext"
import { addNotification } from "@/lib/notifications"

const STAGES   = ["all", "validated", "scraped", "ai_generated", "listed"]
const STATUSES = ["all", "ready", "completed"]

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:4000"

function stageColor(s: string): string {
  switch (s) {
    case "validated":    return "var(--info)"
    case "scraped":      return "var(--warn)"
    case "ai_generated": return "var(--accent)"
    case "listed":       return "#b4ff6a"
    default:             return "var(--dim)"
  }
}

function statusColor(s: string): string {
  if (s === "success" || s === "ready")     return "var(--accent)"
  if (s === "failed"  || s === "error")     return "var(--danger)"
  if (s === "pending" || s === "completed") return "var(--sub)"
  return "var(--dim)"
}

function Dot({ color }: { color: string }) {
  return <span style={{ display: "inline-block", width: 7, height: 7, borderRadius: "50%", background: color, flexShrink: 0 }} />
}

function Badge({ value, color }: { value: string; color: string }) {
  return (
    <span style={{ padding: "1px 7px", borderRadius: "20px", fontSize: "10px", fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", textTransform: "uppercase", background: color + "22", color }}>
      {value}
    </span>
  )
}

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ padding: "12px 16px", background: "var(--surface)", border: "1px solid var(--border)", borderTop: `2px solid ${color}`, borderRadius: "3px" }}>
      <p style={{ fontSize: "10px", letterSpacing: "1px", textTransform: "uppercase", color: "var(--dim)", fontFamily: "'JetBrains Mono', monospace" }}>{label}</p>
      <p style={{ fontSize: "24px", fontWeight: 700, color, fontFamily: "'JetBrains Mono', monospace", marginTop: "4px" }}>{value}</p>
    </div>
  )
}

function Spinner({ size = 14 }: { size?: number }) {
  return (
    <span
      style={{
        display: "inline-block",
        width: size,
        height: size,
        borderRadius: "50%",
        border: `2px solid rgba(255,255,255,0.35)`,
        borderTopColor: "var(--accent)",
        animation: "dp-spin 0.8s linear infinite",
      }}
    />
  )
}

async function postAdmin<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`API ${res.status} ${res.statusText}: ${text ? text : ""}`.trim())
  }
  return res.json() as Promise<T>
}

const filterBtn = (active: boolean): React.CSSProperties => ({
  padding: "5px 12px", border: "1px solid var(--border)", borderRadius: "3px", cursor: "pointer",
  fontFamily: "'JetBrains Mono', monospace", fontSize: "11px", fontWeight: 600,
  textTransform: "uppercase", letterSpacing: "0.5px",
  background:   active ? "rgba(0,255,136,0.1)" : "var(--surface)",
  color:        active ? "var(--accent)"        : "var(--sub)",
  borderColor:  active ? "rgba(0,255,136,0.3)"  : "var(--border)",
  transition: "all 0.15s",
})

export default function PoolPage() {
  const POOL_PAGE_SIZE = 50
  const { selectedStore } = useStore()
  const { showToast } = useToast()
  const [data,    setData]    = useState<PoolResult | null>(null)
  const [stores,  setStores]  = useState<StoreRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)

  const [stageFilter,  setStageFilter]  = useState("all")
  const [statusFilter, setStatusFilter] = useState("all")
  const [storeFilter,  setStoreFilter]  = useState("all")

  const [aiLoadingByPoolId, setAiLoadingByPoolId] = useState<Record<number, boolean>>({})
  const [publishLoadingByPoolId, setPublishLoadingByPoolId] = useState<Record<number, boolean>>({})
  const [publishStoreByPoolId, setPublishStoreByPoolId] = useState<Record<number, string>>({})
  const [selectedPoolIds, setSelectedPoolIds] = useState<Set<number>>(new Set())
  const [publishQuantityByPoolId, setPublishQuantityByPoolId] = useState<Record<number, number>>({})
  const [deleteLoading, setDeleteLoading] = useState(false)

  // ─── Dispatch Selected (new) ───────────────────────────────
  const [dispatchModalOpen, setDispatchModalOpen] = useState(false)
  const [dispatchQuantity, setDispatchQuantity] = useState(1)
  const [dispatchDelay, setDispatchDelay] = useState(30)
  const [dispatchLoading, setDispatchLoading] = useState(false)
  const [dispatchResult, setDispatchResult] = useState<string | null>(null)
  const dispatchResultTimerRef = useRef<number | null>(null)

  // ─── Quick Dispatch (new) ────────────────────────────────
  const [quickDispatchCount, setQuickDispatchCount] = useState<number>(10)
  const [quickDispatchQuantity, setQuickDispatchQuantity] = useState<number>(1)
  const [quickDispatchDelay, setQuickDispatchDelay] = useState<number>(30)
  const [quickDispatchLoading, setQuickDispatchLoading] = useState<boolean>(false)
  const [quickDispatchMessage, setQuickDispatchMessage] = useState<string | null>(null)
  const quickDispatchMessageTimerRef = useRef<number | null>(null)
  const quickPollRef = useRef<number | null>(null)
  const dispatchPollRef = useRef<number | null>(null)
  const [poolPage, setPoolPage] = useState(1)

  const headerCheckboxRef = useRef<HTMLInputElement | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [poolData, storeData] = await Promise.all([
        getPool({
          stage:     stageFilter  !== "all" ? stageFilter  : undefined,
          status:    statusFilter !== "all" ? statusFilter : undefined,
          storeCode: storeFilter  !== "all" ? storeFilter  : undefined,
          limit: 100000,
        }),
        getStores(),
      ])
      setData(poolData); setStores(storeData.rows)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setLoading(false) }
  }, [stageFilter, statusFilter, storeFilter])

  useEffect(() => { load() }, [load])

  // Polling interval'larını unmount'ta temizle
  useEffect(() => {
    return () => {
      if (quickPollRef.current)   clearInterval(quickPollRef.current)
      if (dispatchPollRef.current) clearInterval(dispatchPollRef.current)
    }
  }, [])

  useEffect(() => {
    if (!dispatchResult) return

    if (dispatchResultTimerRef.current != null) window.clearTimeout(dispatchResultTimerRef.current)
    dispatchResultTimerRef.current = window.setTimeout(() => setDispatchResult(null), 4000)

    return () => {
      if (dispatchResultTimerRef.current != null) window.clearTimeout(dispatchResultTimerRef.current)
    }
  }, [dispatchResult])

  useEffect(() => {
    if (!quickDispatchMessage) return
    if (quickDispatchMessageTimerRef.current != null) window.clearTimeout(quickDispatchMessageTimerRef.current)
    quickDispatchMessageTimerRef.current = window.setTimeout(() => setQuickDispatchMessage(null), 3000)
    return () => {
      if (quickDispatchMessageTimerRef.current != null) window.clearTimeout(quickDispatchMessageTimerRef.current)
    }
  }, [quickDispatchMessage])

  useEffect(() => {
    if (!dispatchModalOpen) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDispatchModalOpen(false)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [dispatchModalOpen])

  const rows         = data?.rows ?? []
  const totalPages = Math.max(1, Math.ceil(rows.length / POOL_PAGE_SIZE))
  const pagedRows = rows.slice((poolPage - 1) * POOL_PAGE_SIZE, poolPage * POOL_PAGE_SIZE)
  const totalCount   = data?.total ?? 0
  const readyCount   = rows.filter(r => r.status === "ready").length
  const aiCount      = rows.filter(r => r.pipelineStage === "ai_generated").length
  const assignedCount = rows.filter(r => r.assignedStoreId !== null).length

  const visiblePoolIds = rows.map(r => r.poolId)
  const visibleSelectedCount = visiblePoolIds.reduce((acc, pid) => acc + (selectedPoolIds.has(pid) ? 1 : 0), 0)
  const allVisibleSelected = visiblePoolIds.length > 0 && visibleSelectedCount === visiblePoolIds.length
  const someVisibleSelected = visibleSelectedCount > 0 && visibleSelectedCount < visiblePoolIds.length

  useEffect(() => {
    if (!headerCheckboxRef.current) return
    headerCheckboxRef.current.indeterminate = someVisibleSelected
  }, [someVisibleSelected])

  useEffect(() => {
    if (poolPage > totalPages) setPoolPage(totalPages)
  }, [poolPage, totalPages])

  const updateRow = (poolId: number, patch: Partial<PoolRow>) => {
    setData(prev => {
      if (!prev) return prev
      return {
        ...prev,
        rows: prev.rows.map(r => r.poolId === poolId ? { ...r, ...patch } : r),
      }
    })
  }

  const actionBtn = (kind: "ai" | "publish", disabled: boolean): React.CSSProperties => {
    const base: React.CSSProperties = {
      padding: "4px 10px",
      border: "1px solid var(--border)",
      borderRadius: "3px",
      background: "var(--surface)",
      color: "var(--sub)",
      fontSize: "11px",
      fontFamily: "'JetBrains Mono', monospace",
      cursor: disabled ? "not-allowed" : "pointer",
      opacity: disabled ? 0.7 : 1,
    }
    if (kind === "ai") return { ...base, borderColor: "rgba(0,255,136,0.3)", color: disabled ? "var(--sub)" : "var(--accent)" }
    return { ...base, borderColor: "rgba(0,170,255,0.3)", color: disabled ? "var(--sub)" : "var(--accent)" }
  }

  const handleAiGenerate = async (row: PoolRow) => {
    const pid = row.poolId
    setAiLoadingByPoolId(prev => ({ ...prev, [pid]: true }))
    setError(null)
    try {
      await postAdmin("/admin/ai-listing/generate", { asin: row.asin })
      updateRow(pid, {
        aiStatus: "success",
        pipelineStage: "ai_generated",
      })
      showToast(`Scrape/AI completed for ${row.asin}`)
      addNotification('success', 'AI Listing Hazır', `${row.asin} için AI listing oluşturuldu.`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      showToast(msg, "error")
      addNotification('error', `AI Hatası: ${row.asin}`, msg)
    } finally {
      setAiLoadingByPoolId(prev => ({ ...prev, [pid]: false }))
    }
  }

  const handlePublish = async (row: PoolRow) => {
    const pid = row.poolId
    const quantity = publishQuantityByPoolId[pid] ?? 1
    const selectedStoreCode =
      publishStoreByPoolId[pid] ??
      row.assignedStoreCode ??
      stores[0]?.storeCode ??
      "S1"

    setPublishLoadingByPoolId(prev => ({ ...prev, [pid]: true }))
    setError(null)
    try {
      await postAdmin("/admin/pool/dispatch-selected", {
        storeCode: selectedStoreCode,
        poolIds: [pid],
        quantity,
      })

      const runRes = await postAdmin<{ publish?: { succeeded?: number; failed?: number; items?: { status: string; error?: string | null }[] } }>(
        "/admin/listing/run",
        {
          storeCode: selectedStoreCode,
          count: 1,
          dryRun: false,
          simulationMode: false,
          quantity,
        }
      )

      const succeeded = runRes?.publish?.succeeded ?? 0
      const failed    = runRes?.publish?.failed    ?? 0

      if (succeeded > 0) {
        updateRow(pid, {
          listingStatus: "success",
          pipelineStage: "listed",
          assignedStoreCode: selectedStoreCode,
        })
        addNotification('success', 'eBay\'e Yüklendi', `${row.asin} başarıyla listelendi.`)
      } else {
        const firstErr = runRes?.publish?.items?.find(i => i.status === "failed")?.error ?? null
        const errMsg = firstErr ?? "eBay yükleme başarısız"
        setError(errMsg)
        addNotification('error', `Yüklenemedi: ${row.asin}`, errMsg)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      addNotification('error', `Yüklenemedi: ${row.asin}`, msg)
    } finally {
      setPublishLoadingByPoolId(prev => ({ ...prev, [pid]: false }))
    }
  }

  const handleDeleteSelected = async () => {
    if (selectedPoolIds.size === 0) return
    const ids = Array.from(selectedPoolIds)
    setDeleteLoading(true)
    setError(null)
    try {
      await deletePoolItems(ids)
      setSelectedPoolIds(new Set())
      await load()
      showToast("Selected items deleted")
      addNotification('info', 'Silindi', `${ids.length} ürün havuzdan silindi.`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      showToast(msg, "error")
      addNotification('error', 'Silme Hatası', msg)
    } finally {
      setDeleteLoading(false)
    }
  }

  const handleQuickDispatch = async (): Promise<void> => {
    if (quickDispatchLoading) return

    // Önceki poll varsa temizle
    if (quickPollRef.current) { clearInterval(quickPollRef.current); quickPollRef.current = null }

    setQuickDispatchLoading(true)
    setQuickDispatchMessage(null)

    try {
      // UI filter'larından bağımsız fresh sorgu — sadece ready + işlenebilir stage'ler
      const freshRes = await getPool({ status: "ready", limit: quickDispatchCount * 5 })
      const ELIGIBLE_STAGES = ["validated", "scraped", "ai_generated"]
      const poolIds = (freshRes.rows ?? [])
        .filter(r => r.status === "ready" && ELIGIBLE_STAGES.includes(r.pipelineStage))
        .slice(0, quickDispatchCount)
        .map(r => r.poolId)
        .filter((id): id is number => typeof id === "number" && id > 0)

      if (poolIds.length === 0) throw new Error("Kuyruğa alınabilecek ürün bulunamadı (ready + validated/scraped/ai_generated durumunda ürün yok)")

      // Dispatch run oluştur — worker Amazon'dan veri çekip AI üretecek
      const run = await postAdmin<{ id: number; total_jobs: number }>(
        "/admin/dispatch-runs/create",
        { storeCode: selectedStore, poolIds, quantity: quickDispatchQuantity, delaySeconds: quickDispatchDelay }
      )

      const runId = run.id
      setQuickDispatchMessage(`${poolIds.length} ürün kuyruğa alındı, işleniyor... (0/${poolIds.length})`)
      setQuickDispatchLoading(false) // Butonu serbest bırak, arka planda devam et

      const POLL_TIMEOUT = 20 * 60 * 1000 // 20 dk max
      const startedAt = Date.now()

      quickPollRef.current = window.setInterval(async () => {
        try {
          if (Date.now() - startedAt > POLL_TIMEOUT) {
            clearInterval(quickPollRef.current!); quickPollRef.current = null
            setQuickDispatchMessage("✗ Zaman aşımı (20 dk)")
            return
          }

          const statusRes = await fetch(`${API_BASE}/admin/dispatch-runs/status?runId=${runId}`)
          const statusData = await statusRes.json() as { run: { status: string; completedJobs: number; failedJobs: number; totalJobs: number } | null }
          const r = statusData.run
          if (!r) { clearInterval(quickPollRef.current!); quickPollRef.current = null; return }

          const done = r.completedJobs + r.failedJobs
          setQuickDispatchMessage(`İşleniyor... (${done}/${r.totalJobs} tamamlandı, ${r.failedJobs} hatalı)`)

          if (r.status === "completed") {
            clearInterval(quickPollRef.current!); quickPollRef.current = null
            setQuickDispatchMessage("eBay'e yükleniyor...")

            await postAdmin("/admin/pool/dispatch-selected", { storeCode: selectedStore, poolIds })
            const listingRes = await postAdmin<{ publish?: { succeeded?: number; failed?: number } }>(
              "/admin/publish/run",
              { storeCode: selectedStore, count: poolIds.length, selectionMode: "fifo", delaySeconds: quickDispatchDelay, quantity: quickDispatchQuantity, dryRun: false, simulationMode: false }
            )
            const succeeded = listingRes?.publish?.succeeded ?? 0
            const failed    = listingRes?.publish?.failed    ?? 0
            const msg = `✓ ${succeeded} listelendi, ${failed} başarısız (${poolIds.length} ürün)`
            setQuickDispatchMessage(msg)
            showToast(msg)
            if (succeeded > 0) addNotification('success', 'Quick Dispatch Tamamlandı', `${succeeded}/${poolIds.length} ürün eBay'e yüklendi.`)
            if (failed    > 0) addNotification('error',   'Quick Dispatch: Başarısız',  `${failed} ürün yüklenemedi.`)
            await load()
          }
        } catch (e) {
          clearInterval(quickPollRef.current!); quickPollRef.current = null
          const msg = e instanceof Error ? e.message : String(e)
          setQuickDispatchMessage(`✗ Polling hatası: ${msg}`)
        }
      }, 5000)

    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setQuickDispatchMessage(`✗ ${msg}`)
      showToast(msg, "error")
      addNotification('error', 'Quick Dispatch Hatası', msg)
      setQuickDispatchLoading(false)
    }
  }

  const handleDispatchSelected = async (): Promise<void> => {
    if (selectedPoolIds.size === 0) return

    // Önceki poll varsa temizle
    if (dispatchPollRef.current) { clearInterval(dispatchPollRef.current); dispatchPollRef.current = null }

    setDispatchLoading(true)
    setError(null)

    const poolIds = [...selectedPoolIds]

    try {
      // Dispatch run oluştur — worker Amazon'dan veri çekip AI üretecek
      const run = await postAdmin<{ id: number; total_jobs: number }>(
        "/admin/dispatch-runs/create",
        { storeCode: selectedStore, poolIds, quantity: dispatchQuantity, delaySeconds: dispatchDelay }
      )

      const runId = run.id
      setDispatchResult(`${poolIds.length} ürün kuyruğa alındı, işleniyor... (0/${poolIds.length})`)
      setDispatchModalOpen(false)
      setDispatchLoading(false) // Modal kapandı, arka planda devam ediyor

      const POLL_TIMEOUT = 20 * 60 * 1000
      const startedAt = Date.now()

      dispatchPollRef.current = window.setInterval(async () => {
        try {
          if (Date.now() - startedAt > POLL_TIMEOUT) {
            clearInterval(dispatchPollRef.current!); dispatchPollRef.current = null
            setDispatchResult("✗ Zaman aşımı (20 dk)")
            return
          }

          const statusRes = await fetch(`${API_BASE}/admin/dispatch-runs/status?runId=${runId}`)
          const statusData = await statusRes.json() as { run: { status: string; completedJobs: number; failedJobs: number; totalJobs: number } | null }
          const r = statusData.run
          if (!r) { clearInterval(dispatchPollRef.current!); dispatchPollRef.current = null; return }

          const done = r.completedJobs + r.failedJobs
          setDispatchResult(`İşleniyor... (${done}/${r.totalJobs} tamamlandı, ${r.failedJobs} hatalı)`)

          if (r.status === "completed") {
            clearInterval(dispatchPollRef.current!); dispatchPollRef.current = null
            setDispatchResult("eBay'e yükleniyor...")

            await postAdmin("/admin/pool/dispatch-selected", { storeCode: selectedStore, poolIds })
            const listingRes = await postAdmin<{ publish?: { succeeded?: number; failed?: number } }>(
              "/admin/publish/run",
              { storeCode: selectedStore, count: poolIds.length, selectionMode: "fifo", delaySeconds: dispatchDelay, quantity: dispatchQuantity, dryRun: false, simulationMode: false }
            )
            const succeeded = listingRes?.publish?.succeeded ?? 0
            const failed    = listingRes?.publish?.failed    ?? 0
            setDispatchResult(`✓ ${succeeded} listelendi, ${failed} başarısız`)
            setSelectedPoolIds(new Set())
            if (succeeded > 0) addNotification('success', 'Dispatch Tamamlandı', `${succeeded}/${poolIds.length} ürün eBay'e yüklendi.`)
            if (failed    > 0) addNotification('error',   'Dispatch: Başarısız',  `${failed} ürün yüklenemedi.`)
            await load()
          }
        } catch (e) {
          clearInterval(dispatchPollRef.current!); dispatchPollRef.current = null
          const msg = e instanceof Error ? e.message : String(e)
          setDispatchResult(`✗ Polling hatası: ${msg}`)
        }
      }, 5000)

    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setDispatchResult(`✗ ${msg}`)
      addNotification('error', 'Dispatch Hatası', msg)
      setDispatchLoading(false)
    }
  }

  const isDispatchSuccess = dispatchResult?.startsWith("✓") ?? false

  return (
    <div style={{ maxWidth: "1100px", animation: "fade-in 0.3s ease forwards" }}>
      <style>{`
        @keyframes dp-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>

      {quickDispatchMessage && (
        <div
          style={{
            padding: "10px 16px",
            marginBottom: "16px",
            background: quickDispatchMessage.startsWith("✓") ? "rgba(0,255,136,0.06)" : "rgba(255,68,85,0.06)",
            border: `1px solid ${quickDispatchMessage.startsWith("✓") ? "rgba(0,255,136,0.2)" : "rgba(255,68,85,0.2)"}`,
            borderRadius: "3px",
            color: quickDispatchMessage.startsWith("✓") ? "var(--accent)" : "var(--danger)",
            fontSize: "12px",
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          {quickDispatchMessage}
        </div>
      )}

      {/* Quick Dispatch */}
      <div style={{ padding: "14px", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "3px", marginBottom: "20px" }}>
        <div style={{ fontSize: "12px", fontWeight: 900, letterSpacing: "1.5px", textTransform: "uppercase", color: "var(--dim)", fontFamily: "'JetBrains Mono', monospace", marginBottom: 6 }}>
          Quick Dispatch
        </div>
        <p style={{ fontSize: 11, fontFamily: "'JetBrains Mono', monospace", color: "var(--sub)", marginBottom: 10 }}>
          Store: {selectedStore}
        </p>

        <div style={{ display: "grid", gridTemplateColumns: "0.6fr 0.7fr 0.7fr auto", gap: 10, alignItems: "end" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: "1px", color: "var(--dim)", textTransform: "uppercase", fontFamily: "'JetBrains Mono', monospace" }}>
              Count
            </span>
            <input
              type="number"
              min={1}
              max={500}
              value={quickDispatchCount}
              onChange={(e) => setQuickDispatchCount(Math.max(1, parseInt(e.target.value) || 10))}
              style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "3px", padding: "8px 10px", color: "var(--text)", fontSize: 11, fontFamily: "'JetBrains Mono', monospace", width: "100%" }}
            />
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: "1px", color: "var(--dim)", textTransform: "uppercase", fontFamily: "'JetBrains Mono', monospace" }}>
              Quantity
            </span>
            <input
              type="number"
              min={1}
              max={999}
              value={quickDispatchQuantity}
              onChange={(e) => setQuickDispatchQuantity(Math.max(1, parseInt(e.target.value) || 1))}
              style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "3px", padding: "8px 10px", color: "var(--text)", fontSize: 11, fontFamily: "'JetBrains Mono', monospace", width: "100%" }}
            />
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: "1px", color: "var(--dim)", textTransform: "uppercase", fontFamily: "'JetBrains Mono', monospace" }}>
              Delay (s)
            </span>
            <input
              type="number"
              min={0}
              max={3600}
              value={quickDispatchDelay}
              onChange={(e) => setQuickDispatchDelay(Math.max(0, parseInt(e.target.value) || 0))}
              style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "3px", padding: "8px 10px", color: "var(--text)", fontSize: 11, fontFamily: "'JetBrains Mono', monospace", width: "100%" }}
            />
          </div>

          <button
            onClick={() => void handleQuickDispatch()}
            disabled={quickDispatchLoading}
            style={{
              padding: "10px 14px",
              borderRadius: "3px",
              border: "1px solid rgba(0,255,136,0.3)",
              background: "var(--accent)",
              color: "#000",
              fontSize: 11,
              fontFamily: "'JetBrains Mono', monospace",
              cursor: quickDispatchLoading ? "not-allowed" : "pointer",
              opacity: quickDispatchLoading ? 0.7 : 1,
              fontWeight: 900,
              letterSpacing: "0.5px",
              textTransform: "uppercase",
              whiteSpace: "nowrap",
            }}
          >
            ▶ Quick Dispatch
          </button>
        </div>
      </div>

      {error && (
        <div style={{ padding: "10px 16px", marginBottom: "16px", background: "rgba(255,68,85,0.06)", border: "1px solid rgba(255,68,85,0.2)", borderRadius: "3px", color: "var(--danger)", fontSize: "12px", fontFamily: "'JetBrains Mono', monospace" }}>
          {error}
        </div>
      )}

      {dispatchResult && (
        <div style={{
          padding: "10px 16px",
          marginBottom: "16px",
          background: isDispatchSuccess ? "rgba(0,255,136,0.06)" : "rgba(255,68,85,0.06)",
          border: `1px solid ${isDispatchSuccess ? "rgba(0,255,136,0.2)" : "rgba(255,68,85,0.2)"}`,
          borderRadius: "3px",
          color: isDispatchSuccess ? "var(--accent)" : "var(--danger)",
          fontSize: "12px",
          fontFamily: "'JetBrains Mono', monospace",
        }}>
          {dispatchResult}
        </div>
      )}

      {/* Summary cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "12px", marginBottom: "20px" }}>
        <StatCard label="Total"        value={totalCount}   color="var(--text)"   />
        <StatCard label="Ready"        value={readyCount}   color="var(--warn)"   />
        <StatCard label="AI Generated" value={aiCount}      color="var(--accent)" />
        <StatCard label="Assigned"     value={assignedCount} color="var(--info)"  />
      </div>

      {/* Filters */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "16px", marginBottom: "16px", alignItems: "center" }}>
        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ fontSize: "10px", fontWeight: 700, letterSpacing: "1px", color: "var(--dim)", fontFamily: "'JetBrains Mono', monospace", textTransform: "uppercase" }}>Stage</span>
          {STAGES.map(s => (
            <button key={s} style={filterBtn(stageFilter === s)} onClick={() => setStageFilter(s)}>
              {s === "all" ? "All" : s.replace("_", " ")}
            </button>
          ))}
        </div>

        <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
          <span style={{ fontSize: "10px", fontWeight: 700, letterSpacing: "1px", color: "var(--dim)", fontFamily: "'JetBrains Mono', monospace", textTransform: "uppercase" }}>Status</span>
          {STATUSES.map(s => (
            <button key={s} style={filterBtn(statusFilter === s)} onClick={() => setStatusFilter(s)}>{s}</button>
          ))}
        </div>

        <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
          <span style={{ fontSize: "10px", fontWeight: 700, letterSpacing: "1px", color: "var(--dim)", fontFamily: "'JetBrains Mono', monospace", textTransform: "uppercase" }}>Store</span>
          <select
            id="pool-store-filter"
            value={storeFilter}
            onChange={e => setStoreFilter(e.target.value)}
            style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "3px", padding: "5px 10px", color: "var(--text)", fontSize: "11px", fontFamily: "'JetBrains Mono', monospace" }}
          >
            <option value="all">All Stores</option>
            {stores.map(s => <option key={s.id} value={s.storeCode}>{s.name} ({s.storeCode})</option>)}
          </select>
        </div>

        <div style={{ display: "flex", gap: "10px", alignItems: "center", marginLeft: "auto" }}>
          <button
            onClick={handleDeleteSelected}
            disabled={selectedPoolIds.size === 0 || deleteLoading}
            style={{
              padding: "5px 14px",
              border: "1px solid rgba(255,68,85,0.3)",
              borderRadius: "3px",
              background: "rgba(255,68,85,0.06)",
              color: "var(--danger)",
              fontSize: "11px",
              fontFamily: "'JetBrains Mono', monospace",
              cursor: selectedPoolIds.size === 0 || deleteLoading ? "not-allowed" : "pointer",
              opacity: selectedPoolIds.size === 0 ? 0.7 : 1,
              display: "flex",
              alignItems: "center",
              gap: "8px",
            }}
          >
            {deleteLoading ? <Spinner size={14} /> : null}
            Delete Selected
          </button>

          <button
            onClick={() => setDispatchModalOpen(true)}
            disabled={selectedPoolIds.size === 0 || dispatchLoading}
            style={{
              padding: "5px 14px",
              border: "1px solid rgba(0,255,136,0.3)",
              borderRadius: "3px",
              background: "rgba(0,255,136,0.06)",
              color: "var(--accent)",
              fontSize: "11px",
              fontFamily: "'JetBrains Mono', monospace",
              cursor: selectedPoolIds.size === 0 || dispatchLoading ? "not-allowed" : "pointer",
              opacity: selectedPoolIds.size === 0 ? 0.7 : 1,
              transition: "all 0.15s",
            }}
          >
            ▶ Dispatch Selected
          </button>

          <button onClick={load} style={{ padding: "5px 14px", border: "1px solid var(--border)", borderRadius: "3px", background: "var(--surface)", color: "var(--sub)", fontSize: "11px", fontFamily: "'JetBrains Mono', monospace", cursor: "pointer" }}>
            ↻ Refresh
          </button>
        </div>
      </div>

      {/* Table */}
      <div style={{ border: "1px solid var(--border)", borderRadius: "3px", overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "28px 130px 1fr 90px 90px 90px 160px 100px 110px", padding: "8px 12px", background: "var(--surface)", borderBottom: "1px solid var(--border)", fontSize: "10px", fontWeight: 700, letterSpacing: "1.5px", textTransform: "uppercase", color: "var(--dim)", fontFamily: "'JetBrains Mono', monospace" }}>
          <div style={{ display: "flex", justifyContent: "center", alignItems: "center" }}>
            <input
              ref={headerCheckboxRef}
              type="checkbox"
              checked={allVisibleSelected}
              onChange={(e) => {
                if (e.target.checked) setSelectedPoolIds(new Set(visiblePoolIds))
                else setSelectedPoolIds(new Set())
              }}
            />
          </div>
          <div>ASIN</div><div>Title</div><div>Stage</div>
          <div>Scrape</div><div>AI</div><div>List</div>
          <div>Store</div><div>Updated</div>
        </div>

        {loading ? (
          <div style={{ padding: "32px", textAlign: "center", color: "var(--dim)", fontFamily: "'JetBrains Mono', monospace", fontSize: "13px" }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: "32px", textAlign: "center", color: "var(--dim)", fontFamily: "'JetBrains Mono', monospace", fontSize: "13px" }}>No records found</div>
        ) : (
          pagedRows.map((row: PoolRow, i: number) => (
            <div key={row.poolId} style={{
              display: "grid", gridTemplateColumns: "28px 130px 1fr 90px 90px 90px 160px 100px 110px",
              padding: "7px 12px", fontSize: "12px",
              background: i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.01)",
              borderBottom: "1px solid var(--border)",
            }}>
              <div style={{ display: "flex", justifyContent: "center", alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={selectedPoolIds.has(row.poolId)}
                  onChange={(e) => {
                    const next = new Set(selectedPoolIds)
                    if (e.target.checked) next.add(row.poolId)
                    else next.delete(row.poolId)
                    setSelectedPoolIds(next)
                  }}
                />
              </div>
              <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "11px", color: "var(--text)", display: "flex", alignItems: "center", gap: "6px" }}>
                <Dot color={stageColor(row.pipelineStage)} />
                {row.asin}
              </div>
              <div style={{ fontSize: "12px", color: "var(--sub)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", paddingRight: "8px", display: "flex", alignItems: "center" }}>
                {row.title ?? <span style={{ color: "var(--dim)" }}>—</span>}
              </div>
              <div style={{ display: "flex", alignItems: "center" }}>
                <Badge value={row.pipelineStage.replace("_", " ")} color={stageColor(row.pipelineStage)} />
              </div>
              <div style={{ display: "flex", alignItems: "center" }}>
                <Badge value={row.scrapeStatus} color={statusColor(row.scrapeStatus)} />
              </div>
              <div style={{ display: "flex", alignItems: "center" }}>
                {row.pipelineStage === "scraped" ? (
                  <button
                    style={actionBtn("ai", !!aiLoadingByPoolId[row.poolId])}
                    disabled={!!aiLoadingByPoolId[row.poolId]}
                    onClick={() => handleAiGenerate(row)}
                  >
                    {aiLoadingByPoolId[row.poolId] ? <Spinner size={14} /> : "AI"}
                  </button>
                ) : (
                  <Badge value={row.aiStatus} color={statusColor(row.aiStatus)} />
                )}
              </div>
              <div style={{ display: "flex", alignItems: "center" }}>
                {row.pipelineStage === "ai_generated" ? (
                  <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                    <select
                      value={
                        publishStoreByPoolId[row.poolId] ??
                        row.assignedStoreCode ??
                        stores[0]?.storeCode ??
                        "S1"
                      }
                      disabled={!!publishLoadingByPoolId[row.poolId]}
                      onChange={(e) => setPublishStoreByPoolId(prev => ({ ...prev, [row.poolId]: e.target.value }))}
                      style={{
                        background: "var(--surface)",
                        border: "1px solid var(--border)",
                        borderRadius: "3px",
                        padding: "4px 8px",
                        color: "var(--text)",
                        fontSize: "10px",
                        fontFamily: "'JetBrains Mono', monospace",
                        maxWidth: 90,
                      }}
                    >
                      {stores.map(s => (
                        <option key={s.id} value={s.storeCode}>
                          {s.storeCode}
                        </option>
                      ))}
                    </select>
                    <input
                      type="number"
                      min={1}
                      max={999}
                      defaultValue={1}
                      value={publishQuantityByPoolId[row.poolId] ?? 1}
                      onChange={(e) => setPublishQuantityByPoolId(prev => ({
                        ...prev,
                        [row.poolId]: Math.max(1, parseInt(e.target.value) || 1),
                      }))}
                      style={{
                        width: 48,
                        background: "var(--surface)",
                        border: "1px solid var(--border)",
                        borderRadius: "3px",
                        padding: "4px 6px",
                        color: "var(--text)",
                        fontSize: "11px",
                        fontFamily: "'JetBrains Mono', monospace",
                        textAlign: "center",
                      }}
                    />
                    <button
                      style={actionBtn("publish", !!publishLoadingByPoolId[row.poolId])}
                      disabled={!!publishLoadingByPoolId[row.poolId]}
                      onClick={() => handlePublish(row)}
                    >
                      {publishLoadingByPoolId[row.poolId] ? <Spinner size={14} /> : "Publish"}
                    </button>
                  </div>
                ) : (
                  <Badge value={row.listingStatus} color={statusColor(row.listingStatus)} />
                )}
              </div>
              <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "11px", color: row.assignedStoreCode ? "var(--info)" : "var(--dim)", display: "flex", alignItems: "center" }}>
                {row.assignedStoreCode ?? "—"}
              </div>
              <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "10px", color: "var(--dim)", display: "flex", alignItems: "center" }}>
                {row.updatedAt ? row.updatedAt.slice(0, 16).replace("T", " ") : "—"}
              </div>
            </div>
          ))
        )}
      </div>

      {!loading && (
        <>
          <div
            style={{
              marginTop: "10px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "10px",
              fontFamily: "'JetBrains Mono', monospace",
            }}
          >
            <button
              type="button"
              onClick={() => setPoolPage((p) => Math.max(1, p - 1))}
              disabled={poolPage === 1}
              style={{
                padding: "6px 10px",
                border: "1px solid var(--border)",
                borderRadius: "3px",
                background: "var(--surface)",
                color: "var(--sub)",
                fontSize: "11px",
                cursor: poolPage === 1 ? "not-allowed" : "pointer",
                opacity: poolPage === 1 ? 0.6 : 1,
              }}
            >
              ← Prev
            </button>

            <div style={{ fontSize: "11px", color: "var(--dim)" }}>
              Page {poolPage} of {totalPages}
            </div>

            <button
              type="button"
              onClick={() => setPoolPage((p) => Math.min(totalPages, p + 1))}
              disabled={poolPage >= totalPages}
              style={{
                padding: "6px 10px",
                border: "1px solid var(--border)",
                borderRadius: "3px",
                background: "var(--surface)",
                color: "var(--sub)",
                fontSize: "11px",
                cursor: poolPage >= totalPages ? "not-allowed" : "pointer",
                opacity: poolPage >= totalPages ? 0.6 : 1,
              }}
            >
              Next →
            </button>
          </div>

          <div style={{ marginTop: "10px", fontFamily: "'JetBrains Mono', monospace", fontSize: "11px", color: "var(--dim)" }}>
            {pagedRows.length} of {rows.length} rows (page {poolPage})
          </div>
        </>
      )}

      {/* Dispatch Selected Modal */}
      {dispatchModalOpen && (
        <div
          onClick={() => setDispatchModalOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.7)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
            padding: 16,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "100%",
              maxWidth: 420,
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 3,
              padding: 14,
              boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
              fontFamily: "'JetBrains Mono', monospace",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 900, letterSpacing: "1.5px", textTransform: "uppercase", color: "var(--dim)" }}>
                Dispatch Selected ({selectedPoolIds.size} items)
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <p style={{ fontSize: 12, fontFamily: "'JetBrains Mono', monospace", color: "var(--sub)" }}>
                Store: {selectedStore}
              </p>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <label style={{ fontSize: 11, fontWeight: 800, letterSpacing: "1px", textTransform: "uppercase", color: "var(--dim)" }}>
                    Stock Quantity
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={999}
                    value={dispatchQuantity}
                    onChange={(e) => setDispatchQuantity(Math.max(1, parseInt(e.target.value) || 1))}
                    style={{
                      background: "var(--bg)",
                      border: "1px solid var(--border)",
                      borderRadius: "3px",
                      padding: "8px 10px",
                      color: "var(--text)",
                      fontSize: 13,
                      fontFamily: "'JetBrains Mono', monospace",
                      outline: "none",
                    }}
                  />
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <label style={{ fontSize: 11, fontWeight: 800, letterSpacing: "1px", textTransform: "uppercase", color: "var(--dim)" }}>
                    Delay Between Items (s)
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={3600}
                    value={dispatchDelay}
                    onChange={(e) => setDispatchDelay(Math.max(0, parseInt(e.target.value) || 0))}
                    style={{
                      background: "var(--bg)",
                      border: "1px solid var(--border)",
                      borderRadius: "3px",
                      padding: "8px 10px",
                      color: "var(--text)",
                      fontSize: 13,
                      fontFamily: "'JetBrains Mono', monospace",
                      outline: "none",
                    }}
                  />
                </div>
              </div>

              <div style={{ fontSize: 12, color: "var(--dim)", lineHeight: 1.4, paddingTop: 2 }}>
                {selectedPoolIds.size} items will be queued for extension worker processing
              </div>

              <div style={{ display: "flex", gap: 12 }}>
                <button
                  onClick={() => setDispatchModalOpen(false)}
                  disabled={dispatchLoading}
                  style={{
                    flex: 1,
                    padding: "11px 0",
                    borderRadius: "3px",
                    border: "1px solid var(--border)",
                    background: "var(--surface)",
                    color: "var(--sub)",
                    fontSize: 13,
                    fontFamily: "'JetBrains Mono', monospace",
                    fontWeight: 800,
                    cursor: dispatchLoading ? "not-allowed" : "pointer",
                    opacity: dispatchLoading ? 0.7 : 1,
                    textTransform: "uppercase",
                    letterSpacing: "1px",
                  }}
                >
                  Cancel
                </button>

                <button
                  onClick={() => void handleDispatchSelected()}
                  disabled={dispatchLoading}
                  style={{
                    flex: 1,
                    padding: "11px 0",
                    borderRadius: "3px",
                    border: "1px solid rgba(0,255,136,0.3)",
                    background: "var(--accent)",
                    color: "#000",
                    fontSize: 13,
                    fontFamily: "'JetBrains Mono', monospace",
                    fontWeight: 900,
                    cursor: dispatchLoading ? "not-allowed" : "pointer",
                    opacity: dispatchLoading ? 0.6 : 1,
                    textTransform: "uppercase",
                    letterSpacing: "1px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 10,
                  }}
                >
                  {dispatchLoading ? <Spinner size={14} /> : "▶ Start Dispatch"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

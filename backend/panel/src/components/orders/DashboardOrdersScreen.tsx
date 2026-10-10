"use client"

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { useStore } from "@/lib/storeContext"
import {
  getStores,
  getOrders,
  syncOrders,
  type StoreRow,
  type OrderItem,
  type OrdersStoreError,
} from "@/lib/api"
import { OPERATION_BADGE, DEFAULT_OP_BADGE } from "./operationBadges"
import { useAssistedOrder } from "./useAssistedOrder"

function fmtDate(s: string | null | undefined): string {
  if (!s?.trim()) return "—"
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return s
  return d.toLocaleString("tr-TR")
}

function fmtMoney(value: number, currency: string): string {
  if (!Number.isFinite(value)) return "—"
  const cur = currency?.trim() || "USD"
  try {
    return new Intl.NumberFormat("tr-TR", { style: "currency", currency: cur }).format(value)
  } catch {
    return `${value.toFixed(2)} ${cur}`
  }
}

function pickDefaultStoreCode(
  stores: StoreRow[],
  urlCode: string | null,
  contextCode: string
): string {
  if (urlCode && stores.some((s) => s.storeCode === urlCode)) return urlCode
  if (contextCode && stores.some((s) => s.storeCode === contextCode)) return contextCode
  return stores[0]?.storeCode ?? ""
}

export default function DashboardOrdersScreen() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { selectedStore, setSelectedStore, isStoreReady } = useStore()

  const [stores, setStores] = useState<StoreRow[]>([])
  const [storeCode, setStoreCode] = useState("")
  const [allStores, setAllStores] = useState(false)
  const [orders, setOrders] = useState<OrderItem[]>([])
  const [storeErrors, setStoreErrors] = useState<OrdersStoreError[]>([])

  const [storesLoading, setStoresLoading] = useState(true)
  const [ordersLoading, setOrdersLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [pageError, setPageError] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ type: "success" | "error"; text: string } | null>(null)
  const storesInitDone = useRef(false)

  const activeStores = useMemo(
    () => stores.filter((s) => s.status === "active"),
    [stores]
  )
  const storeOptions = activeStores.length > 0 ? activeStores : stores

  const syncStoreInUrl = useCallback(
    (code: string) => {
      const trimmed = code.trim()
      if (!trimmed) return
      const current = searchParams.get("storeCode")?.trim() ?? ""
      if (current === trimmed) return
      router.replace(`/orders?storeCode=${encodeURIComponent(trimmed)}`, { scroll: false })
    },
    [router, searchParams]
  )

  const loadOrders = useCallback(
    async (opts: { storeCode: string; allStores: boolean }): Promise<boolean> => {
      if (!opts.allStores && !opts.storeCode.trim()) {
        setOrders([])
        setStoreErrors([])
        return true
      }

      setOrdersLoading(true)
      try {
        const result = await getOrders({
          storeCode: opts.allStores ? undefined : opts.storeCode,
          allStores: opts.allStores,
        })
        setOrders(result.orders)
        setStoreErrors(result.errors)
        setPageError(null)
        return true
      } catch (e) {
        setOrders([])
        setStoreErrors([])
        setPageError(e instanceof Error ? e.message : "Siparişler alınamadı.")
        return false
      } finally {
        setOrdersLoading(false)
      }
    },
    []
  )

  // Load store list once + resolve default storeCode (URL → context → first active).
  useEffect(() => {
    if (!isStoreReady || storesInitDone.current) return

    let cancelled = false
    ;(async () => {
      setStoresLoading(true)
      setPageError(null)
      try {
        const storesResult = await getStores()
        const rows = storesResult.rows ?? []
        const usable = rows.filter((s) => s.status === "active")
        const list = usable.length > 0 ? usable : rows
        if (cancelled) return

        setStores(list)
        storesInitDone.current = true

        if (list.length === 0) {
          setStoreCode("")
          setOrders([])
          setStoreErrors([])
          return
        }

        const urlCode = searchParams.get("storeCode")?.trim() || null
        const initial = pickDefaultStoreCode(list, urlCode, selectedStore)
        setStoreCode(initial)
        setSelectedStore(initial)
        syncStoreInUrl(initial)
      } catch (e) {
        if (!cancelled) {
          setPageError(e instanceof Error ? e.message : "Mağaza listesi alınamadı.")
        }
      } finally {
        if (!cancelled) setStoresLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [isStoreReady, searchParams, selectedStore, setSelectedStore, syncStoreInUrl])

  // Browser back/forward: apply storeCode from URL when it changes after init.
  useEffect(() => {
    if (!storesInitDone.current || storeOptions.length === 0 || allStores) return
    const urlCode = searchParams.get("storeCode")?.trim()
    if (!urlCode) return
    if (!storeOptions.some((s) => s.storeCode === urlCode)) return
    if (urlCode === storeCode) return
    setStoreCode(urlCode)
    setSelectedStore(urlCode)
  }, [searchParams, storeOptions, storeCode, allStores, setSelectedStore])

  // Fetch orders only when a store is selected (or all-stores mode).
  useEffect(() => {
    if (storesLoading || !isStoreReady) return
    if (storeOptions.length === 0) return

    if (allStores) {
      void loadOrders({ storeCode: "", allStores: true })
      return
    }

    if (!storeCode.trim()) return
    void loadOrders({ storeCode, allStores: false })
  }, [storesLoading, isStoreReady, storeOptions.length, storeCode, allStores, loadOrders])

  const handleStoreChange = useCallback(
    (code: string) => {
      const trimmed = code.trim()
      if (!trimmed) return
      setStoreCode(trimmed)
      setSelectedStore(trimmed)
      setAllStores(false)
      setNotice(null)
      syncStoreInUrl(trimmed)
    },
    [setSelectedStore, syncStoreInUrl]
  )

  const handleToggleAllStores = useCallback(
    (next: boolean) => {
      setAllStores(next)
      setNotice(null)
    },
    []
  )

  const handleRefresh = useCallback(async () => {
    if (refreshing) return
    if (!allStores && !storeCode.trim()) return
    setRefreshing(true)
    setNotice(null)
    try {
      const result = await syncOrders({
        storeCode: allStores ? undefined : storeCode,
        allStores,
      })
      setOrders(result.orders)
      setStoreErrors(result.errors)
      setPageError(null)
      if (result.errors.length > 0) {
        setNotice({
          type: "error",
          text: "Bazı mağazaların siparişleri alınamadı. Mevcut kayıtlar gösteriliyor.",
        })
      } else {
        setNotice({ type: "success", text: "eBay siparişleri güncellendi." })
      }
    } catch (e) {
      setNotice({
        type: "error",
        text: e instanceof Error ? e.message : "Siparişler güncellenemedi. Lütfen tekrar deneyin.",
      })
    }
    setRefreshing(false)
  }, [refreshing, storeCode, allStores])

  const hasStores = storeOptions.length > 0
  const canRefresh = hasStores && (allStores || storeCode.trim().length > 0)
  const loading = !isStoreReady || storesLoading

  const headerSubtitle = useMemo(() => {
    if (!hasStores) return "Bağlı eBay mağazanız bulunmuyor."
    if (allStores) return "Tüm bağlı mağazaların siparişleri tarihe göre listeleniyor."
    return "Seçili mağazanın eBay siparişleri."
  }, [hasStores, allStores])

  if (loading) {
    return <div style={{ padding: 48, textAlign: "center", color: "var(--dim)" }}>Yükleniyor…</div>
  }

  return (
    <div style={{ maxWidth: 960, margin: "0 auto" }}>
      <div style={headerRowStyle}>
        <div>
          <h1 style={{ fontFamily: "'Syne', sans-serif", margin: 0, fontSize: 28 }}>Siparişler</h1>
          <p style={{ color: "var(--dim)", margin: "6px 0 0", lineHeight: 1.5 }}>{headerSubtitle}</p>
        </div>
        <button
          type="button"
          onClick={() => void handleRefresh()}
          disabled={!canRefresh || refreshing}
          style={{
            ...primaryBtnStyle,
            opacity: !canRefresh || refreshing ? 0.6 : 1,
            cursor: !canRefresh || refreshing ? "not-allowed" : "pointer",
          }}
        >
          {refreshing ? "Güncelleniyor…" : "eBay siparişleri güncelle"}
        </button>
      </div>

      {notice && (
        <div
          style={{
            ...bannerStyle,
            border: `1px solid ${notice.type === "success" ? "#3a8" : "#c44"}`,
            background: notice.type === "success" ? "rgba(60,180,120,0.1)" : "rgba(200,60,60,0.08)",
            color: notice.type === "success" ? "#6c9" : "#e88",
          }}
        >
          {notice.text}
        </div>
      )}

      {pageError && (
        <div
          style={{
            ...bannerStyle,
            border: "1px solid #c44",
            background: "rgba(200,60,60,0.08)",
            color: "#e88",
          }}
        >
          {pageError}
        </div>
      )}

      {!hasStores ? (
        <div style={emptyStateStyle}>
          <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>Bağlı eBay mağazası yok</div>
          <div style={{ color: "var(--dim)", fontSize: 14 }}>
            Siparişleri görüntülemek için önce bir eBay mağazası bağlamanız gerekir.
          </div>
        </div>
      ) : (
        <>
          <div style={controlsRowStyle}>
            <label style={controlLabelStyle}>
              <span style={{ fontSize: 12, color: "var(--dim)" }}>Mağaza</span>
              <select
                value={storeCode}
                onChange={(e) => handleStoreChange(e.target.value)}
                disabled={allStores}
                aria-label="Mağaza seç"
                style={{ ...selectStyle, opacity: allStores ? 0.55 : 1 }}
              >
                {storeOptions.map((s) => (
                  <option key={s.storeCode} value={s.storeCode}>
                    {s.name} ({s.storeCode})
                  </option>
                ))}
              </select>
            </label>

            <label style={toggleLabelStyle}>
              <input
                type="checkbox"
                checked={allStores}
                onChange={(e) => handleToggleAllStores(e.target.checked)}
              />
              <span>Tüm mağazaların siparişlerini göster</span>
            </label>
          </div>

          {ordersLoading && (
            <div style={{ padding: "12px 0", color: "var(--dim)", fontSize: 13 }}>Siparişler yükleniyor…</div>
          )}

          {storeErrors.length > 0 && (
            <div
              style={{
                ...bannerStyle,
                border: "1px solid rgba(200,160,60,0.5)",
                background: "rgba(200,160,60,0.08)",
                color: "#d9b65f",
              }}
            >
              Bazı mağazaların siparişleri alınamadı:{" "}
              {storeErrors.map((e) => e.storeName).join(", ")}
            </div>
          )}

          <OrdersList orders={orders} showStore={allStores} />
        </>
      )}
    </div>
  )
}

function OrdersList({ orders, showStore }: { orders: OrderItem[]; showStore: boolean }) {
  if (orders.length === 0) {
    return (
      <div style={emptyStateStyle}>
        <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>Henüz sipariş yok</div>
        <div style={{ color: "var(--dim)", fontSize: 14 }}>
          Bu görünümde gösterilecek eBay siparişi bulunamadı.
        </div>
      </div>
    )
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {orders.map((order, idx) => (
        <OrderRow key={`${order.storeCode}-${order.orderId}-${idx}`} order={order} showStore={showStore} />
      ))}
    </div>
  )
}

function OrderRow({ order, showStore }: { order: OrderItem; showStore: boolean }) {
  const opBadge = OPERATION_BADGE[order.operationStatus] ?? DEFAULT_OP_BADGE

  const customer = order.buyerName?.trim() || order.buyerUsername?.trim() || "—"
  const detailHref = `/orders/${order.id}`

  const { launch, busy, note, modal } = useAssistedOrder()

  return (
    <div style={rowStyle}>
      <Link href={detailHref} aria-label="Sipariş detayı" style={thumbLinkStyle}>
        <OrderThumbnail src={order.imageUrl} alt={order.productTitle} />
      </Link>

      <div style={rowMainStyle}>
        <div style={rowTopLineStyle}>
          {showStore && <span style={storeChipStyle}>{order.storeName}</span>}
          <span style={orderIdStyle}>#{order.orderId}</span>
          <span style={{ color: "var(--dim)", fontSize: 12 }}>{fmtDate(order.creationDate)}</span>
        </div>
        <Link href={detailHref} style={productTitleLinkStyle} title={order.productTitle}>
          {order.productTitle}
        </Link>
        <div style={rowMetaLineStyle}>
          <span>Müşteri: {customer}</span>
          <span>Adet: {order.quantity}</span>
          {note && <span style={{ color: note.type === "error" ? "#e88" : "var(--dim)" }}>{note.text}</span>}
        </div>
      </div>

      <div style={rowSideStyle}>
        <span style={amountStyle}>{fmtMoney(order.total, order.currency)}</span>
        <span style={{ ...badgeStyle, background: opBadge.bg, color: opBadge.color }}>
          {order.operationStatusLabel}
        </span>
        <button
          type="button"
          onClick={() => void launch(order.id)}
          disabled={busy}
          style={{ ...assistBtnStyle, opacity: busy ? 0.6 : 1, cursor: busy ? "default" : "pointer" }}
          title="Amazon assisted order başlat"
        >
          {busy ? "…" : "Siparişe Başla"}
        </button>
      </div>
      {modal}
    </div>
  )
}

function OrderThumbnail({ src, alt }: { src: string | null; alt: string }) {
  const [errored, setErrored] = useState(false)
  if (!src?.trim() || errored) {
    return <div style={thumbPlaceholderStyle} aria-hidden="true" />
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      style={thumbImageStyle}
      loading="lazy"
      onError={() => setErrored(true)}
    />
  )
}

const headerRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: 16,
  marginBottom: 20,
}

const primaryBtnStyle: CSSProperties = {
  padding: "10px 18px",
  borderRadius: 6,
  border: "none",
  background: "var(--accent, #3b82f6)",
  color: "#fff",
  fontWeight: 600,
  fontSize: 14,
  whiteSpace: "nowrap",
}

const bannerStyle: CSSProperties = {
  padding: 14,
  marginBottom: 16,
  borderRadius: 8,
  fontSize: 14,
}

const controlsRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: 16,
  marginBottom: 16,
}

const controlLabelStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
}

const toggleLabelStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 13,
  cursor: "pointer",
  userSelect: "none",
}

const selectStyle: CSSProperties = {
  padding: "8px 12px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "inherit",
  fontSize: 13,
  minWidth: 200,
}

const emptyStateStyle: CSSProperties = {
  padding: "48px 24px",
  textAlign: "center",
  borderRadius: 8,
  border: "1px dashed var(--border)",
  background: "var(--surface)",
}

const rowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 12,
  padding: "12px 16px",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "var(--surface)",
}

const thumbImageStyle: CSSProperties = {
  width: 56,
  height: 56,
  flexShrink: 0,
  borderRadius: 6,
  objectFit: "cover",
  border: "1px solid var(--border)",
  background: "var(--surface)",
}

const thumbPlaceholderStyle: CSSProperties = {
  width: 56,
  height: 56,
  flexShrink: 0,
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "rgba(120,130,150,0.1)",
}

const rowMainStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  flex: "1 1 240px",
  minWidth: 0,
}

const rowTopLineStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: 10,
}

const storeChipStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  padding: "2px 8px",
  borderRadius: 4,
  background: "rgba(120,130,150,0.18)",
  color: "var(--dim)",
}

const orderIdStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
}

const productTitleStyle: CSSProperties = {
  fontSize: 14,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  maxWidth: "100%",
}

const productTitleLinkStyle: CSSProperties = {
  ...productTitleStyle,
  color: "inherit",
  textDecoration: "none",
  cursor: "pointer",
  display: "block",
}

const thumbLinkStyle: CSSProperties = {
  display: "inline-flex",
  flexShrink: 0,
  textDecoration: "none",
}

const rowMetaLineStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 16,
  fontSize: 12,
  color: "var(--dim)",
}

const rowSideStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  flexShrink: 0,
}

const amountStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  whiteSpace: "nowrap",
}

const badgeStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  padding: "4px 10px",
  borderRadius: 999,
  whiteSpace: "nowrap",
}

const assistBtnStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  padding: "6px 12px",
  borderRadius: 6,
  border: "1px solid var(--accent, #3b82f6)",
  background: "transparent",
  color: "var(--accent, #3b82f6)",
  whiteSpace: "nowrap",
}

"use client"

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { fetchAuthMe, type UserPublic } from "@/lib/userAuthClient"
import {
  fetchAppStores,
  fetchAppOrders,
  syncAppOrders,
  type AppStoreSummary,
  type AppOrderItem,
  type AppOrderStatus,
  type AppOrdersStoreError,
} from "@/lib/userAppClient"
import { useAssistedOrder } from "@/components/orders/useAssistedOrder"
import { NoStoreEmptyState } from "@/components/app/NoStoreEmptyState"
import {
  adoptStoreSelection,
  storeCodeForId,
  useAppStoreSelection,
} from "@/lib/appStoreSelection"

type StatusBadgeConfig = {
  label: string
  bg:    string
  color: string
}

const STATUS_BADGES: Record<AppOrderStatus, StatusBadgeConfig> = {
  new:        { label: "Yeni",            bg: "rgba(59,130,246,0.15)",  color: "#7eb0ff" },
  processing: { label: "İşlem bekliyor",  bg: "rgba(200,160,60,0.18)",  color: "#d9b65f" },
  updated:    { label: "Güncellendi",     bg: "rgba(60,180,120,0.16)",  color: "#5fc98c" },
  error:      { label: "Hata",            bg: "rgba(200,60,60,0.16)",   color: "#e88" },
}

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

type OrdersScreenProps = {
  /** Back link target. Pass null to hide the back link (e.g. when a sidebar already handles navigation). */
  backHref?: string | null
}

export default function OrdersScreen({ backHref = "/app/dashboard" }: OrdersScreenProps) {
  const router = useRouter()
  const { selectedStoreId, setSelectedStoreId, isStoreSelectionReady } = useAppStoreSelection()
  const selectedStoreIdRef = useRef(selectedStoreId)
  selectedStoreIdRef.current = selectedStoreId

  const [user, setUser] = useState<UserPublic | null>(null)
  const [stores, setStores] = useState<AppStoreSummary[]>([])
  const [allStores, setAllStores] = useState(false)

  const [orders, setOrders] = useState<AppOrderItem[]>([])
  const [storeErrors, setStoreErrors] = useState<AppOrdersStoreError[]>([])

  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [pageError, setPageError] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ type: "success" | "error"; text: string } | null>(null)

  const selectedStoreCode = useMemo(
    () => storeCodeForId(stores, selectedStoreId),
    [stores, selectedStoreId]
  )

  const loadOrders = useCallback(
    async (opts: { storeCode: string; allStores: boolean }): Promise<boolean> => {
      if (!opts.allStores && !opts.storeCode.trim()) {
        setOrders([])
        setStoreErrors([])
        return true
      }

      const result = await fetchAppOrders({
        storeCode: opts.allStores ? undefined : opts.storeCode,
        allStores: opts.allStores,
      })

      if (!result.ok) {
        if (result.status === 401) {
          router.replace("/app/login")
          return false
        }
        setOrders([])
        setStoreErrors([])
        setPageError(result.error || "Siparişler alınamadı.")
        return false
      }

      setOrders(result.data.orders)
      setStoreErrors(result.data.errors)
      setPageError(null)
      return true
    },
    [router]
  )

  const load = useCallback(async () => {
    setLoading(true)
    setPageError(null)

    const me = await fetchAuthMe()
    if (!me) {
      router.replace("/app/login")
      return
    }
    if (me.approvalStatus !== "active") {
      router.replace(me.approvalStatus === "pending_approval" ? "/pending-approval" : "/app/login")
      return
    }
    setUser(me)

    const storesResult = await fetchAppStores()
    if (!storesResult.ok) {
      if (storesResult.status === 401) {
        router.replace("/app/login")
        return
      }
      setPageError("Mağaza listesi alınamadı.")
      setLoading(false)
      return
    }

    const loadedStores = storesResult.data.stores
    setStores(loadedStores)

    const adopted = adoptStoreSelection(loadedStores, {
      providerStoreId: selectedStoreIdRef.current,
    })
    if (adopted.shouldWriteProvider && adopted.storeId != null) {
      setSelectedStoreId(adopted.storeId)
    }
    const initialCode = storeCodeForId(loadedStores, adopted.storeId)

    if (loadedStores.length > 0 && initialCode) {
      await loadOrders({ storeCode: initialCode, allStores: false })
    } else {
      setOrders([])
      setStoreErrors([])
    }

    setLoading(false)
  }, [router, loadOrders, setSelectedStoreId])

  useEffect(() => {
    if (!isStoreSelectionReady) return
    void load()
  }, [isStoreSelectionReady, load])

  const handleStoreChange = useCallback(
    (storeIdRaw: string) => {
      const id = Number(storeIdRaw)
      if (!Number.isFinite(id) || id <= 0) return
      const store = stores.find(s => s.storeId === id)
      if (!store) return
      setSelectedStoreId(id)
      setNotice(null)
      void loadOrders({ storeCode: store.storeCode, allStores })
    },
    [allStores, loadOrders, stores, setSelectedStoreId]
  )

  const handleToggleAllStores = useCallback(
    (next: boolean) => {
      setAllStores(next)
      setNotice(null)
      void loadOrders({ storeCode: selectedStoreCode, allStores: next })
    },
    [selectedStoreCode, loadOrders]
  )

  const handleRefresh = useCallback(async () => {
    if (refreshing) return
    setRefreshing(true)
    setNotice(null)
    if (!allStores && !selectedStoreCode.trim()) {
      setRefreshing(false)
      return
    }
    const syncResult = await syncAppOrders({
      storeCode: allStores ? undefined : selectedStoreCode,
      allStores,
    })
    if (!syncResult.ok) {
      setRefreshing(false)
      if (syncResult.status === 401) {
        router.replace("/app/login")
        return
      }
      setNotice({ type: "error", text: syncResult.error || "Siparişler güncellenemedi." })
      return
    }
    setOrders(syncResult.data.orders)
    setStoreErrors(syncResult.data.errors)
    setPageError(null)
    setRefreshing(false)
    setNotice({ type: "success", text: "eBay siparişleri güncellendi." })
  }, [refreshing, selectedStoreCode, allStores, router])

  const hasStores = stores.length > 0
  const canRefresh = hasStores && (allStores || selectedStoreCode.trim().length > 0)

  const headerSubtitle = useMemo(() => {
    if (!hasStores) return "Bağlı eBay mağazanız bulunmuyor."
    if (allStores) return "Tüm bağlı mağazaların siparişleri tarihe göre listeleniyor."
    return "Seçili mağazanın eBay siparişleri."
  }, [hasStores, allStores])

  if (loading) {
    return <div style={{ padding: 48, textAlign: "center", color: "var(--dim)" }}>Yükleniyor…</div>
  }

  if (!user) return null

  return (
    <div style={{ maxWidth: 960, margin: "0 auto" }}>
      {backHref && (
        <div style={{ marginBottom: 20 }}>
          <Link href={backHref} style={{ color: "var(--dim)", fontSize: 14, textDecoration: "none" }}>
            ← Dashboard
          </Link>
        </div>
      )}

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
        <NoStoreEmptyState
          title="Bağlı eBay mağazası yok"
          description="Siparişleri görüntülemek için önce bir eBay mağazası bağlamanız gerekir."
          cta="manage-stores"
        />
      ) : (
        <>
          <div style={controlsRowStyle}>
            <label style={controlLabelStyle}>
              <span style={{ fontSize: 12, color: "var(--dim)" }}>Mağaza</span>
              <select
                value={selectedStoreId != null ? String(selectedStoreId) : ""}
                onChange={e => handleStoreChange(e.target.value)}
                disabled={allStores}
                aria-label="Mağaza seç"
                style={{ ...selectStyle, opacity: allStores ? 0.55 : 1 }}
              >
                {stores.map(s => (
                  <option key={s.storeId} value={s.storeId}>
                    {s.name} ({s.storeCode})
                  </option>
                ))}
              </select>
            </label>

            <label style={toggleLabelStyle}>
              <input
                type="checkbox"
                checked={allStores}
                onChange={e => handleToggleAllStores(e.target.checked)}
              />
              <span>Tüm mağazaların siparişlerini göster</span>
            </label>
          </div>

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
              {storeErrors.map(e => e.storeName).join(", ")}
            </div>
          )}

          <OrdersList orders={orders} showStore={allStores} />
        </>
      )}
    </div>
  )
}

function OrdersList({ orders, showStore }: { orders: AppOrderItem[]; showStore: boolean }) {
  if (orders.length === 0) {
    return (
      <div style={emptyStateStyle}>
        <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>Henüz sipariş yok</div>
        <div style={{ color: "var(--dim)", fontSize: 14 }}>
          Bu görünümde gösterilecek eBay siparişi bulunamadı. “eBay siparişleri güncelle” ile senkronize edin.
        </div>
      </div>
    )
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {orders.map((order, idx) => (
        <OrderRow key={`${order.storeCode}-${order.id}-${idx}`} order={order} showStore={showStore} />
      ))}
    </div>
  )
}

function OrderThumbnail({ src, alt }: { src: string | null; alt: string }) {
  if (!src?.trim()) {
    return <div style={thumbPlaceholderStyle} aria-hidden />
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={alt} style={thumbImgStyle} loading="lazy" />
  )
}

function OrderRow({ order, showStore }: { order: AppOrderItem; showStore: boolean }) {
  const badge = STATUS_BADGES[order.status] ?? STATUS_BADGES.new
  const detailHref = `/app/orders/${order.id}`
  const { launch, busy, note, modal } = useAssistedOrder(true)
  const opLabel = order.operationStatusLabel?.trim() || badge.label

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
          <span>Müşteri: {order.buyerUsername?.trim() || "—"}</span>
          <span>Adet: {order.quantity}</span>
          {note && <span style={{ color: note.type === "error" ? "#e88" : "var(--dim)" }}>{note.text}</span>}
        </div>
      </div>

      <div style={rowSideStyle}>
        <span style={amountStyle}>{fmtMoney(order.total, order.currency)}</span>
        <span style={{ ...badgeStyle, background: badge.bg, color: badge.color }}>{opLabel}</span>
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

// ----------------------------------------------------------------
// Styles
// ----------------------------------------------------------------

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

const rowMainStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  flex: "1 1 280px",
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

const thumbLinkStyle: CSSProperties = {
  flexShrink: 0,
  display: "block",
  textDecoration: "none",
}

const thumbImgStyle: CSSProperties = {
  width: 56,
  height: 56,
  objectFit: "cover",
  borderRadius: 8,
  border: "1px solid var(--border, #2a2d34)",
  background: "var(--card, #16181d)",
}

const thumbPlaceholderStyle: CSSProperties = {
  width: 56,
  height: 56,
  borderRadius: 8,
  border: "1px solid var(--border, #2a2d34)",
  background: "rgba(255,255,255,0.04)",
}

const productTitleLinkStyle: CSSProperties = {
  color: "inherit",
  textDecoration: "none",
  fontWeight: 600,
  fontSize: 14,
  lineHeight: 1.35,
  display: "-webkit-box",
  WebkitLineClamp: 2,
  WebkitBoxOrient: "vertical",
  overflow: "hidden",
}

const assistBtnStyle: CSSProperties = {
  padding: "6px 10px",
  borderRadius: 6,
  border: "1px solid var(--border, #2a2d34)",
  background: "transparent",
  color: "inherit",
  fontSize: 12,
  fontWeight: 600,
  whiteSpace: "nowrap",
}

const productTitleStyle: CSSProperties = {
  fontSize: 14,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  maxWidth: "100%",
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

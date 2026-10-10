"use client"

import { useCallback, useEffect, useState, type CSSProperties } from "react"
import Link from "next/link"
import { useParams, usePathname } from "next/navigation"
import {
  getOrderDetail,
  updateOrderManual,
  refreshOrderEarnings,
  OPERATION_STATUSES,
  OPERATION_STATUS_LABELS,
  type OrderDetail,
  type OperationStatus,
  type OrderManualUpdateInput,
} from "@/lib/api"
import {
  fetchAppOrderDetail,
  updateAppOrderManual,
  refreshAppOrderEarnings,
} from "@/lib/userAppClient"
import { OPERATION_BADGE, DEFAULT_OP_BADGE } from "./operationBadges"
import { formatAmazonAddress, copyToClipboard } from "./assistedOrder"
import { useAssistedOrder } from "./useAssistedOrder"

function fmtDate(s: string | null | undefined): string {
  if (!s?.trim()) return "—"
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return s
  return d.toLocaleString("tr-TR")
}

function fmtMoney(value: number | null | undefined, currency: string | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—"
  const cur = currency?.trim() || "USD"
  try {
    return new Intl.NumberFormat("tr-TR", { style: "currency", currency: cur }).format(value)
  } catch {
    return `${value.toFixed(2)} ${cur}`
  }
}

export default function OrderDetailScreen() {
  const params = useParams()
  const rawId = params?.orderId
  const orderId = Array.isArray(rawId) ? rawId[0] : rawId
  const pathname = usePathname()
  const useAppApi = (pathname ?? "").startsWith("/app/orders")
  const listHref = useAppApi ? "/app/orders" : "/orders"

  const [detail, setDetail] = useState<OrderDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [notes, setNotes] = useState("")
  const [amazonOrderNumber, setAmazonOrderNumber] = useState("")
  const [amazonOrderUrl, setAmazonOrderUrl] = useState("")
  const [amazonPurchasePrice, setAmazonPurchasePrice] = useState("")
  const [operationStatus, setOperationStatus] = useState<OperationStatus>("AMAZON_PENDING")
  const [statusDirty, setStatusDirty] = useState(false)

  const [saving, setSaving] = useState(false)
  const [saveNotice, setSaveNotice] = useState<{ type: "success" | "error"; text: string } | null>(null)
  const [copyNotice, setCopyNotice] = useState(false)
  const [earningsLoading, setEarningsLoading] = useState(false)
  const { launch: launchAssist, busy: assisting, note: assistNotice, setNote: setAssistNotice, modal: assistModal } = useAssistedOrder(useAppApi)

  const applyDetail = useCallback((d: OrderDetail) => {
    setDetail(d)
    setNotes(d.manual.notes ?? "")
    setAmazonOrderNumber(d.manual.amazonOrderNumber ?? "")
    setAmazonOrderUrl(d.manual.amazonOrderUrl ?? "")
    setAmazonPurchasePrice(
      d.manual.amazonPurchasePrice != null ? String(d.manual.amazonPurchasePrice) : ""
    )
    setOperationStatus(d.operationStatus)
    setStatusDirty(false)
  }, [])

  const loadEarnings = useCallback(async (id: string | number) => {
    setEarningsLoading(true)
    try {
      if (useAppApi) {
        const r = await refreshAppOrderEarnings(id)
        if (!r.ok) throw new Error(r.error)
        applyDetail(r.data)
      } else {
        const d = await refreshOrderEarnings(id)
        applyDetail(d)
      }
    } catch {
      /* keep existing detail; finance card shows error/missing */
    }
    setEarningsLoading(false)
  }, [applyDetail, useAppApi])

  const load = useCallback(async () => {
    if (!orderId) return
    setLoading(true)
    setLoadError(null)
    try {
      if (useAppApi) {
        const r = await fetchAppOrderDetail(orderId)
        if (!r.ok) throw new Error(r.status === 404 ? "404" : r.error)
        applyDetail(r.data)
      } else {
        const d = await getOrderDetail(orderId)
        applyDetail(d)
      }
      // Earnings are filled by the 10-min / 24h order sync — do NOT POST on every detail open.
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Sipariş alınamadı."
      setLoadError(msg.includes("404") ? "Sipariş bulunamadı." : msg)
      setDetail(null)
    }
    setLoading(false)
  }, [orderId, applyDetail, useAppApi])

  useEffect(() => {
    void load()
  }, [load])

  const handleSave = useCallback(async () => {
    if (!orderId || saving) return
    setSaving(true)
    setSaveNotice(null)
    try {
      const priceTrim = amazonPurchasePrice.trim()
      const amazonNoRaw = amazonOrderNumber.replace(/[\u200B-\u200D\uFEFF\u202A-\u202E\u2066-\u2069]/g, "").replace(/\s+/g, "").trim()
      const payload: OrderManualUpdateInput = {
        notes: notes.trim() ? notes.trim() : null,
        amazonOrderNumber: amazonNoRaw ? amazonNoRaw : null,
        amazonOrderUrl: amazonOrderUrl.trim() ? amazonOrderUrl.trim() : null,
        amazonPurchasePrice: priceTrim ? Number(priceTrim) : null,
      }
      if (amazonNoRaw && !/^\d{3}-\d{7}-\d{7}$/.test(amazonNoRaw)) {
        setSaveNotice({
          type: "error",
          text: "Geçersiz Amazon sipariş numarası. Beklenen format: 114-1234567-1234567",
        })
        setSaving(false)
        return
      }
      if (statusDirty) payload.operationStatus = operationStatus

      if (useAppApi) {
        const r = await updateAppOrderManual(orderId, payload)
        if (!r.ok) throw new Error(r.error)
        applyDetail(r.data)
      } else {
        const d = await updateOrderManual(orderId, payload)
        applyDetail(d)
      }
      setSaveNotice({
        type: "success",
        text: amazonNoRaw
          ? "Amazon order number kaydedildi. İlgili Amazon mailleri bu siparişe bağlandı."
          : "Bilgiler kaydedildi.",
      })
    } catch (e) {
      setSaveNotice({
        type: "error",
        text: e instanceof Error ? e.message : "Kaydedilemedi. Lütfen tekrar deneyin.",
      })
    }
    setSaving(false)
  }, [orderId, saving, notes, amazonOrderNumber, amazonOrderUrl, amazonPurchasePrice, statusDirty, operationStatus, applyDetail, useAppApi])

  const handleCopyAddress = useCallback(async () => {
    if (!detail?.address) return
    const ok = await copyToClipboard(formatAmazonAddress(detail.address))
    if (ok) {
      setCopyNotice(true)
      setTimeout(() => setCopyNotice(false), 2000)
    }
  }, [detail])

  const flashCopy = useCallback((text: string) => {
    void copyToClipboard(text).then((ok) => {
      if (ok) {
        setCopyNotice(true)
        setTimeout(() => setCopyNotice(false), 2000)
      }
    })
  }, [])

  const handleAssist = useCallback(() => {
    if (orderId) void launchAssist(Number(orderId))
  }, [orderId, launchAssist])

  // Listen for assisted-order results relayed by the extension panel bridge.
  useEffect(() => {
    if (!orderId) return
    const onMsg = (e: MessageEvent) => {
      if (e.source !== window) return
      const d = e.data
      if (!d || d.source !== "listjetgo-panel" || d.type !== "ASSISTED_ORDER_RESULT") return
      const result = d.result
      if (!result || String(result.orderId) !== String(orderId)) return
      const fields: OrderManualUpdateInput = {}
      if (typeof result.amazonOrderNumber === "string" && result.amazonOrderNumber.trim()) {
        fields.amazonOrderNumber = result.amazonOrderNumber.trim()
      }
      if (typeof result.amazonOrderUrl === "string" && result.amazonOrderUrl.trim()) {
        fields.amazonOrderUrl = result.amazonOrderUrl.trim()
      }
      if (result.amazonPurchasePrice != null && Number.isFinite(Number(result.amazonPurchasePrice))) {
        fields.amazonPurchasePrice = Number(result.amazonPurchasePrice)
      }
      if (Object.keys(fields).length === 0) return
      const savePromise = useAppApi
        ? updateAppOrderManual(orderId, fields).then((r) => {
            if (!r.ok) throw new Error(r.error)
            return r.data
          })
        : updateOrderManual(orderId, fields)
      void savePromise
        .then((updated) => {
          applyDetail(updated)
          setAssistNotice({ type: "success", text: "Amazon sipariş bilgisi extension'dan kaydedildi." })
          window.postMessage({ source: "listjetgo-panel", type: "ASSISTED_ORDER_RESULT_SAVED", orderId }, "*")
        })
        .catch(() => {
          setAssistNotice({ type: "error", text: "Extension verisi kaydedilemedi." })
        })
    }
    window.addEventListener("message", onMsg)
    // Ask the bridge to replay any pending result captured while panel was closed.
    window.postMessage({ source: "listjetgo-panel", type: "ASSISTED_ORDER_RESULT_REQUEST" }, "*")
    return () => window.removeEventListener("message", onMsg)
  }, [orderId, applyDetail, useAppApi, setAssistNotice])

  if (loading) {
    return <div style={{ padding: 48, textAlign: "center", color: "var(--dim)" }}>Yükleniyor…</div>
  }

  if (loadError || !detail) {
    return (
      <div style={{ maxWidth: 720, margin: "0 auto" }}>
        <Link href={listHref} style={backLinkStyle}>← Siparişlere dön</Link>
        <div style={emptyStateStyle}>
          <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>
            {loadError ?? "Sipariş bulunamadı."}
          </div>
          <div style={{ color: "var(--dim)", fontSize: 14 }}>
            Bu sipariş görüntülenemiyor.
          </div>
        </div>
      </div>
    )
  }

  const opBadge = OPERATION_BADGE[detail.operationStatus] ?? DEFAULT_OP_BADGE
  const firstItem = detail.items[0] ?? null

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto" }}>
      {assistModal}
      <Link href={listHref} style={backLinkStyle}>← Siparişlere dön</Link>

      <div style={topRowStyle}>
        <div>
          <h1 style={{ fontFamily: "'Syne', sans-serif", margin: 0, fontSize: 24 }}>
            Sipariş #{detail.ebayOrderId}
          </h1>
          <p style={{ color: "var(--dim)", margin: "6px 0 0" }}>
            {detail.storeName} · {fmtDate(detail.creationDate)}
          </p>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8 }}>
          <span style={{ ...badgeStyle, background: opBadge.bg, color: opBadge.color }}>
            {detail.operationStatusLabel}
          </span>
          <button
            type="button"
            onClick={() => void handleAssist()}
            disabled={assisting}
            style={{ ...primaryBtnStyle, opacity: assisting ? 0.6 : 1, cursor: assisting ? "default" : "pointer" }}
          >
            {assisting ? "Hazırlanıyor…" : "Siparişe Başla"}
          </button>
        </div>
      </div>

      {assistNotice && (
        <div
          style={{
            ...inlineNoticeStyle,
            marginBottom: 14,
            color: assistNotice.type === "success" ? "#6c9" : "#e88",
          }}
        >
          {assistNotice.text}
        </div>
      )}

      <div style={gridStyle}>
        {/* Left: product card */}
        <div style={cardStyle}>
          <div style={cardTitleStyle}>Ürün</div>
          <div style={{ display: "flex", gap: 14 }}>
            <ProductThumbnail src={firstItem?.imageUrl ?? null} alt={firstItem?.title ?? "Ürün"} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.4 }}>
                {firstItem?.title ?? "Ürün bilgisi yok"}
              </div>
              <div style={metaGridStyle}>
                <MetaLine label="eBay item ID" value={firstItem?.ebayItemId} />
                <MetaLine label="ASIN" value={firstItem?.asin} />
                <MetaLine label="SKU" value={firstItem?.sku} />
                <MetaLine label="Adet" value={firstItem ? String(firstItem.quantity) : null} />
                <MetaLine
                  label="Ödenen"
                  value={fmtMoney(detail.total, detail.currency)}
                />
                <MetaLine label="Buyer" value={detail.buyerUsername} />
              </div>
            </div>
          </div>

          {detail.items.length > 1 && (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 12, color: "var(--dim)", marginBottom: 6 }}>
                Diğer ürünler ({detail.items.length - 1})
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {detail.items.slice(1).map((it, idx) => (
                  <div key={idx} style={extraItemStyle} title={it.title}>
                    {it.title} · {it.quantity} adet
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Middle: operation card */}
        <div style={cardStyle}>
          <div style={cardTitleStyle}>Operasyon bilgileri</div>

          <label style={fieldLabelStyle}>
            <span>Operasyon durumu</span>
            <select
              value={operationStatus}
              onChange={(e) => {
                setOperationStatus(e.target.value as OperationStatus)
                setStatusDirty(true)
              }}
              style={inputStyle}
            >
              {OPERATION_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {OPERATION_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </label>

          <label style={fieldLabelStyle}>
            <span>Not</span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              style={textareaStyle}
              placeholder="İç not…"
            />
          </label>

          <label style={fieldLabelStyle}>
            <span>Amazon order number</span>
            <input
              value={amazonOrderNumber}
              onChange={(e) => setAmazonOrderNumber(e.target.value)}
              style={inputStyle}
              placeholder="114-1234567-1234567"
            />
            <span style={{ fontSize: 11, color: "var(--dim)", marginTop: 4 }}>
              Amazon order number kaydedildiğinde ilgili Amazon mailleri bu siparişe otomatik bağlanır.
            </span>
          </label>

          <label style={fieldLabelStyle}>
            <span>Amazon order link</span>
            <input
              value={amazonOrderUrl}
              onChange={(e) => setAmazonOrderUrl(e.target.value)}
              style={inputStyle}
              placeholder="https://www.amazon.com/gp/your-account/order-details…"
            />
            {amazonOrderUrl.trim() && (
              <a href={amazonOrderUrl.trim()} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>
                Open Amazon order
              </a>
            )}
          </label>

          <label style={fieldLabelStyle}>
            <span>Amazon final cost</span>
            <input
              value={amazonPurchasePrice}
              onChange={(e) => setAmazonPurchasePrice(e.target.value)}
              style={inputStyle}
              inputMode="decimal"
              placeholder="0.00"
            />
          </label>

          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving}
            style={{ ...primaryBtnStyle, opacity: saving ? 0.6 : 1, cursor: saving ? "not-allowed" : "pointer" }}
          >
            {saving ? "Kaydediliyor…" : "Kaydet"}
          </button>

          {saveNotice && (
            <div
              style={{
                ...inlineNoticeStyle,
                color: saveNotice.type === "success" ? "#6c9" : "#e88",
              }}
            >
              {saveNotice.text}
            </div>
          )}
        </div>

        {/* Right: address card */}
        <div style={cardStyle}>
          <div style={cardTitleStyle}>Müşteri adresi</div>
          {detail.address ? (
            <>
              <div style={addressBlockStyle}>
                {detail.address.name && <div>{detail.address.name}</div>}
                {detail.address.addressLine1 && <div>{detail.address.addressLine1}</div>}
                {detail.address.addressLine2 && <div>{detail.address.addressLine2}</div>}
                <div>
                  {[
                    [detail.address.city, detail.address.state].filter(Boolean).join(", "),
                    detail.address.postalCode,
                  ]
                    .filter(Boolean)
                    .join(" ")}
                </div>
                {detail.address.country && <div>{detail.address.country}</div>}
                {(() => {
                  const ph = detail.address.phoneDisplay || detail.address.phoneRaw || detail.address.phone
                  return ph ? <div>Tel: {ph}</div> : null
                })()}
              </div>
              <div style={quickActionsRowStyle}>
                <button type="button" onClick={() => void handleCopyAddress()} style={secondaryBtnStyle}>
                  Adresi kopyala
                </button>
                {(detail.address.phoneDisplay || detail.address.phoneRaw || detail.address.phone) && (
                  <button
                    type="button"
                    onClick={() =>
                      flashCopy(
                        (detail.address!.phoneDisplay || detail.address!.phoneRaw || detail.address!.phone)!
                      )
                    }
                    style={secondaryBtnStyle}
                  >
                    Telefonu kopyala
                  </button>
                )}
              </div>
              {copyNotice && <div style={{ ...inlineNoticeStyle, color: "#6c9" }}>Kopyalandı</div>}
            </>
          ) : (
            <div style={{ color: "var(--dim)", fontSize: 14 }}>Adres bilgisi bulunamadı.</div>
          )}

          <div style={{ ...quickActionsRowStyle, marginTop: 14 }}>
            <a
              href={`https://www.amazon.com/dp/${encodeURIComponent(firstItem?.asin ?? "")}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                ...secondaryBtnStyle,
                textDecoration: "none",
                textAlign: "center",
                pointerEvents: firstItem?.asin ? "auto" : "none",
                opacity: firstItem?.asin ? 1 : 0.5,
              }}
            >
              Amazon&apos;da aç
            </a>
            {firstItem?.asin && (
              <button type="button" onClick={() => flashCopy(firstItem.asin!)} style={secondaryBtnStyle}>
                ASIN kopyala
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Finance summary — eBay Order earnings + Amazon purchase price */}
      <div style={{ ...cardStyle, marginTop: 16 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 12 }}>
          <div style={{ ...cardTitleStyle, marginBottom: 0 }}>Sipariş finans özeti</div>
          <button
            type="button"
            onClick={() => orderId && void loadEarnings(orderId)}
            disabled={earningsLoading}
            style={{
              ...secondaryBtnStyle,
              padding: "4px 10px",
              fontSize: 11,
              opacity: earningsLoading ? 0.6 : 1,
              cursor: earningsLoading ? "default" : "pointer",
            }}
          >
            {earningsLoading ? "Güncelleniyor…" : "Yenile"}
          </button>
        </div>
        <div style={financeGridStyle}>
          <div>
            <div style={financeLabelStyle}>eBay Brüt Satış</div>
            <div style={financeValueStyle}>
              {fmtMoney(detail.finance?.ebayGrossSales ?? detail.total, detail.currency)}
            </div>
          </div>
          <div>
            <div style={financeLabelStyle}>eBay Kalan Tutar</div>
            <div style={financeValueStyle}>
              {earningsLoading
                ? "eBay finans verisi alınıyor…"
                : detail.finance?.status === "available" && detail.finance.ebayOrderEarnings != null
                  ? fmtMoney(detail.finance.ebayOrderEarnings, detail.finance.ebayOrderEarningsCurrency || detail.currency)
                  : detail.finance?.status === "not_ready"
                    ? "Henüz hazır değil"
                    : detail.finance?.status === "error"
                      ? "eBay finans verisi alınamadı"
                      : detail.finance?.status === "missing"
                        ? "Henüz alınmadı"
                        : "Henüz alınmadı"}
            </div>
            <div style={financeHintStyle}>eBay kesintileri ve tahsil edilen vergi sonrası</div>
            {detail.finance?.ebayOrderEarningsCheckedAt && detail.finance.status === "available" && (
              <div style={{ ...financeHintStyle, marginTop: 4 }}>
                eBay&apos;den güncellendi: {fmtDate(detail.finance.ebayOrderEarningsCheckedAt)}
              </div>
            )}
          </div>
          <div>
            <div style={financeLabelStyle}>Amazon Nihai Maliyet</div>
            <div style={financeValueStyle}>
              {detail.finance?.amazonFinalCost != null
                ? fmtMoney(detail.finance.amazonFinalCost, "USD")
                : detail.manual.amazonPurchasePrice != null
                  ? fmtMoney(detail.manual.amazonPurchasePrice, "USD")
                  : "Henüz bilinmiyor"}
            </div>
            <div style={financeHintStyle}>Doğrulanmış Amazon Grand Total veya manuel kayıt</div>
          </div>
          <div>
            <div style={financeLabelStyle}>Sipariş Kârı</div>
            <div style={financeValueStyle}>
              {detail.finance?.profit != null
                ? fmtMoney(detail.finance.profit, detail.finance.ebayOrderEarningsCurrency || detail.currency)
                : "Henüz bilinmiyor"}
            </div>
            <div style={financeHintStyle}>
              {detail.finance?.profitPercent != null
                ? `Kâr % ${detail.finance.profitPercent.toFixed(1)} (kalan tutar üzerinden)`
                : "Amazon maliyeti yoksa kâr hesaplanmaz"}
            </div>
          </div>
        </div>
      </div>

      <div style={{ ...cardStyle, marginTop: 16 }}>
        <div style={cardTitleStyle}>Takip</div>
        <div style={financeGridStyle}>
          <div>
            <div style={financeLabelStyle}>eBay Tracking</div>
            <div style={financeValueStyle}>
              {detail.tracking?.ebayTrackingNumber || "—"}
            </div>
            <div style={financeHintStyle}>
              {[detail.tracking?.ebayCarrier, detail.tracking?.ebayShipmentStatus].filter(Boolean).join(" · ") || "Fulfillment API"}
            </div>
          </div>
          <div>
            <div style={financeLabelStyle}>Source Status</div>
            <div style={financeValueStyle}>
              {detail.tracking?.amazonDeliveryStatus || "—"}
            </div>
            <div style={financeHintStyle}>
              {detail.tracking?.amazonEstimatedDelivery
                ? `ETA: ${detail.tracking.amazonEstimatedDelivery}`
                : "Amazon transactional email"}
            </div>
            {detail.tracking?.amazonDeliveredAt && (
              <div style={financeHintStyle}>Delivered: {fmtDate(detail.tracking.amazonDeliveredAt)}</div>
            )}
            {detail.tracking?.amazonDeliveryLocation && (
              <div style={financeHintStyle}>Location: {detail.tracking.amazonDeliveryLocation}</div>
            )}
            {detail.tracking?.amazonTrackingUrl && (
              <a href={detail.tracking.amazonTrackingUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12, display: "block", marginTop: 6 }}>
                Track package
              </a>
            )}
            {detail.tracking?.amazonShipmentId && (
              <div style={financeHintStyle}>shipmentId (not carrier tracking): {detail.tracking.amazonShipmentId}</div>
            )}
            {detail.tracking?.amazonPackageIndex && (
              <div style={financeHintStyle}>packageIndex: {detail.tracking.amazonPackageIndex}</div>
            )}
          </div>
        </div>
      </div>

      {/* Bottom: events */}
      <div style={{ ...cardStyle, marginTop: 16 }}>
        <div style={cardTitleStyle}>İşlem geçmişi</div>
        {detail.events.length === 0 ? (
          <div style={{ color: "var(--dim)", fontSize: 14 }}>Henüz işlem kaydı yok.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {detail.events.map((ev, idx) => (
              <div key={idx} style={eventRowStyle}>
                <span>{ev.message ?? ev.type}</span>
                <span style={{ color: "var(--dim)", fontSize: 12 }}>{fmtDate(ev.createdAt)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function MetaLine({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ fontSize: 11, color: "var(--dim)" }}>{label}</span>
      <span style={{ fontSize: 13, wordBreak: "break-word" }}>{value?.trim() || "—"}</span>
    </div>
  )
}

function ProductThumbnail({ src, alt }: { src: string | null; alt: string }) {
  const [errored, setErrored] = useState(false)
  if (!src?.trim() || errored) {
    return <div style={thumbPlaceholderStyle} aria-hidden="true" />
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={alt} style={thumbImageStyle} loading="lazy" onError={() => setErrored(true)} />
  )
}

const backLinkStyle: CSSProperties = {
  display: "inline-block",
  marginBottom: 16,
  color: "var(--dim)",
  textDecoration: "none",
  fontSize: 14,
}

const topRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: 12,
  marginBottom: 20,
}

const gridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
  gap: 16,
}

const cardStyle: CSSProperties = {
  border: "1px solid var(--border)",
  background: "var(--surface)",
  borderRadius: 10,
  padding: 18,
}

const cardTitleStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  color: "var(--dim)",
  marginBottom: 14,
}

const financeGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
  gap: 20,
}

const financeLabelStyle: CSSProperties = {
  fontSize: 12,
  color: "var(--dim)",
  marginBottom: 6,
  fontWeight: 600,
}

const financeValueStyle: CSSProperties = {
  fontSize: 22,
  fontWeight: 700,
  fontFamily: "'Syne', sans-serif",
  color: "var(--text)",
  letterSpacing: "-0.02em",
}

const financeHintStyle: CSSProperties = {
  fontSize: 11,
  color: "var(--dim)",
  marginTop: 6,
  lineHeight: 1.4,
}

const metaGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
  gap: 10,
  marginTop: 12,
}

const extraItemStyle: CSSProperties = {
  fontSize: 13,
  color: "var(--dim)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
}

const fieldLabelStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  fontSize: 12,
  color: "var(--dim)",
  marginBottom: 14,
}

const inputStyle: CSSProperties = {
  padding: "9px 12px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--bg, #0e0e10)",
  color: "inherit",
  fontSize: 14,
}

const textareaStyle: CSSProperties = {
  ...inputStyle,
  resize: "vertical",
  fontFamily: "inherit",
}

const primaryBtnStyle: CSSProperties = {
  padding: "10px 18px",
  borderRadius: 6,
  border: "none",
  background: "var(--accent, #3b82f6)",
  color: "#fff",
  fontWeight: 600,
  fontSize: 14,
}

const secondaryBtnStyle: CSSProperties = {
  padding: "9px 16px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "transparent",
  color: "inherit",
  fontWeight: 600,
  fontSize: 13,
  cursor: "pointer",
}

const inlineNoticeStyle: CSSProperties = {
  marginTop: 10,
  fontSize: 13,
}

const quickActionsRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 8,
  marginTop: 14,
}

const addressBlockStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  fontSize: 14,
  lineHeight: 1.5,
}

const eventRowStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 12,
  fontSize: 13,
  padding: "8px 0",
  borderBottom: "1px solid var(--border)",
}

const thumbImageStyle: CSSProperties = {
  width: 96,
  height: 96,
  flexShrink: 0,
  borderRadius: 8,
  objectFit: "cover",
  border: "1px solid var(--border)",
  background: "var(--surface)",
}

const thumbPlaceholderStyle: CSSProperties = {
  width: 96,
  height: 96,
  flexShrink: 0,
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "rgba(120,130,150,0.1)",
}

const emptyStateStyle: CSSProperties = {
  padding: "48px 24px",
  textAlign: "center",
  borderRadius: 8,
  border: "1px dashed var(--border)",
  background: "var(--surface)",
}

const badgeStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  padding: "5px 12px",
  borderRadius: 999,
  whiteSpace: "nowrap",
}

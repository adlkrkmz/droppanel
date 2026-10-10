"use client"

import { useEffect, useState } from "react"
import { createPortal } from "react-dom"
import { getRecommendedEbayPrice, postUpdateEbayPrice } from "@/lib/api"
import { isUiTurkish } from "@/lib/sourceStatusDisplay"

const mono: React.CSSProperties = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: "11px",
}

export type UpdateEbayPriceTarget = {
  catalogStateId: number
  currentEbayPrice?: number | null
  amazonPrice?: number | null
  sku?: string | null
}

type Props = {
  open: boolean
  storeCode: string
  target: UpdateEbayPriceTarget | null
  onClose: () => void
  onSaved: () => void
}

export function UpdateEbayPriceModal({ open, storeCode, target, onClose, onSaved }: Props) {
  const tr = isUiTurkish()
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [warnBelowRecommended, setWarnBelowRecommended] = useState(false)
  const [currentEbayPrice, setCurrentEbayPrice] = useState(0)
  const [amazonPrice, setAmazonPrice] = useState(0)
  const [markupPercent, setMarkupPercent] = useState(0)
  const [recommended, setRecommended] = useState(0)
  const [newPrice, setNewPrice] = useState("")

  useEffect(() => {
    if (!open || !target) return
    setFormError(null)
    setWarnBelowRecommended(false)
    setNewPrice("")
    setLoading(true)
    void getRecommendedEbayPrice(storeCode, target.catalogStateId)
      .then(data => {
        setCurrentEbayPrice(data.currentEbayPrice)
        setAmazonPrice(data.amazonPrice)
        setMarkupPercent(data.storeMarkupPercent)
        setRecommended(data.recommendedEbayPrice)
      })
      .catch(e => {
        setFormError(e instanceof Error ? e.message : "Failed to load pricing")
      })
      .finally(() => setLoading(false))
  }, [open, target?.catalogStateId, storeCode])

  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !saving) onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, saving, onClose])

  if (!open || !target || typeof document === "undefined") return null

  function validate(): string | null {
    const n = parseFloat(newPrice.trim())
    if (!newPrice.trim() || !Number.isFinite(n)) {
      return tr ? "Yeni fiyat boş olamaz" : "New price is required"
    }
    if (n <= 0) return tr ? "Fiyat 0'dan büyük olmalı" : "Price must be > 0"
    if (Math.abs(n - currentEbayPrice) < 0.005) {
      return tr ? "Fiyat değişmedi" : "Price unchanged"
    }
    return null
  }

  async function handleSave() {
    if (!target) return
    const err = validate()
    if (err) {
      setFormError(err)
      return
    }
    const n = parseFloat(newPrice.trim())
    if (recommended > 0 && n < recommended - 0.01) {
      setWarnBelowRecommended(true)
    }
    setSaving(true)
    setFormError(null)
    try {
      await postUpdateEbayPrice(storeCode, target.catalogStateId, n)
      onSaved()
      onClose()
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Update failed")
    } finally {
      setSaving(false)
    }
  }

  const overlay: React.CSSProperties = {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.55)",
    zIndex: 9999,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
  }

  const card: React.CSSProperties = {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 6,
    padding: 20,
    maxWidth: 420,
    width: "100%",
    boxShadow: "0 24px 48px rgba(0,0,0,0.45)",
    ...mono,
  }

  const label: React.CSSProperties = {
    color: "var(--dim)",
    fontSize: 10,
    textTransform: "uppercase",
    marginBottom: 4,
  }

  const readonly: React.CSSProperties = {
    padding: "8px 10px",
    background: "var(--bg)",
    border: "1px solid var(--border)",
    borderRadius: 3,
    color: "var(--sub)",
    marginBottom: 12,
  }

  return createPortal(
    <div style={overlay} onClick={() => { if (!saving) onClose() }}>
      <div style={card} onClick={e => e.stopPropagation()}>
        <h2 style={{ color: "var(--accent)", fontSize: 13, marginBottom: 12 }}>
          {tr ? "eBay Fiyatını Güncelle" : "Update eBay Price"}
        </h2>
        <p style={{ color: "var(--dim)", marginBottom: 16, lineHeight: 1.5 }}>
          {tr
            ? "Bu işlem eBay listing fiyatını günceller. Başlık, görsel ve stok değişmez."
            : "This updates the eBay listing price only. Title, images, and stock are unchanged."}
        </p>

        {loading ? (
          <p style={{ color: "var(--dim)" }}>Loading…</p>
        ) : (
          <>
            <div style={label}>{tr ? "Mevcut eBay Fiyatı" : "Current eBay Price"}</div>
            <div style={readonly}>${currentEbayPrice.toFixed(2)}</div>

            <div style={label}>{tr ? "Amazon Fiyatı" : "Amazon Price"}</div>
            <div style={readonly}>${amazonPrice.toFixed(2)}</div>

            <div style={label}>{tr ? "Mağaza Markup %" : "Store Markup %"}</div>
            <div style={readonly}>{markupPercent}%</div>

            <div style={label}>{tr ? "Önerilen eBay Fiyatı" : "Recommended eBay Price"}</div>
            <div style={{ ...readonly, color: "var(--accent)" }}>
              ${recommended.toFixed(2)}
            </div>

            <div style={label}>{tr ? "Yeni eBay Fiyatı" : "New eBay Price"}</div>
            <input
              type="number"
              min={0.01}
              step={0.01}
              value={newPrice}
              onChange={e => {
                setNewPrice(e.target.value)
                setWarnBelowRecommended(false)
              }}
              style={{
                width: "100%",
                padding: "8px 10px",
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: 3,
                color: "var(--text)",
                marginBottom: 8,
              }}
            />
            <button
              type="button"
              disabled={recommended <= 0}
              onClick={() => {
                setNewPrice(recommended.toFixed(2))
                setWarnBelowRecommended(false)
              }}
              style={{
                marginBottom: 12,
                padding: "6px 12px",
                border: "1px solid var(--border)",
                borderRadius: 3,
                background: "transparent",
                color: "var(--sub)",
                cursor: "pointer",
              }}
            >
              {tr ? "Önerilen fiyatı kullan" : "Use recommended price"}
            </button>

            {warnBelowRecommended && (
              <p style={{ color: "var(--warn)", marginBottom: 12 }}>
                {tr
                  ? "Bu fiyat ayarlı kâr oranının altında olabilir."
                  : "This price may be below your configured profit margin."}
              </p>
            )}
            {formError && (
              <p style={{ color: "var(--danger)", marginBottom: 12 }}>{formError}</p>
            )}
          </>
        )}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 8 }}>
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: "8px 14px",
              border: "1px solid var(--border)",
              borderRadius: 3,
              background: "transparent",
              color: "var(--sub)",
              cursor: "pointer",
            }}
          >
            {tr ? "İptal" : "Cancel"}
          </button>
          <button
            type="button"
            disabled={loading || saving}
            onClick={() => void handleSave()}
            style={{
              padding: "8px 14px",
              border: "none",
              borderRadius: 3,
              background: "var(--accent)",
              color: "#000",
              fontWeight: 700,
              cursor: saving ? "wait" : "pointer",
              opacity: loading || saving ? 0.6 : 1,
            }}
          >
            {saving
              ? tr
                ? "Kaydediliyor…"
                : "Saving…"
              : tr
                ? "Fiyatı Güncelle"
                : "Update price"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

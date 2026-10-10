"use client"

import { useEffect, useState } from "react"
import { createPortal } from "react-dom"
import { postKeepaCheckAsin, postUpdateSourceAsin } from "@/lib/api"
import type { KeepaCheckAsinResult } from "@/lib/api"
import { isUiTurkish } from "@/lib/sourceStatusDisplay"

const mono: React.CSSProperties = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: "11px",
}

const ASIN_RE = /^[A-Z0-9]{10}$/

/** Keepa statuses that must not block ASIN identity save. */
const SAVEABLE_KEEPA = new Set([
  "AMAZON_OK",
  "PRICE_UNCERTAIN",
  "CHECK_FAILED",
  "NO_PRICE",
  "REMOVED",
  "UNAVAILABLE",
])

function normalizeAsin(raw: string): string {
  return raw.trim().toUpperCase()
}

export type UpdateSourceAsinTarget = {
  catalogStateId: number
  currentAsin: string | null
  sku?: string | null
}

type Props = {
  open: boolean
  storeCode: string
  target: UpdateSourceAsinTarget | null
  onClose: () => void
  onSaved: (result: { newAsin: string; sourcePrice: number | null }) => void
}

export function UpdateSourceAsinModal({ open, storeCode, target, onClose, onSaved }: Props) {
  const tr = isUiTurkish()
  const [newAsin, setNewAsin] = useState("")
  const [checkResult, setCheckResult] = useState<KeepaCheckAsinResult | null>(null)
  const [checkError, setCheckError] = useState<string | null>(null)
  const [checkInfo, setCheckInfo] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setNewAsin("")
    setCheckResult(null)
    setCheckError(null)
    setCheckInfo(null)
    setFormError(null)
    setChecking(false)
    setSaving(false)
  }, [open, target?.catalogStateId])

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

  const currentAsin = target.currentAsin?.trim().toUpperCase() || "—"
  const normalized = normalizeAsin(newAsin)

  function validateInput(): string | null {
    if (!normalized) return tr ? "ASIN boş olamaz" : "ASIN cannot be empty"
    if (!ASIN_RE.test(normalized)) {
      return tr ? "ASIN 10 karakter (A-Z, 0-9) olmalı" : "ASIN must be 10 characters (A-Z, 0-9)"
    }
    if (currentAsin !== "—" && normalized === currentAsin) {
      return tr ? "Yeni ASIN mevcut ASIN ile aynı olamaz" : "New ASIN must differ from current ASIN"
    }
    return null
  }

  async function handleCheck() {
    const err = validateInput()
    if (err) {
      setFormError(err)
      setCheckResult(null)
      setCheckError(null)
      setCheckInfo(null)
      return
    }
    setFormError(null)
    setChecking(true)
    setCheckError(null)
    setCheckInfo(null)
    setCheckResult(null)
    try {
      const res = await postKeepaCheckAsin(normalized)
      setCheckResult(res)
      if (res.sourceStatus === "AMAZON_OK") {
        setCheckInfo(
          tr
            ? `Keepa: Amazon OK${res.price != null && Number.isFinite(res.price) ? ` — $${res.price.toFixed(2)}` : ""}`
            : `Keepa: Amazon OK${res.price != null && Number.isFinite(res.price) ? ` — $${res.price.toFixed(2)}` : ""}`
        )
      } else if (res.sourceStatus === "PRICE_UNCERTAIN") {
        setCheckInfo(
          tr
            ? "Keepa: PRICE_UNCERTAIN — ASIN kaydedilir; Amazon doğrulaması kuyruğa alınır. Belirsiz fiyat accepted price olarak yazılmaz."
            : "Keepa: PRICE_UNCERTAIN — ASIN will be saved; Amazon verification will be queued. Uncertain price is not written as accepted source price."
        )
      } else if (res.sourceStatus === "CHECK_FAILED") {
        setCheckInfo(
          tr
            ? "Keepa: teknik hata — ASIN yine kaydedilebilir; doğrulama/retry lifecycle kullanılır."
            : "Keepa: technical error — ASIN can still be saved; verification/retry lifecycle will be used."
        )
      } else {
        setCheckInfo(
          tr
            ? `Keepa: ${res.sourceStatus} — ASIN kaydedilebilir; mevcut doğrulama akışı devam eder.`
            : `Keepa: ${res.sourceStatus} — ASIN can be saved; existing verification flow continues.`
        )
      }
    } catch (e) {
      setCheckError(e instanceof Error ? e.message : "Keepa check failed")
      setCheckInfo(
        tr
          ? "Keepa teknik olarak yanıt vermedi. Geçerli formatlı ASIN yine kaydedilebilir."
          : "Keepa did not respond. A valid-format ASIN can still be saved."
      )
      setCheckResult({
        ok: true,
        asin: normalized,
        sourceStatus: "CHECK_FAILED",
        reason: e instanceof Error ? e.message : "Keepa check failed",
        price: null,
        primeOrFbaSignal: false,
      } as KeepaCheckAsinResult)
    } finally {
      setChecking(false)
    }
  }

  async function handleSave() {
    const row = target
    if (!row) return
    const err = validateInput()
    if (err) {
      setFormError(err)
      return
    }
    if (!checkResult || checkResult.asin !== normalized) {
      setFormError(tr ? "Önce ASIN kontrolü yapın" : "Run Check ASIN first")
      return
    }
    if (!SAVEABLE_KEEPA.has(String(checkResult.sourceStatus ?? "").toUpperCase())) {
      setFormError(tr ? "Bu Keepa sonucu ile kayıt desteklenmiyor" : "This Keepa result cannot be saved")
      return
    }
    setSaving(true)
    setFormError(null)
    try {
      const res = await postUpdateSourceAsin({
        storeCode,
        catalogStateId: row.catalogStateId,
        newAsin: normalized,
      })
      onSaved({ newAsin: res.newAsin, sourcePrice: res.sourcePrice })
      onClose()
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Save failed")
    } finally {
      setSaving(false)
    }
  }

  const canSave =
    Boolean(checkResult) &&
    checkResult!.asin === normalized &&
    SAVEABLE_KEEPA.has(String(checkResult!.sourceStatus ?? "").toUpperCase()) &&
    !checking &&
    !saving

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
        padding: 16,
      }}
      onMouseDown={e => {
        if (e.target === e.currentTarget && !saving) onClose()
      }}
    >
      <div
        style={{
          ...mono,
          width: "100%",
          maxWidth: 440,
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 6,
          padding: 20,
          boxShadow: "0 24px 48px rgba(0,0,0,0.45)",
        }}
        onMouseDown={e => e.stopPropagation()}
      >
        <h2 style={{ margin: "0 0 12px", fontSize: 13, color: "var(--accent)" }}>
          {tr ? "Kaynak ASIN Güncelle" : "Update Source ASIN"}
        </h2>

        <p style={{ margin: "0 0 16px", color: "var(--dim)", lineHeight: 1.5, fontSize: 10 }}>
          {tr
            ? "Bu işlem sadece paneldeki Amazon kaynak ASIN'i günceller. eBay başlık, görsel veya fiyat değişmez."
            : "This only updates the Amazon source ASIN in the panel. It does not change the eBay title, image, or price."}
        </p>

        <label style={{ display: "block", marginBottom: 12 }}>
          <span style={{ color: "var(--dim)", fontSize: 10 }}>{tr ? "Mevcut ASIN" : "Current ASIN"}</span>
          <input
            readOnly
            value={currentAsin}
            style={{
              display: "block",
              width: "100%",
              marginTop: 4,
              padding: "8px 10px",
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 3,
              color: "var(--sub)",
            }}
          />
        </label>

        <label style={{ display: "block", marginBottom: 12 }}>
          <span style={{ color: "var(--dim)", fontSize: 10 }}>{tr ? "Yeni ASIN" : "New ASIN"}</span>
          <input
            value={newAsin}
            onChange={e => {
              setNewAsin(e.target.value.toUpperCase())
              setCheckResult(null)
              setCheckError(null)
              setCheckInfo(null)
            }}
            maxLength={10}
            placeholder="B0XXXXXXXXX"
            style={{
              display: "block",
              width: "100%",
              marginTop: 4,
              padding: "8px 10px",
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 3,
              color: "var(--text)",
            }}
          />
        </label>

        {checkResult?.sourceStatus === "AMAZON_OK" ? (
          <div
            style={{
              marginBottom: 12,
              padding: "8px 10px",
              borderRadius: 3,
              border: "1px solid var(--accent)",
              color: "var(--accent)",
              fontSize: 10,
            }}
          >
            Amazon OK
            {checkResult.price != null && Number.isFinite(checkResult.price)
              ? ` — $${checkResult.price.toFixed(2)}`
              : ""}
          </div>
        ) : null}

        {checkInfo ? (
          <div style={{ marginBottom: 12, color: "var(--sub)", fontSize: 10, lineHeight: 1.45 }}>
            {checkInfo}
          </div>
        ) : null}

        {checkError ? (
          <div style={{ marginBottom: 12, color: "var(--warn)", fontSize: 10 }}>{checkError}</div>
        ) : null}

        {formError ? (
          <div style={{ marginBottom: 12, color: "var(--danger)", fontSize: 10 }}>{formError}</div>
        ) : null}

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={() => void handleCheck()}
            disabled={checking || saving}
            style={{
              padding: "8px 14px",
              border: "1px solid var(--border)",
              borderRadius: 3,
              background: "var(--bg)",
              color: "var(--text)",
              cursor: checking ? "wait" : "pointer",
            }}
          >
            {checking ? "…" : tr ? "ASIN'i Kontrol Et" : "Check ASIN"}
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={!canSave}
            style={{
              padding: "8px 14px",
              border: "none",
              borderRadius: 3,
              background: canSave ? "var(--accent)" : "var(--bg)",
              color: canSave ? "#000" : "var(--dim)",
              fontWeight: 700,
              cursor: canSave && !saving ? "pointer" : "not-allowed",
            }}
          >
            {saving ? "…" : tr ? "Kaydet" : "Save"}
          </button>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            style={{
              marginLeft: "auto",
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
        </div>
      </div>
    </div>,
    document.body
  )
}

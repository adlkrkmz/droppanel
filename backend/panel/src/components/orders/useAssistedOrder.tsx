"use client"

import { useCallback, useState, type CSSProperties } from "react"
import { getOrderAssist, setOrderAssistAsin } from "@/lib/api"
import {
  fetchAppOrderAssist,
  setAppOrderAssistAsin,
} from "@/lib/userAppClient"
import { startAssistedOrder } from "./assistedOrder"

export type AssistNote = { type: "success" | "error"; text: string } | null

function isAsinError(msg: string): boolean {
  return /asin bulunamad/i.test(msg)
}

function noteForResult(res: Awaited<ReturnType<typeof startAssistedOrder>>): string {
  if (res.ackFailed) return "Extension paketi kaydedemedi. Amazon yine de açıldı."
  if (res.extensionFound) return "Amazon açıldı."
  if (res.copied) return "Extension bulunamadı, bilgiler panoya kopyalandı."
  return "Amazon açıldı (extension bulunamadı)."
}

/**
 * Shared launcher for the assisted Amazon order flow.
 * - If ASIN exists, opens Amazon directly (autoRun).
 * - If backend returns 422 (ASIN bulunamadı), opens a manual ASIN modal.
 * - After manual ASIN saved, re-fetches the packet and launches.
 */
export function useAssistedOrder(useAppApi = false) {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<AssistNote>(null)

  // Manual ASIN modal state
  const [modalOrderId, setModalOrderId] = useState<number | null>(null)
  const [asinInput, setAsinInput] = useState("")
  const [asinError, setAsinError] = useState<string | null>(null)
  const [savingAsin, setSavingAsin] = useState(false)

  const runLaunch = useCallback(async (orderId: number) => {
    if (useAppApi) {
      const r = await fetchAppOrderAssist(orderId, true)
      if (!r.ok) throw new Error(r.error)
      const res = await startAssistedOrder(r.data)
      setNote({ type: res.ackFailed ? "error" : "success", text: noteForResult(res) })
      return
    }
    const packet = await getOrderAssist(orderId, true)
    const res = await startAssistedOrder(packet)
    setNote({ type: res.ackFailed ? "error" : "success", text: noteForResult(res) })
  }, [useAppApi])

  const launch = useCallback(
    async (orderId: number) => {
      if (busy) return
      setBusy(true)
      setNote(null)
      try {
        await runLaunch(orderId)
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Başlatılamadı."
        if (isAsinError(msg)) {
          setModalOrderId(orderId)
          setAsinInput("")
          setAsinError(null)
        } else {
          setNote({ type: "error", text: msg })
        }
      } finally {
        setBusy(false)
      }
    },
    [busy, runLaunch]
  )

  const closeModal = useCallback(() => {
    setModalOrderId(null)
    setAsinInput("")
    setAsinError(null)
  }, [])

  const submitAsin = useCallback(async () => {
    if (modalOrderId == null || savingAsin) return
    const asin = asinInput.trim().toUpperCase()
    if (!/^[A-Z0-9]{10}$/.test(asin)) {
      setAsinError("Geçerli 10 karakterli bir ASIN girin (ör. B0XXXXXXXX).")
      return
    }
    setSavingAsin(true)
    setAsinError(null)
    try {
      if (useAppApi) {
        const r = await setAppOrderAssistAsin(modalOrderId, asin)
        if (!r.ok) throw new Error(r.error)
      } else {
        await setOrderAssistAsin(modalOrderId, asin)
      }
      const orderId = modalOrderId
      closeModal()
      setBusy(true)
      await runLaunch(orderId)
    } catch (e) {
      setAsinError(e instanceof Error ? e.message : "ASIN kaydedilemedi.")
    } finally {
      setSavingAsin(false)
      setBusy(false)
    }
  }, [modalOrderId, savingAsin, asinInput, closeModal, runLaunch, useAppApi])

  const modal =
    modalOrderId != null ? (
      <div style={overlayStyle} role="dialog" aria-modal="true" onClick={closeModal}>
        <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
          <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>ASIN gerekli</div>
          <p style={{ color: "var(--dim)", fontSize: 13, lineHeight: 1.5, marginTop: 0 }}>
            Bu siparişte ASIN bulunamadı. Varyasyonlu ürün olabilir. Devam etmek için Amazon ASIN gir.
          </p>
          <input
            value={asinInput}
            onChange={(e) => setAsinInput(e.target.value.toUpperCase())}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submitAsin()
            }}
            placeholder="B0XXXXXXXX"
            maxLength={10}
            autoFocus
            style={modalInputStyle}
          />
          {asinError && (
            <div style={{ color: "#e88", fontSize: 12, marginTop: 6 }}>{asinError}</div>
          )}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
            <button type="button" onClick={closeModal} style={modalCancelStyle} disabled={savingAsin}>
              Vazgeç
            </button>
            <button
              type="button"
              onClick={() => void submitAsin()}
              style={{ ...modalSaveStyle, opacity: savingAsin ? 0.6 : 1 }}
              disabled={savingAsin}
            >
              {savingAsin ? "Kaydediliyor…" : "Kaydet ve başlat"}
            </button>
          </div>
        </div>
      </div>
    ) : null

  return { launch, busy, note, setNote, modal }
}

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.55)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
  padding: 16,
}

const modalStyle: CSSProperties = {
  width: "100%",
  maxWidth: 380,
  background: "var(--card, #16181d)",
  border: "1px solid var(--border, #2a2d34)",
  borderRadius: 12,
  padding: 20,
  color: "inherit",
}

const modalInputStyle: CSSProperties = {
  width: "100%",
  padding: "9px 12px",
  borderRadius: 6,
  border: "1px solid var(--border, #2a2d34)",
  background: "var(--bg, #0e0f12)",
  color: "inherit",
  fontSize: 14,
  letterSpacing: 1,
  textTransform: "uppercase",
  boxSizing: "border-box",
}

const modalCancelStyle: CSSProperties = {
  padding: "8px 14px",
  borderRadius: 6,
  border: "1px solid var(--border, #2a2d34)",
  background: "transparent",
  color: "inherit",
  fontWeight: 600,
  fontSize: 13,
  cursor: "pointer",
}

const modalSaveStyle: CSSProperties = {
  padding: "8px 14px",
  borderRadius: 6,
  border: "none",
  background: "var(--accent, #3b82f6)",
  color: "#fff",
  fontWeight: 600,
  fontSize: 13,
  cursor: "pointer",
}

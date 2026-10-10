"use client"

import { useEffect } from "react"
import { createPortal } from "react-dom"

type ConfirmModalProps = {
  open: boolean
  title: string
  message: string
  detail?: string
  confirmLabel?: string
  cancelLabel?: string
  busy?: boolean
  busyLabel?: string
  variant?: "danger" | "accent"
  onConfirm: () => void
  onCancel: () => void
}

const mono: React.CSSProperties = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: "11px",
}

export function ConfirmModal({
  open,
  title,
  message,
  detail,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  busy = false,
  busyLabel = "Please wait…",
  variant = "accent",
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
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
      if (e.key === "Escape" && !busy) onCancel()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, busy, onCancel])

  if (!open || typeof document === "undefined") return null

  const confirmBg = variant === "danger" ? "var(--danger)" : "var(--accent)"
  const confirmColor = variant === "danger" ? "#fff" : "#000"

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-modal-title"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        background: "rgba(0,0,0,0.6)",
      }}
      onClick={() => {
        if (!busy) onCancel()
      }}
    >
      <div
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          padding: "24px 28px",
          maxWidth: 420,
          width: "100%",
          boxShadow: "0 24px 48px rgba(0,0,0,0.45)",
          ...mono,
        }}
        onClick={e => e.stopPropagation()}
      >
        <h2
          id="confirm-modal-title"
          style={{ margin: "0 0 12px", fontSize: 14, color: "var(--text)" }}
        >
          {title}
        </h2>
        <p style={{ margin: "0 0 8px", color: "var(--sub)", lineHeight: 1.5, fontSize: 11 }}>
          {message}
        </p>
        {detail && (
          <p style={{ margin: "0 0 20px", color: "var(--dim)", lineHeight: 1.5, fontSize: 11 }}>
            {detail}
          </p>
        )}
        {!detail && <div style={{ marginBottom: 20 }} />}
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            style={{
              padding: "7px 14px",
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 3,
              color: "var(--text)",
              cursor: busy ? "not-allowed" : "pointer",
              ...mono,
            }}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            style={{
              padding: "7px 14px",
              background: confirmBg,
              color: confirmColor,
              border: "none",
              borderRadius: 3,
              fontWeight: 700,
              cursor: busy ? "not-allowed" : "pointer",
              opacity: busy ? 0.7 : 1,
              ...mono,
            }}
          >
            {busy ? busyLabel : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

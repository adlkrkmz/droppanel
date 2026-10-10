"use client"

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react"
import { createPortal } from "react-dom"

type InfoTooltipProps = {
  text: string
  label?: string
  /** Optional custom trigger; defaults to info icon button */
  children?: ReactNode
}

/**
 * Compact info / warning tooltip for Settings and other panel surfaces.
 * Opens on hover (desktop) and click/tap; closes on outside click / Escape.
 */
export function InfoTooltip({ text, label = "More info", children }: InfoTooltipProps) {
  const tipId = useId()
  const anchorRef = useRef<HTMLButtonElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  const place = useCallback(() => {
    const el = anchorRef.current
    const tip = tipRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const tipW = tip?.offsetWidth ?? 280
    const tipH = tip?.offsetHeight ?? 80
    const pad = 8
    let left = rect.left + rect.width / 2 - tipW / 2
    left = Math.max(pad, Math.min(left, window.innerWidth - tipW - pad))
    let top = rect.bottom + 8
    if (top + tipH > window.innerHeight - pad && rect.top - tipH - 8 >= pad) {
      top = rect.top - tipH - 8
    }
    setPos({ top, left })
  }, [])

  useEffect(() => {
    if (!open) return
    place()
    const onScroll = () => place()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false)
    }
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (anchorRef.current?.contains(t) || tipRef.current?.contains(t)) return
      setOpen(false)
    }
    window.addEventListener("resize", onScroll)
    window.addEventListener("scroll", onScroll, true)
    window.addEventListener("keydown", onKey)
    window.addEventListener("mousedown", onDown)
    return () => {
      window.removeEventListener("resize", onScroll)
      window.removeEventListener("scroll", onScroll, true)
      window.removeEventListener("keydown", onKey)
      window.removeEventListener("mousedown", onDown)
    }
  }, [open, place])

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        aria-label={label}
        aria-describedby={open ? tipId : undefined}
        aria-expanded={open}
        onClick={() => setOpen(v => !v)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        style={triggerStyle}
      >
        {children ?? (
          <span aria-hidden="true" style={iconGlyphStyle}>
            !
          </span>
        )}
      </button>
      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={tipRef}
            id={tipId}
            role="tooltip"
            style={{
              ...tooltipStyle,
              top: pos?.top ?? -9999,
              left: pos?.left ?? -9999,
              visibility: pos ? "visible" : "hidden",
            }}
            onMouseEnter={() => setOpen(true)}
            onMouseLeave={() => setOpen(false)}
          >
            {text}
          </div>,
          document.body
        )}
    </>
  )
}

const triggerStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 18,
  height: 18,
  marginLeft: 6,
  padding: 0,
  borderRadius: "50%",
  border: "1px solid var(--border, #2a2a2a)",
  background: "transparent",
  color: "var(--dim, #888)",
  cursor: "help",
  verticalAlign: "middle",
  flexShrink: 0,
  lineHeight: 1,
}

const iconGlyphStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  fontFamily: "inherit",
}

const tooltipStyle: CSSProperties = {
  position: "fixed",
  zIndex: 10000,
  maxWidth: 300,
  padding: "10px 12px",
  borderRadius: 8,
  border: "1px solid var(--border, #2a2a2a)",
  background: "var(--surface, #111)",
  color: "var(--text, #e8e8e8)",
  fontSize: 12,
  lineHeight: 1.45,
  boxShadow: "0 12px 32px rgba(0,0,0,0.45)",
  pointerEvents: "auto",
}

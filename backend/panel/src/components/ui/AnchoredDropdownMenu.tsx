"use client"

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react"
import { createPortal } from "react-dom"

const MENU_GAP = 6
const VIEWPORT_PAD = 8
const MENU_Z_INDEX = 9999

let activeMenuClose: (() => void) | null = null

function claimMenu(close: () => void): void {
  if (activeMenuClose && activeMenuClose !== close) activeMenuClose()
  activeMenuClose = close
}

function releaseMenu(close: () => void): void {
  if (activeMenuClose === close) activeMenuClose = null
}

type MenuPosition = {
  top:      number
  left:     number
  minWidth: number
}

function computeMenuPosition(
  anchorRect: DOMRect,
  menuEl:     HTMLElement | null,
  minWidth:   number
): MenuPosition {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const menuWidth = Math.max(minWidth, menuEl?.offsetWidth ?? minWidth)
  const menuHeight = menuEl?.offsetHeight ?? 0

  let left = anchorRect.right - menuWidth
  if (left < VIEWPORT_PAD) left = VIEWPORT_PAD
  if (left + menuWidth > vw - VIEWPORT_PAD) {
    left = Math.max(VIEWPORT_PAD, vw - VIEWPORT_PAD - menuWidth)
  }

  let top = anchorRect.bottom + MENU_GAP
  if (menuHeight > 0 && top + menuHeight > vh - VIEWPORT_PAD) {
    const aboveTop = anchorRect.top - MENU_GAP - menuHeight
    if (aboveTop >= VIEWPORT_PAD) top = aboveTop
    else top = Math.max(VIEWPORT_PAD, vh - VIEWPORT_PAD - menuHeight)
  }

  return { top, left, minWidth }
}

export type AnchoredDropdownMenuProps = {
  ariaLabel:      string
  disabled?:        boolean
  minWidth?:        number
  buttonStyle?:     CSSProperties
  buttonChildren:   ReactNode
  children:         (close: () => void) => ReactNode
}

export function AnchoredDropdownMenu({
  ariaLabel,
  disabled = false,
  minWidth = 180,
  buttonStyle,
  buttonChildren,
  children,
}: AnchoredDropdownMenuProps) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<MenuPosition>({ top: 0, left: 0, minWidth })
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const close = useCallback(() => {
    setOpen(false)
    releaseMenu(close)
  }, [])

  const updatePosition = useCallback(() => {
    const anchor = buttonRef.current
    if (!anchor) return
    setPos(computeMenuPosition(anchor.getBoundingClientRect(), menuRef.current, minWidth))
  }, [minWidth])

  const toggle = useCallback(() => {
    if (disabled) return
    setOpen(prev => {
      const next = !prev
      if (next) claimMenu(close)
      else releaseMenu(close)
      return next
    })
  }, [close, disabled])

  useLayoutEffect(() => {
    if (!open) return
    updatePosition()
    const raf = requestAnimationFrame(() => updatePosition())
    return () => cancelAnimationFrame(raf)
  }, [open, updatePosition])

  useEffect(() => {
    if (!open) return
    const onScroll = () => updatePosition()
    const onResize = () => updatePosition()
    window.addEventListener("scroll", onScroll, true)
    window.addEventListener("resize", onResize)
    return () => {
      window.removeEventListener("scroll", onScroll, true)
      window.removeEventListener("resize", onResize)
    }
  }, [open, updatePosition])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [open, close])

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node
      if (buttonRef.current?.contains(target)) return
      if (menuRef.current?.contains(target)) return
      close()
    }
    document.addEventListener("mousedown", onDoc)
    return () => document.removeEventListener("mousedown", onDoc)
  }, [open, close])

  useEffect(() => () => releaseMenu(close), [close])

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="menu"
        disabled={disabled}
        onClick={toggle}
        style={buttonStyle}
      >
        {buttonChildren}
      </button>
      {open && typeof document !== "undefined" && createPortal(
        <div
          ref={menuRef}
          className="admin-row-action-menu-portal"
          role="menu"
          style={{
            position:  "fixed",
            top:         pos.top,
            left:        pos.left,
            minWidth:    pos.minWidth,
            zIndex:      MENU_Z_INDEX,
            background:  "var(--surface)",
            border:      "1px solid var(--border)",
            borderRadius: "4px",
            boxShadow:   "0 8px 24px rgba(0,0,0,0.35)",
            overflow:    "hidden",
          }}
        >
          {children(close)}
        </div>,
        document.body
      )}
    </>
  )
}

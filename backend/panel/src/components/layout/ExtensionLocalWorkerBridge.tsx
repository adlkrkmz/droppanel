"use client"

import { useEffect } from "react"

const EXTENSION_IDS = [
  "ncegpfpjfgemblbcpnbobeaobkannlfk",
  "mbfcaobihakmmmafjpbfiamphjgdjbok",
  "cagdhkibfggpeplddbglijkfhekkejpo",
]

function apiBase(): string {
  return (process.env.NEXT_PUBLIC_API_BASE || process.env.BACKEND_API_BASE || "http://localhost:4000").replace(/\/$/, "")
}

export default function ExtensionLocalWorkerBridge() {
  useEffect(() => {
    const runtime = (window as unknown as { chrome?: { runtime?: { connect?: (id: string) => Port } } }).chrome?.runtime
    const runtimeConnect = runtime?.connect
    if (!runtimeConnect) return
    const ports: Port[] = []
    const connect = (id: string) => {
      try {
        const port = runtimeConnect(id)
        ports.push(port)
        port.onMessage.addListener((msg: ProxyMsg) => {
          void handleProxy(port, msg)
        })
        port.postMessage({ type: "PANEL_READY" })
      } catch {
        /* extension not installed in this profile */
      }
    }
    EXTENSION_IDS.forEach(connect)
    return () => {
      for (const port of ports) {
        try { port.disconnect() } catch { /* ignore */ }
      }
    }
  }, [])
  return null
}

type Port = {
  postMessage: (msg: unknown) => void
  disconnect: () => void
  onMessage: { addListener: (fn: (msg: ProxyMsg) => void) => void }
}

type ProxyMsg = {
  type?: string
  id?: number
  method?: string
  path?: string
  body?: unknown
}

async function handleProxy(port: Port, msg: ProxyMsg) {
  if (!msg || msg.type !== "PROXY_FETCH" || msg.id == null || !msg.method || !msg.path) return
  try {
    const session = await fetch("/api/extension/session", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" } })
    const tok = await session.json().catch(() => ({})) as { accessToken?: string }
    if (!session.ok || !tok.accessToken) {
      port.postMessage({ id: msg.id, ok: false, status: session.status, data: tok })
      return
    }
    const response = await fetch(apiBase() + msg.path, {
      method: msg.method,
      credentials: "omit",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok.accessToken}` },
      body: msg.body !== undefined ? JSON.stringify(msg.body) : undefined,
    })
    const data = await response.json().catch(() => null)
    port.postMessage({ id: msg.id, ok: response.ok, status: response.status, data })
  } catch (e) {
    port.postMessage({ id: msg.id, ok: false, status: 0, data: { error: e instanceof Error ? e.message : String(e) } })
  }
}

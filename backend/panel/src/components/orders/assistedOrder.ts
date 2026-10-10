import type { AssistedOrderPacket, OrderAddress } from "@/lib/api"

// Panel → extension bridge namespace (matches extension panelBridge.js handler).
const PANEL_SOURCE = "listjetgo-panel"
const EXT_SOURCE = "listjetgo-extension"
const ASSIST_START_TYPE = "ASSISTED_ORDER_START"
const ASSIST_STORED_TYPE = "ASSISTED_ORDER_STORED"
const ASSIST_FAILED_TYPE = "ASSISTED_ORDER_STORE_FAILED"
const ACK_TIMEOUT_MS = 2500

export function formatAmazonAddress(addr: OrderAddress | null): string {
  if (!addr) return ""
  const lines: string[] = []
  if (addr.name) lines.push(addr.name)
  if (addr.addressLine1) lines.push(addr.addressLine1)
  if (addr.addressLine2) lines.push(addr.addressLine2)
  const cityState = [addr.city, addr.state].filter(Boolean).join(", ")
  const cityZip = [cityState, addr.postalCode].filter(Boolean).join(" ")
  if (cityZip.trim()) lines.push(cityZip.trim())
  if (addr.country) lines.push(addr.country)
  const phone = addr.phoneDisplay || addr.phoneRaw || addr.phone
  if (phone) lines.push(phone)
  return lines.join("\n")
}

export async function copyToClipboard(text: string): Promise<boolean> {
  if (!text) return false
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/** Detect the ListJetGo extension via the existing DP bridge ready handshake. */
function detectExtension(timeoutMs = 700): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof window === "undefined") {
      resolve(false)
      return
    }
    let settled = false
    const onMsg = (e: MessageEvent) => {
      if (e.source !== window) return
      if (e.data?.type === "DP_EXTENSION_READY") {
        finish(true)
      }
    }
    const finish = (val: boolean) => {
      if (settled) return
      settled = true
      window.removeEventListener("message", onMsg)
      resolve(val)
    }
    window.addEventListener("message", onMsg)
    window.postMessage({ type: "DP_PING" }, "*")
    setTimeout(() => finish(false), timeoutMs)
  })
}

function makeRequestId(orderId: number | string): string {
  return `${orderId}-${Date.now()}`
}

type AckResult = "ok" | "fail" | "timeout"

/** Wait for panelBridge ACK — listener MUST be registered before postMessage. */
function waitForAssistAck(requestId: string, timeoutMs = ACK_TIMEOUT_MS): Promise<AckResult> {
  return new Promise((resolve) => {
    let settled = false
    const onMsg = (e: MessageEvent) => {
      if (e.source !== window) return
      const d = e.data
      if (!d || d.source !== EXT_SOURCE) return
      if (d.requestId !== requestId) return
      if (d.type === ASSIST_STORED_TYPE && d.ok !== false) {
        finish("ok")
        return
      }
      if (d.type === ASSIST_FAILED_TYPE) {
        finish("fail")
      }
    }
    const finish = (val: AckResult) => {
      if (settled) return
      settled = true
      window.removeEventListener("message", onMsg)
      resolve(val)
    }
    window.addEventListener("message", onMsg)
    setTimeout(() => finish("timeout"), timeoutMs)
  })
}

const PACKET_TTL_MS = 10 * 60 * 1000

function buildSummaryText(packet: AssistedOrderPacket): string {
  const parts = [
    `ASIN: ${packet.asin}`,
    `Adet: ${packet.quantity}`,
    `eBay Order: ${packet.ebayOrderId}`,
    packet.amazonProductUrl,
  ]
  const addr = formatAmazonAddress(packet.shippingAddress)
  if (addr) parts.push("", addr)
  return parts.join("\n")
}

export type AssistStartResult = {
  extensionFound: boolean
  copied: boolean
  ackReceived: boolean
  ackFailed: boolean
}

/**
 * Start the assisted Amazon order flow:
 *  - register ACK listener, then postMessage to extension,
 *  - wait for ASSISTED_ORDER_STORED (or timeout),
 *  - do NOT open Amazon tabs — extension background owns the single tab.
 */
export async function startAssistedOrder(
  packet: AssistedOrderPacket
): Promise<AssistStartResult> {
  const extensionFound = await detectExtension()
  const startedAt = Date.now()
  const requestId = makeRequestId(packet.orderId)
  // Stamp the activation guard fields so the extension only runs fresh,
  // panel-initiated commands (and ignores stale/manually-browsed pages).
  const pkt: AssistedOrderPacket = {
    ...packet,
    autoRun: true,
    requestId,
    source: "panel",
    userInitiated: true,
    startedAt,
    expiresAt: startedAt + PACKET_TTL_MS,
  }
  let ackReceived = false
  let ackFailed = false

  if (extensionFound) {
    console.log("[ListJetGo assistedOrder] start request", {
      requestId,
      orderId: pkt.orderId,
      asin: pkt.asin,
    })

    // Listener BEFORE postMessage — avoids missing a fast ACK.
    const ackPromise = waitForAssistAck(requestId, ACK_TIMEOUT_MS)
    window.postMessage(
      { source: PANEL_SOURCE, type: ASSIST_START_TYPE, requestId, packet: pkt },
      "*"
    )

    const ack = await ackPromise
    if (ack === "ok") {
      ackReceived = true
      console.log("[ListJetGo assistedOrder] ACK received", { requestId })
    } else if (ack === "fail") {
      ackFailed = true
      console.warn("[ListJetGo assistedOrder] ACK store failed", { requestId })
    } else {
      console.warn("[ListJetGo assistedOrder] ACK timeout — extension may still open Address Book", { requestId })
    }
  }

  let copied = false
  if (!extensionFound) {
    copied = await copyToClipboard(buildSummaryText(packet))
  }

  // Amazon tab/window is opened only by the extension background (Address Book first).
  return { extensionFound, copied, ackReceived, ackFailed }
}

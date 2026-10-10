"use client"

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { fetchAuthMe, type UserPublic } from "@/lib/userAuthClient"
import {
  ensureAppBuyerMessageNotifications,
  fetchAppBuyerMessageNotifications,
  fetchAppCustomerServiceConversation,
  fetchAppCustomerServiceConversations,
  fetchAppStores,
  replyAppCustomerServiceConversation,
  startAppEbayReconnect,
  type AppStoreSummary,
} from "@/lib/userAppClient"
import { NoStoreEmptyState } from "@/components/app/NoStoreEmptyState"
import {
  adoptStoreSelection,
  parseUrlStoreId,
  storeCodeForId,
  useAppStoreSelection,
} from "@/lib/appStoreSelection"

type ConversationRow = {
  conversationId: string
  conversationType: "FROM_MEMBERS" | "FROM_EBAY"
  conversationStatus: string | null
  subject: string | null
  counterpartyDisplay: string
  lastPreview: string | null
  lastMessageAt: string | null
  unreadCount: number
  listingItemId: string | null
  relatedEbayOrderId: string | null
  relatedOrderId: number | null
}

type MessageRow = {
  messageId: string | null
  messageBody: string | null
  createdDate: string | null
  senderDisplay: string
  recipientDisplay: string
  readStatus: boolean | null
  subject: string | null
  media: Array<{ mediaName: string | null; mediaType: string | null; mediaUrl: string | null }>
}

type NotificationStatus = {
  messageScopeGranted: boolean
  notificationUserScopeGranted: boolean
  destination: { endpoint: string; destinationId: string | null; configured: boolean }
  topics: Array<{
    topicId: string
    status: string
    subscriptionId: string | null
    topicScope: string | null
    error: string | null
  }>
  inboxUnreadHint: number
  lastNotificationTopic: string | null
  lastNotificationAt: string | null
  error?: string | null
}

const selectStyle: CSSProperties = {
  background: "var(--surface)",
  color: "var(--text)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  padding: "8px 10px",
  fontSize: 13,
}

function fmtDate(s: string | null | undefined): string {
  if (!s?.trim()) return "—"
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return s
  return d.toLocaleString()
}

function resizeComposer(el: HTMLTextAreaElement): void {
  el.style.height = "88px"
  el.style.height = `${Math.min(160, Math.max(88, el.scrollHeight))}px`
}

export default function BuyerMessagesPage() {
  const router = useRouter()
  const { selectedStoreId, setSelectedStoreId, isStoreSelectionReady } = useAppStoreSelection()
  const selectedStoreIdRef = useRef(selectedStoreId)
  selectedStoreIdRef.current = selectedStoreId
  const sendingRef = useRef(false)
  const selectedIdRef = useRef<string | null>(null)

  const [user, setUser] = useState<UserPublic | null>(null)
  const [stores, setStores] = useState<AppStoreSummary[]>([])
  const [storeCode, setStoreCode] = useState("")
  const [loading, setLoading] = useState(true)
  const [listLoading, setListLoading] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const [reconnectBusy, setReconnectBusy] = useState(false)
  const [notifyBusy, setNotifyBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sendStatus, setSendStatus] = useState<string | null>(null)
  const [reconnectRequired, setReconnectRequired] = useState(false)
  const [conversations, setConversations] = useState<ConversationRow[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedType, setSelectedType] = useState<"FROM_MEMBERS" | "FROM_EBAY">("FROM_MEMBERS")
  const [messages, setMessages] = useState<MessageRow[]>([])
  const [detailSubject, setDetailSubject] = useState<string | null>(null)
  const [replyText, setReplyText] = useState("")
  const [notifyStatus, setNotifyStatus] = useState<NotificationStatus | null>(null)

  selectedIdRef.current = selectedId

  const loadNotifications = useCallback(async (code: string, ensure = false) => {
    if (!code) return
    const result = ensure
      ? await ensureAppBuyerMessageNotifications(code)
      : await fetchAppBuyerMessageNotifications(code)
    if (!result.ok) {
      setNotifyStatus(null)
      return
    }
    setNotifyStatus({
      messageScopeGranted: result.data.messageScopeGranted,
      notificationUserScopeGranted: result.data.notificationUserScopeGranted,
      destination: result.data.destination,
      topics: result.data.topics,
      inboxUnreadHint: result.data.inboxUnreadHint,
      lastNotificationTopic: result.data.lastNotificationTopic,
      lastNotificationAt: result.data.lastNotificationAt,
      error: typeof result.data.error === "string" ? result.data.error : null,
    })
  }, [])

  const loadList = useCallback(async (code: string, opts?: { keepSelection?: boolean }) => {
    if (!code) return
    setListLoading(true)
    setError(null)
    const result = await fetchAppCustomerServiceConversations(code, { limit: 25, offset: 0 })
    setListLoading(false)
    if (!result.ok) {
      if (result.status === 401) {
        router.replace("/app/login")
        return
      }
      setError(result.error)
      setConversations([])
      return
    }
    setReconnectRequired(result.data.reconnectRequired)
    setConversations(result.data.conversations)
    const keepId = opts?.keepSelection ? selectedIdRef.current : null
    const stillThere = keepId
      ? result.data.conversations.some(row => row.conversationId === keepId)
      : false
    if (!stillThere) {
      setSelectedId(null)
      setMessages([])
      setDetailSubject(null)
      setReplyText("")
    }
    void loadNotifications(code, false)
  }, [router, loadNotifications])

  const loadDetail = useCallback(async (code: string, id: string, type: "FROM_MEMBERS" | "FROM_EBAY") => {
    setDetailLoading(true)
    setError(null)
    const result = await fetchAppCustomerServiceConversation(code, id, type)
    setDetailLoading(false)
    if (!result.ok) {
      setError(result.error)
      setMessages([])
      return
    }
    setMessages(result.data.messages)
    setDetailSubject(result.data.subject)
  }, [])

  const init = useCallback(async () => {
    setLoading(true)
    const u = await fetchAuthMe()
    if (!u) {
      router.replace("/app/login")
      return
    }
    if (u.approvalStatus !== "active") {
      router.replace(u.approvalStatus === "pending_approval" ? "/pending-approval" : "/app/login")
      return
    }
    setUser(u)
    const storesResult = await fetchAppStores()
    if (!storesResult.ok) {
      setError(storesResult.error)
      setLoading(false)
      return
    }
    const list = storesResult.data.stores
    setStores(list)
    if (list.length === 0) {
      setLoading(false)
      return
    }
    const params = new URLSearchParams(window.location.search)
    const adopted = adoptStoreSelection(list, {
      providerStoreId: selectedStoreIdRef.current,
      urlStoreId: parseUrlStoreId(params.get("storeId")),
      urlStoreCode: params.get("storeCode")?.trim() || null,
    })
    if (adopted.shouldWriteProvider && adopted.storeId != null) {
      setSelectedStoreId(adopted.storeId)
    }
    const validCode = storeCodeForId(list, adopted.storeId)
    setStoreCode(validCode)
    setLoading(false)
    await loadList(validCode)
  }, [router, loadList, setSelectedStoreId])

  useEffect(() => {
    if (!isStoreSelectionReady) return
    void init()
  }, [isStoreSelectionReady, init])

  useEffect(() => {
    if (!isStoreSelectionReady || loading || stores.length === 0) return
    if (selectedStoreId == null) return
    const code = storeCodeForId(stores, selectedStoreId)
    if (!code || code === storeCode) return
    setStoreCode(code)
    const url = new URL(window.location.href)
    url.searchParams.set("storeCode", code)
    window.history.replaceState(null, "", url.pathname + url.search)
    void loadList(code)
  }, [selectedStoreId, stores, isStoreSelectionReady, loading, storeCode, loadList])

  function handleStoreChange(storeIdRaw: string) {
    const id = Number(storeIdRaw)
    const store = stores.find(s => s.storeId === id)
    if (!store) return
    setSelectedStoreId(id)
    setStoreCode(store.storeCode)
    const url = new URL(window.location.href)
    url.searchParams.set("storeCode", store.storeCode)
    window.history.replaceState(null, "", url.pathname + url.search)
    void loadList(store.storeCode)
  }

  async function openConversation(row: ConversationRow) {
    setSelectedId(row.conversationId)
    setSelectedType(row.conversationType)
    setReplyText("")
    setSendStatus(null)
    await loadDetail(storeCode, row.conversationId, row.conversationType)
  }

  async function sendReply() {
    if (sendingRef.current || sending || !selectedId || !storeCode) return
    const text = replyText.trim()
    if (!text) {
      setSendStatus("Error: message is empty")
      return
    }
    sendingRef.current = true
    setSending(true)
    setSendStatus("Sending...")
    const result = await replyAppCustomerServiceConversation({
      storeCode,
      conversationId: selectedId,
      messageText: text,
    })
    sendingRef.current = false
    setSending(false)
    if (!result.ok) {
      setSendStatus(`Error: ${result.error}`)
      return
    }
    setReplyText("")
    setSendStatus("Success")
    await loadDetail(storeCode, selectedId, selectedType)
  }

  async function handleReconnect() {
    const store = stores.find(s => s.storeCode === storeCode)
    if (!store || reconnectBusy) return
    setReconnectBusy(true)
    const result = await startAppEbayReconnect(store.storeId)
    setReconnectBusy(false)
    if (!result.ok) {
      setError(result.error || "Reconnect could not start.")
      return
    }
    window.location.href = result.data.authUrl
  }

  async function handleEnsureNotifications() {
    if (!storeCode || notifyBusy) return
    setNotifyBusy(true)
    await loadNotifications(storeCode, true)
    setNotifyBusy(false)
  }

  if (loading) {
    return <div style={{ padding: 48, textAlign: "center", color: "var(--dim)" }}>Loading…</div>
  }
  if (!user) return null

  const hasStores = stores.length > 0
  const selectedStore = stores.find(s => s.storeCode === storeCode)
  const selectedRow = conversations.find(row => row.conversationId === selectedId) ?? null
  const notifyMissingUserScope = Boolean(
    notifyStatus &&
    notifyStatus.topics.some(t => t.status === "MISSING_SCOPE")
  )

  return (
    <div className="app-cs-messages">
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 8 }}>
        <div>
          <h1 style={{ fontFamily: "'Syne', sans-serif", margin: 0, fontSize: 22 }}>Buyer Messages</h1>
          <p style={{ color: "var(--dim)", margin: "4px 0 0", fontSize: 13 }}>
            Member conversations for the selected store. Manual reply only.
          </p>
        </div>
      </div>

      {!hasStores && <NoStoreEmptyState />}

      {hasStores && (
        <>
          <div className="app-cs-messages-toolbar">
            <select
              value={selectedStoreId != null ? String(selectedStoreId) : ""}
              onChange={e => handleStoreChange(e.target.value)}
              aria-label="Store"
              style={selectStyle}
            >
              {stores.map(s => (
                <option key={s.storeId} value={s.storeId}>
                  {s.storeCode} — {s.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              style={selectStyle}
              onClick={() => void loadList(storeCode, { keepSelection: true })}
              disabled={listLoading}
            >
              {listLoading ? "Refreshing…" : "Refresh"}
            </button>
            <button
              type="button"
              style={selectStyle}
              onClick={() => void handleEnsureNotifications()}
              disabled={notifyBusy || reconnectRequired}
            >
              {notifyBusy ? "Checking notifications…" : "Check notifications"}
            </button>
            {notifyStatus && notifyStatus.inboxUnreadHint > 0 && (
              <span className="app-cs-badge">{notifyStatus.inboxUnreadHint} new event(s)</span>
            )}
          </div>

          {error && <p style={{ color: "#f87171", fontSize: 13, margin: 0 }}>{error}</p>}
          {reconnectRequired && (
            <div style={{ border: "1px solid rgba(248,113,113,0.5)", borderRadius: 8, padding: 12 }}>
              <strong>eBay message permission required</strong>
              <p style={{ margin: "8px 0 12px", fontSize: 13, color: "var(--dim)" }}>
                This store is missing commerce.message. Reconnect eBay once so Message API can load conversations.
              </p>
              <button type="button" className="app-shell-logout-btn" onClick={() => void handleReconnect()} disabled={reconnectBusy}>
                {reconnectBusy ? "Yönlendiriliyor…" : "Reconnect eBay"}
              </button>
            </div>
          )}
          {notifyStatus && (
            <div style={{ fontSize: 12, color: "var(--dim)" }}>
              Notifications: destination {notifyStatus.destination.destinationId ? "ready" : "not registered"}
              {notifyStatus.topics.map(t => (
                <span key={t.topicId}> · {t.topicId} {t.status}</span>
              ))}
              {notifyMissingUserScope && (
                <div style={{ marginTop: 4, color: "#fbbf24" }}>
                  NEW_MESSAGE / BUYER_QUESTION are USER topics (commerce.message). Subscriptions also need PUT /commerce/notification/v1/config alertEmail.
                </div>
              )}
              {notifyStatus.error && (
                <div style={{ marginTop: 4, color: "#f87171" }}>{notifyStatus.error}</div>
              )}
            </div>
          )}

          <div className="app-cs-messages-panes">
            <div className="app-cs-messages-list">
              <div className="app-cs-messages-list-scroll">
                {conversations.length === 0 ? (
                  <p style={{ padding: 16, color: "var(--dim)", fontSize: 13 }}>
                    {reconnectRequired ? "Reconnect to load conversations." : "No member conversations."}
                  </p>
                ) : (
                  conversations.map(row => (
                    <button
                      key={row.conversationId}
                      type="button"
                      onClick={() => void openConversation(row)}
                      className={[
                        "app-cs-messages-item",
                        selectedId === row.conversationId ? "app-cs-messages-item--selected" : "",
                        row.unreadCount > 0 ? "app-cs-messages-item--unread" : "",
                      ].join(" ")}
                    >
                      <div style={{ fontSize: 13 }}>{row.counterpartyDisplay}</div>
                      <div style={{ fontSize: 12, color: "var(--dim)", marginTop: 4 }}>{row.subject || "No subject"}</div>
                      <div style={{ fontSize: 12, marginTop: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {row.lastPreview || "—"}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--dim)", marginTop: 6 }}>
                        {fmtDate(row.lastMessageAt)}
                        {row.unreadCount > 0 ? ` · ${row.unreadCount} unread` : " · read"}
                      </div>
                    </button>
                  ))
                )}
              </div>
            </div>

            <div className="app-cs-messages-detail">
              {!selectedId || !selectedRow ? (
                <p style={{ padding: 16, color: "var(--dim)", fontSize: 13 }}>Select a conversation.</p>
              ) : (
                <>
                  <div className="app-cs-messages-header">
                    <div style={{ fontSize: 16, fontWeight: 600 }}>{selectedRow.counterpartyDisplay}</div>
                    <div style={{ fontSize: 13, color: "var(--dim)", marginTop: 4 }}>
                      {detailSubject || selectedRow.subject || "No subject"}
                    </div>
                    <div style={{ marginTop: 8, fontSize: 12, color: "var(--dim)" }}>
                      {fmtDate(selectedRow.lastMessageAt)}
                      {" · "}
                      {selectedRow.unreadCount > 0 ? `${selectedRow.unreadCount} unread` : "read"}
                    </div>
                    <div style={{ marginTop: 8 }}>
                      {selectedRow.listingItemId && (
                        <span className="app-cs-badge">Listing {selectedRow.listingItemId}</span>
                      )}
                      {selectedRow.relatedEbayOrderId && (
                        selectedRow.relatedOrderId ? (
                          <Link className="app-cs-badge" href={`/app/orders/${selectedRow.relatedOrderId}`}>
                            Order {selectedRow.relatedEbayOrderId}
                          </Link>
                        ) : (
                          <span className="app-cs-badge">Order {selectedRow.relatedEbayOrderId}</span>
                        )
                      )}
                    </div>
                  </div>
                  <div className="app-cs-messages-thread">
                    {detailLoading ? (
                      <p style={{ color: "var(--dim)", fontSize: 13 }}>Loading messages…</p>
                    ) : (
                      messages.map((m, i) => {
                        const fromBuyer = m.senderDisplay === selectedRow.counterpartyDisplay
                        return (
                          <div
                            key={m.messageId || String(i)}
                            className={`app-cs-msg-bubble ${fromBuyer ? "app-cs-msg-bubble--buyer" : "app-cs-msg-bubble--seller"}`}
                          >
                            <div style={{ fontSize: 11, color: "var(--dim)" }}>
                              {fromBuyer ? "Buyer" : "Seller"} · {m.senderDisplay} · {fmtDate(m.createdDate)}
                            </div>
                            {m.subject && <div style={{ fontSize: 12, marginTop: 4 }}>{m.subject}</div>}
                            <div style={{ fontSize: 13, marginTop: 6, whiteSpace: "pre-wrap" }}>{m.messageBody || "—"}</div>
                            {m.media.length > 0 && (
                              <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
                                {m.media.map((media, mi) => (
                                  media.mediaUrl ? (
                                    <a key={mi} href={media.mediaUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>
                                      {media.mediaType || "FILE"} {media.mediaName || media.mediaUrl}
                                    </a>
                                  ) : (
                                    <span key={mi} style={{ fontSize: 12, color: "var(--dim)" }}>
                                      {media.mediaType || "FILE"} {media.mediaName || "attachment"}
                                    </span>
                                  )
                                ))}
                              </div>
                            )}
                          </div>
                        )
                      })
                    )}
                  </div>
                  <div className="app-cs-messages-composer">
                    <div style={{ fontSize: 11, color: "var(--dim)", marginBottom: 6 }}>
                      {selectedStore ? `${selectedStore.storeCode} · ` : ""}
                      Replying to {selectedRow.counterpartyDisplay}
                    </div>
                    <textarea
                      value={replyText}
                      onChange={e => {
                        setReplyText(e.target.value)
                        resizeComposer(e.currentTarget)
                      }}
                      rows={4}
                      placeholder="Write a reply to this buyer…"
                      disabled={sending || reconnectRequired}
                    />
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginTop: 8 }}>
                      {sendStatus ? (
                        <span style={{ fontSize: 13, color: sendStatus.startsWith("Error") ? "#f87171" : "var(--accent)" }}>
                          {sendStatus}
                        </span>
                      ) : <span />}
                      <button
                        type="button"
                        style={selectStyle}
                        disabled={sending || reconnectRequired}
                        onClick={() => void sendReply()}
                      >
                        {sending ? "Sending..." : "Send Reply"}
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

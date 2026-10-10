import { query } from "../../db/client"
import { EbayApiClient } from "../ebay/ebayApiClient"
import { accountHasMessageScope, getValidAccessToken } from "../ebayOAuth/ebayOAuthService"
import { storeEbayScope } from "./csRepository"
import type { OwnedStore } from "../app/appOwnership"
import { AppHttpError } from "../app/appTypes"
import { resetInboxUnreadHint } from "./csNotificationRepository"

export type ConversationType = "FROM_MEMBERS" | "FROM_EBAY"

export type CsMessageMedia = {
  mediaName: string | null
  mediaType: string | null
  mediaUrl: string | null
}

export type CsConversationSummary = {
  conversationId: string
  conversationType: ConversationType
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

export type CsMessage = {
  messageId: string | null
  messageBody: string | null
  createdDate: string | null
  senderDisplay: string
  recipientDisplay: string
  readStatus: boolean | null
  subject: string | null
  media: CsMessageMedia[]
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function asString(v: unknown): string | null {
  if (typeof v !== "string") return null
  const t = v.trim()
  return t ? t : null
}

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string" && v.trim()) {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function asBool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null
}

function displayParty(...candidates: unknown[]): string {
  for (const c of candidates) {
    const s = asString(c)
    if (s) return s
  }
  return "Member"
}

function conversationTypeOf(v: unknown): ConversationType {
  return asString(v) === "FROM_EBAY" ? "FROM_EBAY" : "FROM_MEMBERS"
}

function mapMedia(raw: unknown): CsMessageMedia[] {
  if (!Array.isArray(raw)) return []
  const out: CsMessageMedia[] = []
  for (const item of raw) {
    const rec = asRecord(item)
    if (!rec) continue
    const mediaUrl = asString(rec.mediaUrl)
    const mediaType = asString(rec.mediaType)
    const mediaName = asString(rec.mediaName)
    if (!mediaUrl && !mediaType && !mediaName) continue
    out.push({ mediaName, mediaType, mediaUrl })
  }
  return out
}

function mapMessage(raw: unknown): CsMessage | null {
  const rec = asRecord(raw)
  if (!rec) return null
  return {
    messageId: asString(rec.messageId),
    messageBody: asString(rec.messageBody),
    createdDate: asString(rec.createdDate),
    senderDisplay: displayParty(rec.senderUsername, rec.senderUserName),
    recipientDisplay: displayParty(rec.recipientUsername, rec.recipientUserName),
    readStatus: asBool(rec.readStatus),
    subject: asString(rec.subject),
    media: mapMedia(rec.messageMedia),
  }
}

async function ebayClientForStore(workspaceId: string, store: OwnedStore): Promise<{
  client: EbayApiClient
  reconnectRequired: boolean
}> {
  const scope = await storeEbayScope(workspaceId, store.id)
  const connected = scope != null
  const messageScopeGranted = accountHasMessageScope(scope)
  if (!connected || !messageScopeGranted) {
    return {
      client: new EbayApiClient({ oauthToken: "missing", sandbox: false, simulationMode: true }),
      reconnectRequired: true,
    }
  }
  const token = await getValidAccessToken(workspaceId, store.storeCode, false)
  const sandbox = (process.env.EBAY_SANDBOX ?? "true") !== "false"
  return {
    client: new EbayApiClient({ oauthToken: token, sandbox, simulationMode: false }),
    reconnectRequired: false,
  }
}

async function relatedOrderForListingItem(
  workspaceId: string,
  storeId: number,
  listingItemId: string | null
): Promise<{ ebayOrderId: string; orderId: number } | null> {
  const itemId = listingItemId?.trim()
  if (!itemId) return null
  const res = await query<{ ebay_order_id: string; order_id: number }>(
    `SELECT o.ebay_order_id, MIN(o.id) AS order_id
     FROM ebay_order_items i
     INNER JOIN ebay_orders o
       ON o.id = i.order_id AND o.workspace_id = i.workspace_id AND o.store_id = $2
     WHERE i.workspace_id = $1::uuid
       AND i.ebay_item_id = $3
     GROUP BY o.ebay_order_id
     LIMIT 3`,
    [workspaceId, storeId, itemId]
  )
  if (res.rows.length !== 1) return null
  const ebayOrderId = res.rows[0].ebay_order_id?.trim()
  const orderId = Number(res.rows[0].order_id)
  if (!ebayOrderId || !Number.isInteger(orderId) || orderId < 1) return null
  return { ebayOrderId, orderId }
}

export async function listBuyerConversations(input: {
  workspaceId: string
  store: OwnedStore
  limit?: number
  offset?: number
}) {
  const { client, reconnectRequired } = await ebayClientForStore(input.workspaceId, input.store)
  if (reconnectRequired) {
    return {
      ok: true as const,
      storeCode: input.store.storeCode,
      reconnectRequired: true,
      reconnectCode: "MESSAGE_SCOPE_REQUIRED" as const,
      conversations: [] as CsConversationSummary[],
      limit: input.limit ?? 25,
      offset: input.offset ?? 0,
      total: 0,
    }
  }

  const limit = Math.max(1, Math.min(50, input.limit ?? 25))
  const offset = Math.max(0, input.offset ?? 0)
  const raw = await client.getMessageConversations({
    conversationType: "FROM_MEMBERS",
    limit,
    offset,
  })
  const rec = asRecord(raw) ?? {}
  const rows = Array.isArray(rec.conversations) ? rec.conversations : []
  const conversations: CsConversationSummary[] = []
  for (const row of rows) {
    const c = asRecord(row)
    if (!c) continue
    const conversationId = asString(c.conversationId)
    if (!conversationId) continue
    const latest = asRecord(c.latestMessage)
    const listingItemId = asString(c.referenceType) === "LISTING" ? asString(c.referenceId) : null
    const related = await relatedOrderForListingItem(
      input.workspaceId,
      input.store.id,
      listingItemId
    )
    conversations.push({
      conversationId,
      conversationType: conversationTypeOf(c.conversationType),
      conversationStatus: asString(c.conversationStatus),
      subject: asString(c.conversationTitle) || asString(latest?.subject),
      counterpartyDisplay: displayParty(
        c.conversationTitle,
        latest?.senderUsername,
        latest?.senderUserName,
        latest?.recipientUsername,
        latest?.recipientUserName
      ),
      lastPreview: asString(latest?.messageBody),
      lastMessageAt: asString(latest?.createdDate) || asString(c.createdDate),
      unreadCount: asNumber(c.unreadCount) ?? 0,
      listingItemId,
      relatedEbayOrderId: related?.ebayOrderId ?? null,
      relatedOrderId: related?.orderId ?? null,
    })
  }

  await resetInboxUnreadHint(input.workspaceId, input.store.id)

  return {
    ok: true as const,
    storeCode: input.store.storeCode,
    reconnectRequired: false,
    reconnectCode: null,
    conversations,
    limit: asNumber(rec.limit) ?? limit,
    offset: asNumber(rec.offset) ?? offset,
    total: asNumber(rec.total) ?? conversations.length,
  }
}

export async function getBuyerConversation(input: {
  workspaceId: string
  store: OwnedStore
  conversationId: string
  conversationType?: ConversationType
}) {
  const conversationId = input.conversationId.trim()
  if (!conversationId) throw new AppHttpError(400, "conversationId is required")
  const conversationType = input.conversationType ?? "FROM_MEMBERS"
  const { client, reconnectRequired } = await ebayClientForStore(input.workspaceId, input.store)
  if (reconnectRequired) {
    throw new AppHttpError(403, "eBay message permission required. Reconnect this store.")
  }

  const raw = await client.getMessageConversation({
    conversationId,
    conversationType,
    limit: 50,
    offset: 0,
  })
  const rec = asRecord(raw) ?? {}
  const messages: CsMessage[] = []
  if (Array.isArray(rec.messages)) {
    for (const m of rec.messages) {
      const mapped = mapMessage(m)
      if (mapped) messages.push(mapped)
    }
  }
  void client.markConversationRead({ conversationId, conversationType }).catch(() => undefined)

  return {
    ok: true as const,
    storeCode: input.store.storeCode,
    conversationId,
    conversationType: conversationTypeOf(rec.conversationType) || conversationType,
    conversationStatus: asString(rec.conversationStatus),
    subject: asString(rec.conversationTitle),
    messages,
    total: asNumber(rec.total) ?? messages.length,
  }
}

export async function replyBuyerConversation(input: {
  workspaceId: string
  store: OwnedStore
  conversationId: string
  messageText: string
}) {
  const conversationId = input.conversationId.trim()
  const messageText = input.messageText.trim()
  if (!conversationId) throw new AppHttpError(400, "conversationId is required")
  if (!messageText) throw new AppHttpError(400, "messageText is required")
  if (messageText.length > 2000) throw new AppHttpError(400, "messageText exceeds 2000 characters")
  const { client, reconnectRequired } = await ebayClientForStore(input.workspaceId, input.store)
  if (reconnectRequired) {
    throw new AppHttpError(403, "eBay message permission required. Reconnect this store.")
  }
  const sent = await client.sendConversationMessage({ conversationId, messageText })
  return {
    ok: true as const,
    storeCode: input.store.storeCode,
    conversationId,
    messageId: sent.messageId,
  }
}

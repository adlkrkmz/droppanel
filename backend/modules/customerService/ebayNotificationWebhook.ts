import type { Request, Response } from "express"
import {
  bumpInboxUnreadHint,
  findStoreByEbayUserKeys,
  insertNotificationEvent,
} from "./csNotificationRepository"

const HANDLED_TOPICS = new Set(["NEW_MESSAGE", "BUYER_QUESTION"])

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function asString(v: unknown): string | null {
  if (typeof v !== "string") return null
  const t = v.trim()
  return t ? t : null
}

function collectStrings(rec: Record<string, unknown> | null, keys: string[]): string[] {
  if (!rec) return []
  const out: string[] = []
  for (const key of keys) {
    const s = asString(rec[key])
    if (s) out.push(s)
  }
  return out
}

function parsePayload(body: unknown): {
  topicId: string
  notificationId: string | null
  conversationId: string | null
  sellerKeys: string[]
} {
  const root = asRecord(body) ?? {}
  const metadata = asRecord(root.metadata)
  const notification = asRecord(root.notification)
  const data = asRecord(notification?.data) ?? asRecord(root.data)
  const topicId = (
    asString(metadata?.topic) ||
    asString(root.topic) ||
    asString(root.topicId) ||
    "UNKNOWN"
  ).toUpperCase()
  const notificationId =
    asString(notification?.notificationId) ||
    asString(metadata?.notificationId) ||
    asString(root.notificationId)
  const conversationId =
    asString(data?.conversationId) ||
    asString(data?.conversation_id) ||
    asString(root.conversationId)
  const sellerKeys = [
    ...collectStrings(data, [
      "username",
      "sellerUsername",
      "sellerUserName",
      "userId",
      "sellerId",
      "ebayUserId",
      "senderUserName",
      "senderUsername",
      "recipientUserName",
      "recipientUsername",
    ]),
    ...collectStrings(metadata, ["username", "userId"]),
  ]
  return { topicId, notificationId, conversationId, sellerKeys }
}

export async function handleEbayNotificationEvent(req: Request, res: Response): Promise<void> {
  const parsed = parsePayload(req.body)
  if (!HANDLED_TOPICS.has(parsed.topicId)) {
    res.status(200).json({ ok: true, ignored: true, topic: parsed.topicId })
    return
  }
  const matches = await findStoreByEbayUserKeys(parsed.sellerKeys)
  if (matches.length !== 1) {
    await insertNotificationEvent({
      workspaceId: null,
      storeId: null,
      topicId: parsed.topicId,
      notificationId: parsed.notificationId,
      conversationId: parsed.conversationId,
      payload: req.body ?? {},
      signatureStatus: matches.length === 0 ? "UNMAPPED" : "AMBIGUOUS_STORE",
    })
    res.status(200).json({ ok: true, mapped: false })
    return
  }
  const store = matches[0]
  const inserted = await insertNotificationEvent({
    workspaceId: store.workspaceId,
    storeId: store.storeId,
    topicId: parsed.topicId,
    notificationId: parsed.notificationId,
    conversationId: parsed.conversationId,
    payload: req.body ?? {},
    signatureStatus: "ACCEPTED",
  })
  if (inserted) {
    await bumpInboxUnreadHint(store.workspaceId, store.storeId, parsed.topicId)
  }
  res.status(200).json({ ok: true, mapped: true, topic: parsed.topicId })
}

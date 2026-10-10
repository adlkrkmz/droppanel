import crypto from "crypto"
import {
  accountHasMessageScope,
  accountHasNotificationSubscriptionScope,
  getValidAccessToken,
} from "../ebayOAuth/ebayOAuthService"
import type { OwnedStore } from "../app/appOwnership"
import { storeEbayScope } from "./csRepository"
import { EbayNotificationApi, type NotificationTopic } from "./ebayNotificationApi"
import {
  destinationByEndpoint,
  getInboxUnreadHint,
  getOrCreateDestinationConfig,
  listSubscriptionRows,
  saveDestinationError,
  saveDestinationId,
  upsertSubscriptionRow,
} from "./csNotificationRepository"

export const BUYER_MESSAGE_NOTIFICATION_TOPICS = ["NEW_MESSAGE", "BUYER_QUESTION"] as const

export type BuyerMessageTopicId = (typeof BUYER_MESSAGE_NOTIFICATION_TOPICS)[number]

function ebayApiBase(): string {
  return (process.env.EBAY_SANDBOX ?? "true") !== "false"
    ? "https://api.sandbox.ebay.com"
    : "https://api.ebay.com"
}

export function ebayNotificationEndpoint(): string {
  const explicit = process.env.EBAY_NOTIFICATION_ENDPOINT?.trim()
  if (explicit) return explicit.replace(/\/$/, "")
  const apiBase = (process.env.API_BASE_URL ?? "").trim().replace(/\/$/, "")
  if (apiBase.startsWith("http")) return `${apiBase}/webhooks/ebay-notifications`
  const redirect = (process.env.EBAY_REDIRECT_URI ?? "").trim()
  try {
    if (redirect) {
      const host = new URL(redirect).origin
      return `${host}/webhooks/ebay-notifications`
    }
  } catch {
    /* fall through */
  }
  return "https://api.listjetgo.com/webhooks/ebay-notifications"
}

export function challengeResponseHash(challengeCode: string, verificationToken: string, endpoint: string): string {
  return crypto.createHash("sha256").update(challengeCode + verificationToken + endpoint).digest("hex")
}

export async function handleEbayNotificationChallenge(challengeCode: string): Promise<{
  ok: boolean
  status: number
  body: Record<string, string>
}> {
  const code = challengeCode.trim()
  if (!code) {
    return { ok: false, status: 400, body: { error: "challenge_code is required" } }
  }
  const endpoint = ebayNotificationEndpoint()
  const dest = await destinationByEndpoint(endpoint)
  if (!dest) {
    return { ok: false, status: 404, body: { error: "notification destination is not configured" } }
  }
  return {
    ok: true,
    status: 200,
    body: { challengeResponse: challengeResponseHash(code, dest.verificationToken, endpoint) },
  }
}

function simulationMode(): boolean {
  return (process.env.EBAY_SIMULATION ?? "false") === "true"
}

async function storeNotificationClient(workspaceId: string, store: OwnedStore): Promise<EbayNotificationApi> {
  const token = await getValidAccessToken(workspaceId, store.storeCode, false)
  return new EbayNotificationApi(ebayApiBase(), token)
}

function notificationAlertEmail(): string | null {
  const email = process.env.EBAY_NOTIFICATION_ALERT_EMAIL?.trim()
  return email || null
}

async function ensureNotificationConfig(api: EbayNotificationApi): Promise<void> {
  const existing = await api.getConfig().catch(() => ({ alertEmail: null as string | null }))
  if (existing.alertEmail) return
  const email = notificationAlertEmail()
  if (!email) {
    throw new Error(
      "Notification API GET /subscription returns 195003 until PUT /commerce/notification/v1/config { alertEmail } is set. Set EBAY_NOTIFICATION_ALERT_EMAIL."
    )
  }
  await api.updateConfig(email)
}

function topicWarning(topic: NotificationTopic | null, topicId: string): string | null {
  if (!topic) return `${topicId} is not available on GET /commerce/notification/v1/topic/{topic_id}`
  if (topic.status && topic.status.toUpperCase() !== "ENABLED") {
    return `${topicId} topic status is ${topic.status}`
  }
  return null
}

export async function getBuyerMessageNotificationStatus(input: {
  workspaceId: string
  store: OwnedStore
}) {
  const scope = await storeEbayScope(input.workspaceId, input.store.id)
  const messageScopeGranted = accountHasMessageScope(scope)
  const notificationUserScopeGranted = accountHasNotificationSubscriptionScope(scope)
  const endpoint = ebayNotificationEndpoint()
  const dest = await destinationByEndpoint(endpoint)
  const hint = await getInboxUnreadHint(input.workspaceId, input.store.id)
  const rows = await listSubscriptionRows(input.workspaceId, input.store.id)
  const topics = BUYER_MESSAGE_NOTIFICATION_TOPICS.map(topicId => {
    const row = rows.find(r => r.topic_id === topicId)
    return {
      topicId,
      status: row?.status ?? (row?.last_error ? "ERROR" : "NOT_SUBSCRIBED"),
      subscriptionId: row?.subscription_id ?? null,
      topicScope: row?.topic_scope ?? null,
      error: row?.last_error ?? null,
    }
  })
  return {
    ok: true as const,
    storeCode: input.store.storeCode,
    messageScopeGranted,
    notificationUserScopeGranted,
    destination: {
      endpoint,
      destinationId: dest?.destinationId ?? null,
      configured: Boolean(dest),
    },
    topics,
    inboxUnreadHint: hint.unreadHint,
    lastNotificationTopic: hint.lastTopic,
    lastNotificationAt: hint.lastEventAt,
    reconnectRequired: !messageScopeGranted,
    alertEmailConfigured: Boolean(notificationAlertEmail()),
    notes: [
      "NEW_MESSAGE and BUYER_QUESTION are USER-scoped topics; GET /topic lists commerce.message as the authorization scope.",
      "Destination/subscription use the store user token.",
      "Subscriptions require PUT /commerce/notification/v1/config { alertEmail } from EBAY_NOTIFICATION_ALERT_EMAIL.",
      "No auto-reply is sent when events arrive.",
    ],
  }
}

async function ensureDestination(workspaceId: string, store: OwnedStore): Promise<{ destinationId: string; endpoint: string }> {
  const endpoint = ebayNotificationEndpoint()
  const cfg = await getOrCreateDestinationConfig(endpoint)
  if (simulationMode()) {
    const destinationId = cfg.destinationId || "SIM_DESTINATION"
    await saveDestinationId(endpoint, destinationId, "ENABLED", null)
    return { destinationId, endpoint }
  }
  const api = await storeNotificationClient(workspaceId, store)
  try {
    const existing = await api.getDestinations()
    const match = existing.find(d =>
      Boolean(d.destinationId) && (d.endpoint === endpoint || d.destinationId === cfg.destinationId)
    )
    if (match?.destinationId) {
      await saveDestinationId(endpoint, match.destinationId, match.status ?? "ENABLED", null)
      return { destinationId: match.destinationId, endpoint }
    }
    const destinationId = await api.createDestination({
      name: "ListJetGo buyer messages",
      endpoint,
      verificationToken: cfg.verificationToken,
    })
    await saveDestinationId(endpoint, destinationId, "ENABLED", null)
    return { destinationId, endpoint }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await saveDestinationError(endpoint, msg)
    throw e
  }
}

async function subscribeTopic(input: {
  workspaceId: string
  store: OwnedStore
  topic: NotificationTopic
  destinationId: string
}): Promise<void> {
  const topicId = input.topic.topicId
  const scopeKind = (input.topic.scope ?? "").toUpperCase()
  const userNeedsNotificationScope =
    scopeKind === "USER" &&
    input.topic.authorizationScopes.some(s => s.includes("commerce.notification.subscription"))
  if (userNeedsNotificationScope) {
    const scope = await storeEbayScope(input.workspaceId, input.store.id)
    if (!accountHasNotificationSubscriptionScope(scope)) {
      await upsertSubscriptionRow({
        workspaceId: input.workspaceId,
        storeId: input.store.id,
        topicId,
        subscriptionId: null,
        destinationId: input.destinationId,
        status: "MISSING_SCOPE",
        topicScope: input.topic.scope,
        lastError:
          "Topic is USER-scoped and lists commerce.notification.subscription. This is not on first-connect OAuth; destination/check still works.",
      })
      return
    }
  }

  if (simulationMode()) {
    await upsertSubscriptionRow({
      workspaceId: input.workspaceId,
      storeId: input.store.id,
      topicId,
      subscriptionId: `SIM_SUB_${topicId}`,
      destinationId: input.destinationId,
      status: "ENABLED",
      topicScope: input.topic.scope,
      lastError: null,
    })
    return
  }

  const client = await storeNotificationClient(input.workspaceId, input.store)
  try {
    const existing = await client.getSubscriptions()
    const match = existing.find(s => s.topicId === topicId && s.subscriptionId)
    const subscriptionId =
      match?.subscriptionId ??
      (await client.createSubscription({
        topicId,
        destinationId: input.destinationId,
        schemaVersion: input.topic.schemaVersion,
      }))
    await upsertSubscriptionRow({
      workspaceId: input.workspaceId,
      storeId: input.store.id,
      topicId,
      subscriptionId,
      destinationId: input.destinationId,
      status: match?.status ?? "ENABLED",
      topicScope: input.topic.scope,
      lastError: null,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await upsertSubscriptionRow({
      workspaceId: input.workspaceId,
      storeId: input.store.id,
      topicId,
      subscriptionId: null,
      destinationId: input.destinationId,
      status: "ERROR",
      topicScope: input.topic.scope,
      lastError: msg.slice(0, 1000),
    })
  }
}

export async function ensureBuyerMessageNotifications(input: {
  workspaceId: string
  store: OwnedStore
}) {
  const scope = await storeEbayScope(input.workspaceId, input.store.id)
  const messageScopeGranted = accountHasMessageScope(scope)
  if (!messageScopeGranted) {
    return {
      ...(await getBuyerMessageNotificationStatus(input)),
      ensured: false,
      error: "eBay message permission required. Reconnect this store.",
    }
  }

  let destinationId: string
  try {
    if (!simulationMode()) {
      const api = await storeNotificationClient(input.workspaceId, input.store)
      await ensureNotificationConfig(api)
    }
    const dest = await ensureDestination(input.workspaceId, input.store)
    destinationId = dest.destinationId
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return {
      ...(await getBuyerMessageNotificationStatus(input)),
      ensured: false,
      error: msg,
    }
  }

  if (simulationMode()) {
    for (const topicId of BUYER_MESSAGE_NOTIFICATION_TOPICS) {
      await subscribeTopic({
        workspaceId: input.workspaceId,
        store: input.store,
        topic: {
          topicId,
          scope: "USER",
          status: "ENABLED",
          authorizationScopes: [],
          schemaVersion: "1.0",
          description: null,
        },
        destinationId,
      })
    }
    return { ...(await getBuyerMessageNotificationStatus(input)), ensured: true, error: null as string | null }
  }

  const api = await storeNotificationClient(input.workspaceId, input.store)
  for (const topicId of BUYER_MESSAGE_NOTIFICATION_TOPICS) {
    let topic: NotificationTopic | null = null
    try {
      topic = await api.getTopic(topicId)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      await upsertSubscriptionRow({
        workspaceId: input.workspaceId,
        storeId: input.store.id,
        topicId,
        subscriptionId: null,
        destinationId,
        status: "ERROR",
        topicScope: null,
        lastError: msg.slice(0, 1000),
      })
      continue
    }
    const warn = topicWarning(topic, topicId)
    if (!topic || warn) {
      await upsertSubscriptionRow({
        workspaceId: input.workspaceId,
        storeId: input.store.id,
        topicId,
        subscriptionId: null,
        destinationId,
        status: topic ? "UNAVAILABLE" : "UNKNOWN_TOPIC",
        topicScope: topic?.scope ?? null,
        lastError: warn,
      })
      continue
    }
    await subscribeTopic({
      workspaceId: input.workspaceId,
      store: input.store,
      topic,
      destinationId,
    })
  }

  return { ...(await getBuyerMessageNotificationStatus(input)), ensured: true, error: null as string | null }
}

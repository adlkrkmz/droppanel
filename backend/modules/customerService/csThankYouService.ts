import { isSafePublicProofUrl } from "../mailbox/deliveryProofExtract"
import { EbayApiClient } from "../ebay/ebayApiClient"
import { accountHasMessageScope, getValidAccessToken } from "../ebayOAuth/ebayOAuthService"
import { prepareDeliveryPhotoMedia } from "./csDeliveryPhotoMedia"
import {
  claimNextQueuedSend,
  getOrCreateAutomation,
  getOrCreateStoreSettings,
  getOrCreateThankYouAutomation,
  listRecentSends,
  loadOrderByPk,
  loadOrderForSend,
  markSendResult,
  sendStats,
  storeEbayScope,
  tryInsertQueuedSend,
  updateAutomation,
  setMasterEnabled,
} from "./csRepository"
import {
  DEFAULT_THANK_YOU_TEMPLATE,
  automationTypeForSourceEvent,
  defaultTemplateForType,
  evaluateAutomationEligibility,
  evaluateThankYouEligibility,
  findUnsupportedPlaceholdersFor,
  placeholdersForType,
  renderAutomationTemplate,
  removeDeliveryPhotoClaim,
  renderThankYouTemplate,
  templateMentionsAmazon,
  type CsAutomationType,
} from "./csTemplate"

const LOG = "[CustomerServiceThankYou]"

export async function enqueueThankYouForNewOrder(input: {
  workspaceId: string
  storeId: number
  storeName: string
  ebayOrderId: string
  buyerUsername: string | null
  buyerName?: string | null
  orderStatus?: string | null
  fulfillmentStatus?: string | null
  paymentStatus?: string | null
}): Promise<{ queued: boolean; reason?: string }> {
  const master = await getOrCreateStoreSettings(input.workspaceId, input.storeId)
  const automation = await getOrCreateThankYouAutomation(input.workspaceId, input.storeId)
  const elig = evaluateThankYouEligibility({
    enabled: master.enabled,
    ebayOrderId: input.ebayOrderId,
    buyerUsername: input.buyerUsername,
    orderStatus: input.orderStatus,
    fulfillmentStatus: input.fulfillmentStatus,
    paymentStatus: input.paymentStatus,
  })
  if (!elig.ok) return { queued: false, reason: elig.reason }
  let snapshot: string
  try {
    snapshot = renderThankYouTemplate(automation.templateBody || DEFAULT_THANK_YOU_TEMPLATE, {
      buyer_username: input.buyerUsername!.trim(),
      order_id: input.ebayOrderId,
      store_name: input.storeName,
      buyer_name: input.buyerName ?? null,
    })
  } catch (e) {
    return { queued: false, reason: e instanceof Error ? e.message : "invalid_template" }
  }
  const inserted = await tryInsertQueuedSend({
    workspaceId: input.workspaceId,
    storeId: input.storeId,
    ebayOrderId: input.ebayOrderId,
    templateSnapshot: snapshot,
  })
  if (inserted === "duplicate") return { queued: false, reason: "already_queued_or_sent" }
  console.log(`${LOG} queued store_id=${input.storeId} order=${input.ebayOrderId}`)
  return { queued: true }
}

export async function enqueueSourceStatusAutomation(input: {
  workspaceId: string
  storeId: number
  orderPk: number
  eventType: string
  sourceEventId: number
  sourceMailboxMessageId: number
}): Promise<{ queued: boolean; reason?: string }> {
  const automationType = automationTypeForSourceEvent(input.eventType)
  if (!automationType) return { queued: false, reason: "INVALID_EVENT" }
  if (!input.sourceEventId || !input.sourceMailboxMessageId) {
    return { queued: false, reason: "UNLINKED_SOURCE" }
  }
  const order = await loadOrderByPk(input.workspaceId, input.storeId, input.orderPk)
  if (!order) return { queued: false, reason: "INVALID_EVENT" }
  const master = await getOrCreateStoreSettings(input.workspaceId, input.storeId)
  const linked = Boolean(order.amazonOrderNumber?.trim())
  const automation = await getOrCreateAutomation(input.workspaceId, input.storeId, automationType)
  const elig = evaluateAutomationEligibility({
    enabled: master.enabled,
    ebayOrderId: order.ebayOrderId,
    buyerUsername: order.buyerUsername,
    orderStatus: order.orderStatus,
    fulfillmentStatus: order.fulfillmentStatus,
    paymentStatus: order.paymentStatus,
    linked,
    eventType: input.eventType,
    expectedEventType:
      automationType === "SHIPPED"
        ? "SOURCE_SHIPPED"
        : automationType === "DELAYED"
          ? "SOURCE_DELAYED"
          : "SOURCE_DELIVERED",
  })
  if (!elig.ok) return { queued: false, reason: elig.reason }
  let snapshot: string
  try {
    snapshot = renderAutomationTemplate(
      automationType,
      automation.templateBody || defaultTemplateForType(automationType),
      {
        buyer_username: order.buyerUsername!.trim(),
        order_id: order.ebayOrderId,
        store_name: order.storeName,
        buyer_name: order.buyerName,
        estimated_delivery: order.estimatedDelivery,
        delivery_location: order.deliveryLocation,
        has_delivery_photo: Boolean(order.deliveryProofR2Url),
      }
    )
  } catch (e) {
    return { queued: false, reason: e instanceof Error ? e.message : "invalid_template" }
  }
  const inserted = await tryInsertQueuedSend({
    workspaceId: input.workspaceId,
    storeId: input.storeId,
    ebayOrderId: order.ebayOrderId,
    templateSnapshot: snapshot,
    automationType,
    sourceEventId: input.sourceEventId,
    sourceMailboxMessageId: input.sourceMailboxMessageId,
    sourceEventType: input.eventType,
  })
  if (inserted === "duplicate") return { queued: false, reason: "DUPLICATE" }
  console.log(
    `${LOG} queued ${automationType} store_id=${input.storeId} order=${order.ebayOrderId} event=${input.eventType}`
  )
  return { queued: true }
}

export async function processNextThankYouSend(): Promise<"empty" | "sent" | "skipped" | "failed"> {
  const job = await claimNextQueuedSend()
  if (!job) return "empty"

  try {
    const automationType = job.automationType
    const master = await getOrCreateStoreSettings(job.workspaceId, job.storeId)
    const automation = await getOrCreateAutomation(job.workspaceId, job.storeId, automationType)
    const order = await loadOrderForSend(job.workspaceId, job.storeId, job.ebayOrderId)
    if (!order) {
      await markSendResult({ id: job.id, status: "skipped", error: "order_not_found" })
      return "skipped"
    }
    const linked = automationType === "THANK_YOU" ? true : Boolean(order.amazonOrderNumber?.trim())
    const expectedEvent =
      automationType === "SHIPPED"
        ? "SOURCE_SHIPPED"
        : automationType === "DELAYED"
          ? "SOURCE_DELAYED"
          : automationType === "DELIVERED"
            ? "SOURCE_DELIVERED"
            : null
    const elig = evaluateAutomationEligibility({
      enabled: master.enabled,
      ebayOrderId: job.ebayOrderId,
      buyerUsername: order.buyerUsername,
      orderStatus: order.orderStatus,
      fulfillmentStatus: order.fulfillmentStatus,
      paymentStatus: order.paymentStatus,
      linked,
      eventType: automationType === "THANK_YOU" ? "THANK_YOU" : job.sourceEventType,
      expectedEventType: expectedEvent,
    })
    if (!elig.ok) {
      await markSendResult({ id: job.id, status: "skipped", error: elig.reason })
      return "skipped"
    }
    if (!order.itemId) {
      await markSendResult({ id: job.id, status: "failed", error: "missing_item_id" })
      return "failed"
    }

    const proofUrl =
      automationType === "DELIVERED" && isSafePublicProofUrl(order.deliveryProofR2Url)
        ? order.deliveryProofR2Url!.trim()
        : null
    const renderBody = (hasDeliveryPhoto: boolean): string => renderAutomationTemplate(
      automationType,
      automation.templateBody || defaultTemplateForType(automationType),
      {
        buyer_username: order.buyerUsername!.trim(),
        order_id: job.ebayOrderId,
        store_name: order.storeName,
        buyer_name: order.buyerName,
        estimated_delivery: order.estimatedDelivery,
        delivery_location: order.deliveryLocation,
        has_delivery_photo: hasDeliveryPhoto,
      }
    )
    let bodyWithoutMedia: string
    try {
      bodyWithoutMedia = removeDeliveryPhotoClaim(renderBody(false))
    } catch {
      bodyWithoutMedia = removeDeliveryPhotoClaim(job.templateSnapshot?.trim() || "")
    }
    if (!bodyWithoutMedia) {
      await markSendResult({ id: job.id, status: "failed", error: "empty_message" })
      return "failed"
    }

    const token = await getValidAccessToken(job.workspaceId, order.storeCode, false)
    const sandbox = (process.env.EBAY_SANDBOX ?? "true") !== "false"
    const client = new EbayApiClient({ oauthToken: token, sandbox, simulationMode: false })
    const scope = await storeEbayScope(job.workspaceId, job.storeId)
    const preferRest = accountHasMessageScope(scope)
    let body = bodyWithoutMedia
    let media: Array<{ mediaName: string; mediaType: string; mediaUrl: string }> = []
    let mediaPreparationResult = proofUrl ? "not_prepared" : "no_source"
    if (proofUrl) {
      const prepared = await prepareDeliveryPhotoMedia(client, proofUrl)
      if (!("reason" in prepared)) {
        media = [prepared.media]
        body = renderBody(true)
        mediaPreparationResult = "eps_prepared"
      } else {
        mediaPreparationResult = prepared.reason
      }
      console.log(`${LOG} delivery_photo_prepare ${JSON.stringify({
        orderId: job.ebayOrderId,
        storeId: job.storeId,
        sourceRetrievalSuccess: !("reason" in prepared) || prepared.sourceContentType !== null,
        sourceContentType: !("reason" in prepared) ? prepared.media.sourceContentType : prepared.sourceContentType,
        mediaPreparationSuccess: !("reason" in prepared),
        result: mediaPreparationResult,
      })}`)
    }
    const sent = await client.sendBuyerMessage({
      buyerUsername: order.buyerUsername!.trim(),
      body,
      itemId: order.itemId,
      preferRest,
      messageMedia: media,
      bodyWithoutMedia,
      allowTradingFallback: true,
    })
    await markSendResult({
      id: job.id,
      status: "sent",
      ebayMessageId: sent.messageId,
      mediaAttempted: Boolean(proofUrl),
      mediaIncluded: sent.mediaIncluded,
      mediaUrl: media[0]?.mediaUrl ?? proofUrl,
      mediaResult: media.length > 0 ? sent.mediaResult : mediaPreparationResult,
    })
    console.log(`${LOG} sent ${JSON.stringify({
      storeId: job.storeId,
      orderId: job.ebayOrderId,
      sendPath: sent.via,
      mediaAttachmentSuccess: sent.mediaIncluded,
      mediaResult: sent.mediaResult,
      ebayMessageId: sent.messageId,
    })}`)
    return "sent"
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await markSendResult({
      id: job.id,
      status: "failed",
      error: msg.slice(0, 500),
      mediaAttempted: job.automationType === "DELIVERED",
      mediaResult: "send_failed_no_retry_duplicate",
    })
    console.warn(`${LOG} failed id=${job.id}: ${msg}`)
    return "failed"
  }
}

export async function getCustomerServicePage(workspaceId: string, store: {
  id: number
  storeCode: string
  name: string
}) {
  const types: Array<{ type: CsAutomationType; label: string }> = [
    { type: "THANK_YOU", label: "Thank You" },
    { type: "SHIPPED", label: "Shipped" },
    { type: "DELAYED", label: "Delayed" },
    { type: "DELIVERED", label: "Delivered" },
  ]
  const master = await getOrCreateStoreSettings(workspaceId, store.id)
  const automations = []
  for (const item of types) {
    const row = await getOrCreateAutomation(workspaceId, store.id, item.type)
    const stats = await sendStats(workspaceId, store.id, item.type)
    automations.push({
      type: item.type,
      label: item.label,
      enabled: master.enabled,
      template: row.templateBody,
      status: master.enabled ? "Active" : "Paused",
      comingSoon: false,
      placeholders: [...placeholdersForType(item.type)].map(k => `{{${k}}}`),
      helpText:
        item.type === "DELIVERED"
          ? "Delivery photo is included automatically when available."
          : undefined,
      stats,
    })
  }
  const recent = await listRecentSends(workspaceId, store.id)
  const scope = await storeEbayScope(workspaceId, store.id)
  const messageScopeGranted = accountHasMessageScope(scope)
  const connected = Boolean(scope != null)
  const thankYouStats = automations.find(a => a.type === "THANK_YOU")?.stats
  return {
    ok: true as const,
    storeCode: store.storeCode,
    storeName: store.name,
    masterEnabled: master.enabled,
    automations,
    stats: {
      sentToday: thankYouStats?.sentToday ?? 0,
      failed: thankYouStats?.failed ?? 0,
      lastSentAt: thankYouStats?.lastSentAt ?? null,
    },
    recent,
    ebayMessage: {
      api: "POST /commerce/message/v1/send_message",
      fallbackApi: "Trading AddMemberMessageAAQToPartner",
      connected,
      messageScopeGranted,
      reconnectRequired: connected && !messageScopeGranted,
      reconnectCode: connected && !messageScopeGranted ? "MESSAGE_SCOPE_REQUIRED" : null,
    },
    placeholders: [...placeholdersForType("THANK_YOU")].map(k => `{{${k}}}`),
  }
}

function validateTemplate(type: CsAutomationType, templateBody: string | undefined): void {
  if (templateBody === undefined) return
  if (!templateBody.trim()) {
    const err = new Error("Template cannot be empty") as Error & { status?: number }
    err.status = 400
    throw err
  }
  if (templateMentionsAmazon(templateBody)) {
    const err = new Error("Template must not mention Amazon") as Error & { status?: number }
    err.status = 400
    throw err
  }
  const unsupported = findUnsupportedPlaceholdersFor(type, templateBody)
  if (unsupported.length > 0) {
    const err = new Error(
      `Unsupported placeholders: ${unsupported.map(k => `{{${k}}}`).join(", ")}`
    ) as Error & { status?: number }
    err.status = 400
    throw err
  }
}

export async function saveThankYouSettings(input: {
  workspaceId: string
  storeId: number
  enabled?: boolean
  templateBody?: string
}) {
  return saveAutomationSettings({
    ...input,
    automationType: "THANK_YOU",
  })
}

export async function saveAutomationSettings(input: {
  workspaceId: string
  storeId: number
  automationType: CsAutomationType
  enabled?: boolean
  templateBody?: string
}) {
  validateTemplate(input.automationType, input.templateBody)
  return updateAutomation(input.workspaceId, input.storeId, input.automationType, {
    templateBody: input.templateBody,
  })
}

export async function saveMasterEnabled(input: {
  workspaceId: string
  storeId: number
  enabled: boolean
}): Promise<{ enabled: boolean }> {
  return setMasterEnabled(input.workspaceId, input.storeId, input.enabled)
}

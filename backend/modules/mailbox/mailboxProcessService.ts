import { captureDeliveryProofIfPresent } from "./deliveryProofStore"
import { classifyMailboxEmail } from "./emailClassify"
import { htmlToText, parseAmazonEmailByType } from "./amazonEmailParser"
import {
  parseEbayCancelRequestEmail,
  parseEbayCancelledEmail,
  parseEbayPayoutEmail,
  parseEbayReturnRequestEmail,
  parseEbaySaleEmail,
} from "./ebayEmailParser"
import {
  applyAmazonParseToOrder,
  applyEbayCancelEvent,
  applyEbayCancelledEvent,
  applyEbayReturnEvent,
  applyEbaySaleEvent,
  openLinkReview,
} from "./mailboxApplyService"
import { findEbayOrderByEbayOrderId, matchAmazonParseToEbayOrder } from "./orderMatchService"
import { linkExactAmazonMailsToOrder } from "./linkAmazonMailsFromOrderNumber"
import type { AmazonEmailParse, MailboxClassifiedType } from "./mailboxTypes"
import { query } from "../../db/client"

export async function processStoredMailboxMessage(messageId: number): Promise<{
  status: string
  type: MailboxClassifiedType | null
  matched: boolean
}> {
  const res = await query<{
    id: number
    workspace_id: string
    store_id: number | null
    sender: string | null
    subject: string | null
    text_body: string | null
    html_body: string | null
    received_at: Date | null
    processing_status: string
  }>(
    `SELECT id, workspace_id::text, store_id, sender, subject, text_body, html_body,
            received_at, processing_status
     FROM mailbox_messages WHERE id = $1`,
    [messageId]
  )
  const row = res.rows[0]
  if (!row) return { status: "FAILED", type: null, matched: false }
  if (row.processing_status !== "PENDING") {
    return { status: row.processing_status, type: null, matched: false }
  }

  const text = (row.text_body?.trim() || htmlToText(row.html_body ?? "")).trim()
  const classified = classifyMailboxEmail({
    sender: row.sender ?? "",
    subject: row.subject ?? "",
    textBody: text,
  })

  if (classified === "IGNORED") {
    await markMessage(row.id, "IGNORED", classified, null, null, null)
    return { status: "IGNORED", type: classified, matched: false }
  }

  if (classified === "UNKNOWN_TRANSACTIONAL") {
    await markMessage(row.id, "NEEDS_REVIEW", classified, null, "unknown_template", null)
    return { status: "NEEDS_REVIEW", type: classified, matched: false }
  }

  const ws = row.workspace_id
  if (
    classified === "AMAZON_ORDERED" ||
    classified === "AMAZON_SHIPPED" ||
    classified === "AMAZON_DELAYED" ||
    classified === "AMAZON_DELIVERED"
  ) {
    const parsed = parseAmazonEmailByType(classified, text)
    if (!parsed.amazonOrderNumber) {
      await markMessage(row.id, "NEEDS_REVIEW", classified, parsed, "missing_amazon_order_number", null)
      return { status: "NEEDS_REVIEW", type: classified, matched: false }
    }
    const match = await matchAmazonParseToEbayOrder({
      workspaceId: ws,
      parsed,
      receivedAt: row.received_at,
    })
    if (!match.ok) {
      await openLinkReview({
        workspaceId: ws,
        storeId: null,
        mailboxMessageId: row.id,
        amazonOrderNumber: parsed.amazonOrderNumber,
        candidateIds: match.candidateIds,
        reason: match.reason,
      })
      await markMessage(row.id, "NEEDS_REVIEW", classified, parsed, match.reason, null)
      return { status: "NEEDS_REVIEW", type: classified, matched: false }
    }
    const applied = await applyAmazonParseToOrder({
      workspaceId: ws,
      storeId: match.storeId,
      orderPk: match.orderPk,
      mailboxMessageId: row.id,
      parsed,
      receivedAt: row.received_at,
    })
    if (!applied.applied) {
      await openLinkReview({
        workspaceId: ws,
        storeId: match.storeId,
        mailboxMessageId: row.id,
        amazonOrderNumber: parsed.amazonOrderNumber,
        candidateIds: [match.orderPk],
        reason: applied.conflict ?? "apply_failed",
      })
      await markMessage(row.id, "NEEDS_REVIEW", classified, parsed, applied.conflict, match.orderPk)
      return { status: "NEEDS_REVIEW", type: classified, matched: false }
    }
    if (applied.conflict) {
      await openLinkReview({
        workspaceId: ws,
        storeId: match.storeId,
        mailboxMessageId: row.id,
        amazonOrderNumber: parsed.amazonOrderNumber,
        candidateIds: [match.orderPk],
        reason: applied.conflict,
      })
    }
    await markMessage(row.id, "PROCESSED", classified, parsed, applied.conflict, match.orderPk)
    if (
      classified === "AMAZON_ORDERED" &&
      match.ok &&
      match.reason === "unique_name_city_state" &&
      parsed.amazonOrderNumber
    ) {
      try {
        await linkExactAmazonMailsToOrder({
          workspaceId: ws,
          storeId: match.storeId,
          orderPk: match.orderPk,
          amazonOrderNumber: parsed.amazonOrderNumber,
        })
      } catch (e) {
        console.warn(
          `[Mailbox] exact link after identity match failed message_id=${row.id}:`,
          e instanceof Error ? e.message : String(e)
        )
      }
    }
    if (classified === "AMAZON_DELIVERED") {
      try {
        await captureDeliveryProofIfPresent({
          workspaceId: ws,
          storeId: match.storeId,
          orderPk: match.orderPk,
          mailboxMessageId: row.id,
          htmlBody: row.html_body,
        })
      } catch (e) {
        console.warn(
          `[DeliveryProof] post-process skipped message_id=${row.id}:`,
          e instanceof Error ? e.message : String(e)
        )
      }
    }
    return { status: "PROCESSED", type: classified, matched: true }
  }

  if (classified === "EBAY_SALE") {
    const parsed = parseEbaySaleEmail(text)
    const match = parsed.ebayOrderId
      ? await findEbayOrderByEbayOrderId({ workspaceId: ws, ebayOrderId: parsed.ebayOrderId })
      : null
    if (match == null) {
      await markMessage(row.id, "NEEDS_REVIEW", classified, parsed, "ebay_order_not_found_in_workspace", null)
      return { status: "NEEDS_REVIEW", type: classified, matched: false }
    }
    await applyEbaySaleEvent({
      workspaceId: ws,
      storeId: match.storeId,
      orderPk: match.orderPk,
      mailboxMessageId: row.id,
      parsed,
    })
    await markMessage(row.id, "PROCESSED", classified, parsed, null, match.orderPk)
    return { status: "PROCESSED", type: classified, matched: true }
  }

  if (classified === "EBAY_CANCEL_REQUEST") {
    const parsed = parseEbayCancelRequestEmail(text)
    const match = parsed.ebayOrderId
      ? await findEbayOrderByEbayOrderId({ workspaceId: ws, ebayOrderId: parsed.ebayOrderId })
      : null
    if (match == null) {
      await markMessage(row.id, "NEEDS_REVIEW", classified, parsed, "ebay_order_not_found_in_workspace", null)
      return { status: "NEEDS_REVIEW", type: classified, matched: false }
    }
    await applyEbayCancelEvent({
      workspaceId: ws,
      storeId: match.storeId,
      orderPk: match.orderPk,
      mailboxMessageId: row.id,
      parsed,
    })
    await markMessage(row.id, "PROCESSED", classified, parsed, null, match.orderPk)
    return { status: "PROCESSED", type: classified, matched: true }
  }

  if (classified === "EBAY_RETURN_REQUEST") {
    const parsed = parseEbayReturnRequestEmail(text)
    const match = parsed.ebayOrderId
      ? await findEbayOrderByEbayOrderId({ workspaceId: ws, ebayOrderId: parsed.ebayOrderId })
      : null
    if (match == null) {
      await markMessage(row.id, "NEEDS_REVIEW", classified, parsed, "ebay_order_not_found_in_workspace", null)
      return { status: "NEEDS_REVIEW", type: classified, matched: false }
    }
    await applyEbayReturnEvent({
      workspaceId: ws,
      storeId: match.storeId,
      orderPk: match.orderPk,
      mailboxMessageId: row.id,
      parsed,
    })
    await markMessage(row.id, "PROCESSED", classified, parsed, null, match.orderPk)
    return { status: "PROCESSED", type: classified, matched: true }
  }

  if (classified === "EBAY_PAYOUT") {
    const parsed = parseEbayPayoutEmail(text)
    await markMessage(row.id, "NEEDS_REVIEW", classified, parsed, "payout_has_no_reliable_order_store", null)
    return { status: "NEEDS_REVIEW", type: classified, matched: false }
  }

  if (classified === "EBAY_CANCELLED") {
    const parsed = parseEbayCancelledEmail(text)
    const match = parsed.ebayOrderId
      ? await findEbayOrderByEbayOrderId({ workspaceId: ws, ebayOrderId: parsed.ebayOrderId })
      : null
    if (match == null) {
      await markMessage(row.id, "NEEDS_REVIEW", classified, parsed, "ebay_order_not_found_in_workspace", null)
      return { status: "NEEDS_REVIEW", type: classified, matched: false }
    }
    await applyEbayCancelledEvent({
      workspaceId: ws,
      storeId: match.storeId,
      orderPk: match.orderPk,
      mailboxMessageId: row.id,
      parsed,
    })
    await markMessage(row.id, "PROCESSED", classified, parsed, null, match.orderPk)
    return { status: "PROCESSED", type: classified, matched: true }
  }

  await markMessage(row.id, "FAILED", classified, null, "unhandled_type", null)
  return { status: "FAILED", type: classified, matched: false }
}

async function markMessage(
  id: number,
  status: string,
  classified: MailboxClassifiedType,
  payload: unknown,
  reviewReason: string | null,
  matchedPk: number | null
): Promise<void> {
  await query(
    `UPDATE mailbox_messages
     SET processing_status = $2,
         classified_type = $3,
         parsed_payload = $4::jsonb,
         review_reason = $5,
         matched_ebay_order_pk = $6,
         store_id = CASE
           WHEN $6::bigint IS NULL THEN store_id
           ELSE (SELECT store_id FROM ebay_orders WHERE id = $6 AND workspace_id = mailbox_messages.workspace_id)
         END,
         processed_at = NOW(),
         updated_at = NOW()
     WHERE id = $1`,
    [id, status, classified, payload ? JSON.stringify(payload) : null, reviewReason, matchedPk]
  )
}

export type { AmazonEmailParse }

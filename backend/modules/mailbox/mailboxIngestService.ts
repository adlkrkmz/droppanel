import { query } from "../../db/client"
import {
  gmailGetMessage,
  gmailGetMessageMetadata,
  gmailGetProfile,
  gmailListTransactionalIds,
} from "./gmailClient"
import { classifyMailboxEmail, isSupportedMailboxType, isTransactionalWhitelistCandidate } from "./emailClassify"
import { getValidGmailAccessToken } from "./mailboxOAuthService"
import { processStoredMailboxMessage } from "./mailboxProcessService"

const MAX_PAGES = 6
const MAX_PROCESS = 40

export type MailboxIngestStats = {
  fetched: number
  bodiesFetched: number
  parsed: number
  matched: number
  needsReview: number
  ignored: number
  duplicates: number
  inserted: number
  processed: number
  lastError: string | null
}

function emptyStats(): MailboxIngestStats {
  return {
    fetched: 0,
    bodiesFetched: 0,
    parsed: 0,
    matched: 0,
    needsReview: 0,
    ignored: 0,
    duplicates: 0,
    inserted: 0,
    processed: 0,
    lastError: null,
  }
}

const ingestLocks = new Map<number, Promise<unknown>>()

export async function ingestMailboxAccount(accountId: number): Promise<MailboxIngestStats> {
  const prev = ingestLocks.get(accountId) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const chained = prev.then(() => gate, () => gate)
  ingestLocks.set(accountId, chained)
  await prev.catch(() => undefined)
  try {
    return await ingestMailboxAccountUnlocked(accountId)
  } finally {
    release()
    if (ingestLocks.get(accountId) === chained) ingestLocks.delete(accountId)
  }
}

async function ingestMailboxAccountUnlocked(accountId: number): Promise<MailboxIngestStats> {
  const stats = emptyStats()
  const acc = await query<{
    id: number
    workspace_id: string
  }>(
    `SELECT id, workspace_id::text FROM mailbox_accounts WHERE id = $1`,
    [accountId]
  )
  const row = acc.rows[0]
  if (!row) return stats

  let access: string
  try {
    access = await getValidGmailAccessToken(accountId)
  } catch (e) {
    await query(
      `UPDATE mailbox_accounts SET status = 'NEEDS_REAUTH', last_error = $2, updated_at = NOW() WHERE id = $1`,
      [accountId, e instanceof Error ? e.message.slice(0, 300) : "token"]
    )
    stats.lastError = e instanceof Error ? e.message.slice(0, 300) : "token"
    return stats
  }

  const ids = new Set<string>()
  try {
    await pullList(access, ids)
  } catch (e) {
    const msg = e instanceof Error ? e.message.slice(0, 300) : "gmail_list_failed"
    console.warn("[mailbox] list failed", accountId, msg)
    await query(
      `UPDATE mailbox_accounts SET last_error = $2, updated_at = NOW() WHERE id = $1`,
      [accountId, msg]
    )
    stats.lastError = msg
    return stats
  }
  stats.fetched = ids.size

  const existing = await query<{ provider_message_id: string }>(
    `SELECT provider_message_id FROM mailbox_messages WHERE mailbox_account_id = $1`,
    [accountId]
  )
  const knownIds = new Set(existing.rows.map(r => r.provider_message_id))

  const profile = await gmailGetProfile(access).catch(() => null)
  const newHistoryId = profile?.historyId ?? null

  for (const id of ids) {
    try {
      if (knownIds.has(id)) {
        stats.duplicates++
        continue
      }
      const meta = await gmailGetMessageMetadata(access, id)
      if (!isTransactionalWhitelistCandidate(meta.sender ?? "", meta.subject ?? "")) {
        stats.ignored++
        continue
      }
      const parsed = await gmailGetMessage(access, id)
      stats.bodiesFetched++
      if (!parsed.providerMessageId) {
        stats.ignored++
        continue
      }
      const classified = classifyMailboxEmail({
        sender: parsed.sender ?? "",
        subject: parsed.subject ?? "",
        textBody: parsed.textBody ?? "",
      })
      if (!isSupportedMailboxType(classified)) {
        stats.ignored++
        continue
      }
      stats.parsed++
      const ins = await query<{ id: number }>(
        `INSERT INTO mailbox_messages (
           workspace_id, store_id, mailbox_account_id, provider_message_id, rfc_message_id,
           thread_id, sender, recipient, subject, received_at, text_body, html_body,
           attachment_meta, inline_image_meta, processing_status
         ) VALUES (
           $1::uuid, NULL, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, 'PENDING'
         )
         ON CONFLICT (mailbox_account_id, provider_message_id) DO NOTHING
         RETURNING id`,
        [
          row.workspace_id,
          accountId,
          parsed.providerMessageId,
          parsed.rfcMessageId,
          parsed.threadId,
          parsed.sender,
          parsed.recipient,
          parsed.subject,
          parsed.receivedAt,
          parsed.textBody,
          parsed.htmlBody,
          JSON.stringify(parsed.attachments),
          JSON.stringify(parsed.inlineImages),
        ]
      )
      if (!ins.rows[0]?.id) {
        stats.duplicates++
        continue
      }
      stats.inserted++
    } catch (e) {
      console.warn("[mailbox] get message failed", id, e instanceof Error ? e.message : e)
    }
  }

  const pending = await query<{ id: number }>(
    `SELECT id FROM mailbox_messages
     WHERE mailbox_account_id = $1 AND processing_status = 'PENDING'
     ORDER BY received_at ASC NULLS LAST, id ASC
     LIMIT $2`,
    [accountId, MAX_PROCESS]
  )
  for (const p of pending.rows) {
    const result = await processStoredMailboxMessage(Number(p.id))
    stats.processed++
    if (result.matched) stats.matched++
    if (result.status === "NEEDS_REVIEW") stats.needsReview++
    if (result.status === "IGNORED") stats.ignored++
  }

  await query(
    `UPDATE mailbox_accounts
     SET history_id = COALESCE($2, history_id), last_ingested_at = NOW(), last_error = NULL, updated_at = NOW()
     WHERE id = $1`,
    [accountId, newHistoryId]
  )
  return stats
}

async function pullList(access: string, ids: Set<string>): Promise<void> {
  let page: string | undefined
  for (let i = 0; i < MAX_PAGES; i++) {
    const batch = await gmailListTransactionalIds(access, page)
    for (const id of batch.ids) ids.add(id)
    if (!batch.nextPageToken) break
    page = batch.nextPageToken
  }
}

export async function ingestAllConnectedMailboxes(): Promise<void> {
  const res = await query<{ id: number }>(
    `SELECT id FROM mailbox_accounts WHERE status = 'CONNECTED' ORDER BY last_ingested_at NULLS FIRST, id ASC LIMIT 20`
  )
  await runMailboxAccountBatch(res.rows.map(row => Number(row.id)), ingestMailboxAccount)
}

export async function runMailboxAccountBatch(
  accountIds: number[],
  ingest: (accountId: number) => Promise<unknown>
): Promise<void> {
  for (const accountId of accountIds) {
    try {
      await ingest(accountId)
    } catch (e) {
      console.warn("[mailbox] ingest account failed", accountId, e instanceof Error ? e.message : e)
    }
  }
}

let started = false
export function startMailboxIngestScheduler(): void {
  if (started) return
  started = true
  setInterval(() => {
    void ingestAllConnectedMailboxes()
  }, 5 * 60 * 1000)
  setTimeout(() => {
    void ingestAllConnectedMailboxes()
  }, 45_000)
}

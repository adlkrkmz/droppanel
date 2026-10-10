/** Shared limits for user-panel bulk write actions (Phase 5Q / 5R). */
export const BULK_LISTINGS_MAX = 50
export const BULK_IGNORE_MAX = 50
export const BULK_APPROVE_ZERO_MAX = 10
// Bulk End has no max — process the full eligible selection.

export function getBulkResultOutcomeMessage(
  requested: number,
  succeeded: number,
  failed:    number
): string {
  if (requested === 0) return "No items were processed."
  if (failed === 0) return "All selected items were processed successfully."
  if (succeeded === 0) return "No selected items could be processed."
  return "Some items could not be processed."
}

export function formatBulkBatchRef(batchId: string): string {
  const trimmed = batchId?.trim() ?? ""
  if (!trimmed) return ""
  return `Ref: ${trimmed.slice(0, 8)}`
}

export function bulkOverLimitTitle(max: number): string {
  return `Select at most ${max} eligible items per batch`
}

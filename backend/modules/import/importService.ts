import { query } from "../../db/client"
import {
  createAsinRegistryEntry,
  getAsinRegistryByAsin
} from "../registry/registryRepository"
import { createAsinPoolEntry } from "../pool/poolRepository"
import {
  createImportBatch,
  updateImportBatchSummary
} from "./importBatchRepository"
import {
  CooldownCheckResult,
  ImportRawInput,
  ImportSummary,
  ProcessedImportRow
} from "./importTypes"
import {
  dedupeByNormalizedValue,
  flattenCsvRows,
  isValidAsin,
  normalizeInputLines
} from "./importUtils"

async function isAlreadyInPool(
  workspaceId: string,
  asinRegistryId: number
): Promise<boolean> {
  const sql = `
    SELECT id
    FROM asin_pool
    WHERE workspace_id = $1
      AND asin_registry_id = $2
    LIMIT 1
  `

  const result = await query(sql, [workspaceId, asinRegistryId])

  const rowCount = result.rowCount ?? 0
  return rowCount > 0
}

async function checkBlacklistPlaceholder(): Promise<{
  blocked: boolean
  reason?: string
}> {
  return {
    blocked: false
  }
}

async function checkCooldownPlaceholder(): Promise<CooldownCheckResult> {
  return {
    blocked: false
  }
}

function buildInputLines(input: ImportRawInput): string[] {
  if (input.sourceType === "csv_rows") {
    return flattenCsvRows(input.lines)
  }

  return input.lines
}

export async function importAsins(
  input: ImportRawInput
): Promise<ImportSummary> {
  const batch = await createImportBatch({
    workspaceId: input.workspaceId,
    sourceType: input.sourceType,
    sourceName: input.sourceName ?? null,
    uploadedBy: input.uploadedBy ?? null
  })

  if (!batch?.id) {
    throw new Error("Failed to create import batch")
  }

  const rawLines = buildInputLines(input)
  const normalizedRows = dedupeByNormalizedValue(normalizeInputLines(rawLines))

  const rows: ProcessedImportRow[] = []

  let validRows = 0
  let readyCount = 0
  let skippedDuplicatePoolCount = 0
  let invalidCount = 0

  for (const row of normalizedRows) {
    const normalizedAsin = row.normalizedValue

    if (!normalizedAsin || !isValidAsin(normalizedAsin)) {
      rows.push({
        rawValue: row.rawValue,
        normalizedValue: normalizedAsin,
        lineNumber: row.lineNumber,
        classification: "invalid_asin",
        reason: "ASIN regex validation failed"
      })
      invalidCount += 1
      continue
    }

    validRows += 1

    const blacklistResult = await checkBlacklistPlaceholder()
    if (blacklistResult.blocked) {
      rows.push({
        rawValue: row.rawValue,
        normalizedValue: normalizedAsin,
        lineNumber: row.lineNumber,
        classification: "invalid_asin",
        reason: blacklistResult.reason ?? "Blacklisted"
      })
      invalidCount += 1
      continue
    }

    const cooldownResult = await checkCooldownPlaceholder()
    if (cooldownResult.blocked) {
      rows.push({
        rawValue: row.rawValue,
        normalizedValue: normalizedAsin,
        lineNumber: row.lineNumber,
        classification: "invalid_asin",
        reason: cooldownResult.reason ?? "Cooldown active"
      })
      invalidCount += 1
      continue
    }

    let registryRow = await getAsinRegistryByAsin(
      input.workspaceId,
      normalizedAsin
    )

    if (!registryRow) {
      registryRow = await createAsinRegistryEntry({
        workspaceId: input.workspaceId,
        asin: normalizedAsin
      })
    }

    if (!registryRow?.id) {
      rows.push({
        rawValue: row.rawValue,
        normalizedValue: normalizedAsin,
        lineNumber: row.lineNumber,
        classification: "invalid_asin",
        reason: "Registry write failed"
      })
      invalidCount += 1
      continue
    }

    const duplicatePool = await isAlreadyInPool(
      input.workspaceId,
      registryRow.id
    )

    if (duplicatePool) {
      rows.push({
        rawValue: row.rawValue,
        normalizedValue: normalizedAsin,
        lineNumber: row.lineNumber,
        classification: "skipped_duplicate_pool",
        asinRegistryId: registryRow.id,
        reason: "ASIN already exists in pool"
      })
      skippedDuplicatePoolCount += 1
      continue
    }

    await createAsinPoolEntry({
      workspaceId: input.workspaceId,
      asinRegistryId: registryRow.id,
      importBatchId: batch.id,
      status: "ready",
      scrapeStatus: "pending",
      aiStatus: "pending",
      listingStatus: "pending",
      pipelineStage: "imported"
    })

    rows.push({
      rawValue: row.rawValue,
      normalizedValue: normalizedAsin,
      lineNumber: row.lineNumber,
      classification: "ready_for_pool",
      asinRegistryId: registryRow.id
    })

    readyCount += 1
  }

  await updateImportBatchSummary({
    id: batch.id,
    totalRows: rawLines.length,
    validRows,
    readyCount,
    duplicatePoolCount: skippedDuplicatePoolCount,
    invalidCount,
    blacklistCount: 0,
    cooldownCount: 0,
    scrapeFailedCount: 0
  })

  return {
    workspaceId: input.workspaceId,
    sourceType: input.sourceType,
    sourceName: input.sourceName ?? null,
    uploadedBy: input.uploadedBy ?? null,
    totalRows: rawLines.length,
    validRows,
    readyCount,
    skippedDuplicatePoolCount,
    invalidCount,
    rows
  }
}
import "dotenv/config"
import { importAsins } from "./modules/import/importService"
import { getImportBatchById } from "./modules/import/importBatchRepository"
import { query, closeDbPool } from "./db/client"

async function printLatestBatchForSource(
  workspaceId: string,
  sourceName: string
) {
  const sql = `
    SELECT id
    FROM import_batches
    WHERE workspace_id = $1
      AND source_name = $2
    ORDER BY id DESC
    LIMIT 1
  `

  const result = await query<{ id: number }>(sql, [workspaceId, sourceName])
  const latest = result.rows[0]

  if (!latest) {
    console.log(`No batch found for source: ${sourceName}`)
    return
  }

  const batch = await getImportBatchById(latest.id)

  console.log(`IMPORT BATCH RECORD - ${sourceName}`)
  console.dir(batch, { depth: null })
}

async function main() {
  const workspaceId = process.env.WORKSPACE_ID

  if (!workspaceId) {
    throw new Error("WORKSPACE_ID is not defined")
  }

  const manualSourceName = "manual-test"
  const csvHeaderSourceName = "csv-header-test"
  const csvNoHeaderSourceName = "csv-no-header-test"

  const manualInput = await importAsins({
    workspaceId,
    sourceType: "manual_list",
    sourceName: manualSourceName,
    uploadedBy: "local-dev",
    lines: [
      "B0C1234567",
      " b0c1234567 ",
      "B0D9876543",
      "INVALID-ASIN",
      "123",
      "B0TEST9999"
    ]
  })

  console.log("MANUAL IMPORT RESULT")
  console.dir(manualInput, { depth: null })
  await printLatestBatchForSource(workspaceId, manualSourceName)

  const csvWithHeaderInput = await importAsins({
    workspaceId,
    sourceType: "csv_rows",
    sourceName: csvHeaderSourceName,
    uploadedBy: "local-dev",
    lines: [
      "asin,title",
      "B0AAA11111,Sample Product 1",
      "B0BBB22222,Sample Product 2",
      "invalid,Sample Product 3",
      "",
      "B0AAA11111,Duplicate Row"
    ]
  })

  console.log("CSV IMPORT RESULT - HEADER MODE")
  console.dir(csvWithHeaderInput, { depth: null })
  await printLatestBatchForSource(workspaceId, csvHeaderSourceName)

  const csvWithoutHeaderInput = await importAsins({
    workspaceId,
    sourceType: "csv_rows",
    sourceName: csvNoHeaderSourceName,
    uploadedBy: "local-dev",
    lines: [
      "B0CCC33333,Sample Product 3",
      "B0DDD44444,Sample Product 4",
      "invalid,Sample Product 5",
      "",
      "B0CCC33333,Duplicate Row"
    ]
  })

  console.log("CSV IMPORT RESULT - FIRST COLUMN FALLBACK")
  console.dir(csvWithoutHeaderInput, { depth: null })
  await printLatestBatchForSource(workspaceId, csvNoHeaderSourceName)
}

main()
  .catch((error) => {
    console.error("Import test failed:", error)
    process.exitCode = 1
  })
  .finally(async () => {
    await closeDbPool()
  })
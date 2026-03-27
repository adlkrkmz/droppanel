import "dotenv/config"
import { closeDbPool } from "./db/client"
import { importAsins } from "./modules/asinImport/asinImportService"

const workspaceId = process.env.WORKSPACE_ID
if (!workspaceId) throw new Error("WORKSPACE_ID is not defined in .env")
const WORKSPACE_ID: string = workspaceId

function sep(len = 60): void { console.log("  " + "─".repeat(len)) }

async function main(): Promise<void> {
  console.log("═".repeat(60))
  console.log("  test-asin-import")
  console.log("═".repeat(60))
  console.log(`  workspace : ${WORKSPACE_ID}`)
  console.log("")

  // ── Test 1: Karışık format ────────────────────────────────────

  console.log("[1/3] Karışık format girişi")
  sep()

  const result1 = await importAsins(WORKSPACE_ID, {
    asins: [
      "B0IMP00001",           // geçerli — yeni
      "B0IMP00002",           // geçerli — yeni
      "B0IMP00003",           // geçerli — yeni
      "B0IMP00001",           // input içi duplicate — atlanır
      "INVALIDASIN!",           // format hatası
      "short",                  // format hatası
      "B0IMP00001 B0IMP00004",  // boşlukla ayrılmış — parse edilir
    ]
  })

  console.log(`  Input      : ${result1.totalInput}`)
  console.log(`  Valid      : ${result1.valid}`)
  console.log(`  Inserted   : ${result1.inserted}`)
  console.log(`  Duplicate  : ${result1.skippedDuplicate}`)
  console.log(`  Conflict   : ${result1.skippedStoreConflict}`)
  console.log(`  Invalid    : ${result1.invalid}`)
  if (result1.insertedAsins.length > 0)
    console.log(`  Inserted   : ${result1.insertedAsins.join(", ")}`)
  if (result1.invalidAsins.length > 0)
    console.log(`  Invalid    : ${result1.invalidAsins.join(", ")}`)

  // ── Test 2: Aynı ASIN'leri tekrar import et (duplicate test) ──

  console.log("")
  console.log("[2/3] Duplicate koruması testi (aynı ASIN'ler)")
  sep()

  const result2 = await importAsins(WORKSPACE_ID, {
    asins: [
      "B0IMP00001",  // artık pool'da var → duplicate
      "B0IMP00002",  // artık pool'da var → duplicate
      "B0IMP00005",  // yeni
    ]
  })

  console.log(`  Input      : ${result2.totalInput}`)
  console.log(`  Inserted   : ${result2.inserted}`)
  console.log(`  Duplicate  : ${result2.skippedDuplicate}`)
  console.log(`  Conflict   : ${result2.skippedStoreConflict}`)
  if (result2.duplicateAsins.length > 0)
    console.log(`  Dup ASINs  : ${result2.duplicateAsins.join(", ")}`)

  // ── Test 3: Toplu virgüllü liste ──────────────────────────────

  console.log("")
  console.log("[3/3] Virgüllü liste formatı")
  sep()

  const result3 = await importAsins(WORKSPACE_ID, {
    asins: ["B0IMP00010,B0IMP00011,B0IMP00012,B0IMP0XXXX"]
  })

  console.log(`  Input      : ${result3.totalInput} (1 string, 4 ASIN içeriyor)`)
  console.log(`  Valid      : ${result3.valid}`)
  console.log(`  Inserted   : ${result3.inserted}`)
  console.log(`  Invalid    : ${result3.invalid}`)
  if (result3.invalidAsins.length > 0)
    console.log(`  Invalid    : ${result3.invalidAsins.join(", ")}`)

  // ── Toplam özet ───────────────────────────────────────────────

  const totalInserted = result1.inserted + result2.inserted + result3.inserted
  const totalDup      = result1.skippedDuplicate + result2.skippedDuplicate + result3.skippedDuplicate
  const totalInvalid  = result1.invalid + result2.invalid + result3.invalid

  console.log("")
  console.log("═".repeat(60))
  console.log(`  Tüm testler tamamlandı`)
  console.log(`  Toplam inserted : ${totalInserted}`)
  console.log(`  Toplam duplicate: ${totalDup}`)
  console.log(`  Toplam invalid  : ${totalInvalid}`)
  console.log("═".repeat(60))
}

main()
  .catch((err: unknown) => {
    console.error("[HATA]", err instanceof Error ? err.message : err)
    process.exit(1)
  })
  .finally(async () => { await closeDbPool() })

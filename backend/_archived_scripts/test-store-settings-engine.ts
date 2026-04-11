import "dotenv/config"
import { closeDbPool } from "./db/client"
import {
  upsertStoreSettings,
  updateStoreSettings,
  resolveSettingsForStore,
  getAllStoreSettings,
  enableStore,
  disableStore,
  validateSettings,
} from "./modules/storeSettings/storeSettingsService"
import type { ResolvedStoreSettings } from "./modules/storeSettings/storeSettingsTypes"

const workspaceId = process.env.WORKSPACE_ID
if (!workspaceId) throw new Error("WORKSPACE_ID is not defined in .env")
const WORKSPACE_ID: string = workspaceId

const TARGET_STORE_ID = parseInt(process.env.SETTINGS_STORE_ID ?? "1", 10)

// ─── HELPERS ──────────────────────────────────────────────────

function sep(len = 70): void {
  console.log("  " + "─".repeat(len))
}

function row(label: string, value: unknown): void {
  const display =
    value === null || value === undefined ? "null" :
    typeof value === "boolean" ? (value ? "true" : "false") :
    String(value)
  console.log(`  ${String(label).padEnd(28)} ${display}`)
}

function printSettings(s: ResolvedStoreSettings, title: string): void {
  console.log(`\n  ► ${title}`)
  sep()
  row("id",                    s.id)
  row("store",                 `${s.storeName} (${s.storeCode}) id=${s.storeId}`)
  row("enabled",               s.enabled)
  row("profitMarginPercent",   `${s.profitMarginPercent}%`)
  row("taxEstimatePercent",    `${s.taxEstimatePercent}%`)
  row("ebayFeePercent",        `${s.ebayFeePercent}%`)
  row("defaultQuantity",       s.defaultQuantity)
  row("intervalMinutes",       s.intervalMinutes)
  row("merchantLocationKey",   s.merchantLocationKey)
  row("paymentPolicyId",       s.paymentPolicyId)
  row("returnPolicyId",        s.returnPolicyId)
  row("fulfillmentPolicyId",   s.fulfillmentPolicyId)
  row("templateId",            s.templateId)
  row("createdAt",             s.createdAt)
  row("updatedAt",             s.updatedAt)
}

function printValidation(label: string, v: { valid: boolean; errors: string[]; warnings: string[] }): void {
  const icon = v.valid ? "✓" : "✗"
  console.log(`\n  ${icon} Validation: ${label}`)
  if (v.errors.length   > 0) v.errors.forEach(e   => console.log(`    ✗ ${e}`))
  if (v.warnings.length > 0) v.warnings.forEach(w => console.log(`    ⚠ ${w}`))
  if (v.errors.length === 0 && v.warnings.length === 0) {
    console.log("    — no issues")
  }
}

// ─── MAIN ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("═".repeat(70))
  console.log("  test-store-settings-engine")
  console.log("═".repeat(70))
  console.log(`  workspace : ${WORKSPACE_ID}`)
  console.log(`  storeId   : ${TARGET_STORE_ID}`)
  console.log("")

  // ── ADIM 1: Validation testi ──────────────────────────────────

  console.log("[1/5] Validation Testleri")

  printValidation("valid input", validateSettings({
    profitMarginPercent: 25,
    ebayFeePercent:      13,
    taxEstimatePercent:  8,
    defaultQuantity:     1,
    intervalMinutes:     30,
  }))

  printValidation("invalid — negative margin", validateSettings({
    profitMarginPercent: -5,
  }))

  printValidation("warning — low margin + missing policies", validateSettings({
    profitMarginPercent: 2,
    paymentPolicyId:     null,
  }))

  // ── ADIM 2: Upsert (oluştur veya güncelle) ────────────────────

  console.log("\n[2/5] Upsert Settings")
  sep()

  const { settings: upserted, validation: upsertVal, created } = await upsertStoreSettings({
    workspaceId:          WORKSPACE_ID,
    storeId:              TARGET_STORE_ID,
    profitMarginPercent:  20,
    taxEstimatePercent:   8,
    ebayFeePercent:       13,
    defaultQuantity:      1,
    intervalMinutes:      30,
    merchantLocationKey:  "warehouse-1",
    paymentPolicyId:      "PAY_POL_001",
    returnPolicyId:       "RET_POL_001",
    fulfillmentPolicyId:  "FUL_POL_001",
    enabled:              true,
  })

  console.log(`  ${created ? "✓ Created" : "✓ Updated"} — id=${upserted.id}`)
  printValidation("upsert", upsertVal)

  // ── ADIM 3: Oku ───────────────────────────────────────────────

  console.log("\n[3/5] Read Settings")

  const resolved = await resolveSettingsForStore(WORKSPACE_ID, TARGET_STORE_ID)
  if (resolved) {
    printSettings(resolved, "Current Settings")
  } else {
    console.log("  settings not found")
  }

  // ── ADIM 4: Update ────────────────────────────────────────────

  console.log("\n[4/5] Update Settings (margin → 25%, interval → 45min)")
  sep()

  const { settings: updated, validation: updateVal } = await updateStoreSettings(
    WORKSPACE_ID,
    TARGET_STORE_ID,
    {
      profitMarginPercent: 25,
      intervalMinutes:     45,
    }
  )

  console.log(`  ✓ Updated — updatedAt=${updated.updatedAt}`)
  printValidation("update", updateVal)

  // Disable → re-enable
  console.log("\n  Disable store settings...")
  const disabled = await disableStore(WORKSPACE_ID, TARGET_STORE_ID)
  console.log(`  enabled = ${disabled?.enabled}`)

  console.log("  Enable store settings...")
  const enabled = await enableStore(WORKSPACE_ID, TARGET_STORE_ID)
  console.log(`  enabled = ${enabled?.enabled}`)

  // ── ADIM 5: Tüm workspace settings tablosu ────────────────────

  console.log("\n[5/5] All Settings in Workspace")

  const all = await getAllStoreSettings(WORKSPACE_ID)

  if (all.length === 0) {
    console.log("  (kayıt yok)")
  } else {
    console.log("")
    console.log(
      `  ${"id".padEnd(6)}` +
      `${"store".padEnd(14)}` +
      `${"code".padEnd(8)}` +
      `${"margin".padEnd(10)}` +
      `${"fee".padEnd(8)}` +
      `${"qty".padEnd(6)}` +
      `${"interval".padEnd(10)}` +
      `enabled`
    )
    sep()
    for (const s of all) {
      console.log(
        `  ${String(s.id).padEnd(6)}` +
        `${s.storeName.slice(0, 13).padEnd(14)}` +
        `${s.storeCode.padEnd(8)}` +
        `${String(s.profitMarginPercent + "%").padEnd(10)}` +
        `${String(s.ebayFeePercent + "%").padEnd(8)}` +
        `${String(s.defaultQuantity).padEnd(6)}` +
        `${String(s.intervalMinutes + "min").padEnd(10)}` +
        `${s.enabled ? "✓" : "—"}`
      )
    }
  }

  // ── Final ─────────────────────────────────────────────────────

  console.log("")
  console.log("═".repeat(70))
  console.log(`  Toplam settings: ${all.length}`)
  console.log("  ✓ Store settings engine hazır")
  console.log("═".repeat(70))
}

main()
  .catch((err: unknown) => {
  console.error("[HATA FULL]", err)
  if (err instanceof Error) {
    console.error("[HATA MESSAGE]", err.message)
    console.error("[HATA STACK]", err.stack)
  }
  process.exit(1)
})

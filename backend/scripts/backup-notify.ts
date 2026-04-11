import dotenv from "dotenv"
import { execSync } from "child_process"
import * as path from "path"
import * as fs from "fs"

dotenv.config({ path: path.join(__dirname, "..", ".env") })

async function main() {
  const { alertBackupFailed, sendTelegramAlert } = await import(
    "../modules/notifications/telegramService"
  )

  const backupDir = path.join(__dirname, "../../backups")
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
  const filename = path.join(backupDir, `droppanel_${timestamp}.sql`)

  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true })
  }

  try {
    execSync(
      `"C:\\Program Files\\PostgreSQL\\18\\bin\\pg_dump.exe" -U postgres -d droppanel -f "${filename}"`,
      { env: { ...process.env, PGPASSWORD: process.env.DB_PASSWORD || "postgres" } }
    )

    await sendTelegramAlert(`✅ <b>Backup Başarılı</b>\nDosya: droppanel_${timestamp}.sql`)

    // 7 günden eski backupları sil
    const files = fs.readdirSync(backupDir)
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
    for (const file of files) {
      const filePath = path.join(backupDir, file)
      const stat = fs.statSync(filePath)
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(filePath)
      }
    }
  } catch (err) {
    await alertBackupFailed(err instanceof Error ? err.message : String(err))
  }
}

main().catch(console.error)

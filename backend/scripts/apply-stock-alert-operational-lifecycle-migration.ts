import "dotenv/config"
import fs from "fs"
import path from "path"
import { Pool } from "pg"

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error("DATABASE_URL is not defined")
  const sql = fs.readFileSync(
    path.join(__dirname, "../migrations/065_stock_alert_operational_lifecycle.sql"),
    "utf8"
  )
  const pool = new Pool({ connectionString: dbUrl })
  try {
    await pool.query(sql)
  } finally {
    await pool.end()
  }
  console.log("APPLIED migrations/065_stock_alert_operational_lifecycle.sql")
}

void main().catch(e => {
  console.error(e)
  process.exit(1)
})

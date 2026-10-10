import "dotenv/config"
import fs from "fs"
import path from "path"
import { Pool } from "pg"

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error("DATABASE_URL is not defined")
  const sql = fs.readFileSync(path.join(__dirname, "../migrations/063_desktop_agent.sql"), "utf8")
  const pool = new Pool({ connectionString: dbUrl })
  await pool.query(sql)
  await pool.end()
  console.log("APPLIED migrations/063_desktop_agent.sql")
}

void main().catch(e => {
  console.error(e)
  process.exit(1)
})

import fs from "fs"
import path from "path"
import "dotenv/config"
import { db } from "../db/client"

async function main(): Promise<void> {
  const sql = fs.readFileSync(
    path.join(__dirname, "../migrations/089_workspace_mailboxes.sql"),
    "utf8"
  )
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    await client.query(sql)
    await client.query("COMMIT")
    console.log("APPLIED migrations/089_workspace_mailboxes.sql")
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    client.release()
    await db.end()
  }
}

void main().catch(error => {
  console.error(error)
  process.exit(1)
})

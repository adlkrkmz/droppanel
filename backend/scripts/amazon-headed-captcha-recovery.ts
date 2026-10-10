/**
 * One-shot headed Amazon CAPTCHA recovery.
 * Uses ONLY var/amazon-browser-profile. Does not claim/reset/retry tasks.
 *
 * Signals:
 *   touch var/captcha-vnc/CAPTCHA_DONE  — optional nudge after solving
 *   touch var/captcha-vnc/ABORT         — abort without flipping account status
 */
import "dotenv/config"
import fs from "fs"
import path from "path"
import { chromium } from "playwright"
import { detectAmazonSession } from "../modules/amazonBrowserWorker/amazonLoginManager"
import { updateAmazonAccountStatus } from "../modules/amazonBrowserWorker/amazonWorkerAccountVault"
import { validateTokenEncryptionKeyAtStartup } from "../modules/security/tokenEncryption"
import { closeDbPool } from "../db/client"

validateTokenEncryptionKeyAtStartup()

const PROFILE = "/home/listjetgo/app/backend/var/amazon-browser-profile"
const WORKDIR = "/home/listjetgo/app/backend/var/captcha-vnc"
const STATUS = path.join(WORKDIR, "recovery-status.json")
const DONE = path.join(WORKDIR, "CAPTCHA_DONE")
const ABORT = path.join(WORKDIR, "ABORT")
const PRODUCT_URL = "https://www.amazon.com/dp/B08N5WRWNW"
const MAX_WAIT_MS = 45 * 60 * 1000

type Status = Record<string, unknown>

function writeStatus(patch: Status): void {
  const prev: Status = fs.existsSync(STATUS) ? JSON.parse(fs.readFileSync(STATUS, "utf8")) : {}
  const next = { ...prev, ...patch, updatedAt: new Date().toISOString() }
  fs.writeFileSync(STATUS, JSON.stringify(next, null, 2))
  console.log(`[recovery] ${String(next.phase)}: ${String(next.message || "")}`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function userConfirmedAfterLaunch(startedAtMs: number): boolean {
  try {
    return fs.statSync(DONE).mtimeMs >= startedAtMs - 1000
  } catch {
    return false
  }
}

async function main(): Promise<void> {
  if (process.env.DISPLAY !== ":99") {
    throw new Error(`Expected DISPLAY=:99, got ${process.env.DISPLAY}`)
  }
  if (fs.existsSync(path.join(PROFILE, "SingletonLock"))) {
    throw new Error("Profile SingletonLock present — another Chromium is using the profile")
  }

  writeStatus({
    phase: "LAUNCHING",
    message: "Starting headed Chromium on amazon-browser-profile",
    session: null,
  })

  const context = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
    args: ["--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check"],
  })
  const page = context.pages()[0] || (await context.newPage())
  for (const extra of context.pages().slice(1)) {
    await extra.close().catch(() => undefined)
  }

  writeStatus({ phase: "GOTO_HOME", message: "Opening amazon.com — solve CAPTCHA in VNC" })
  await page
    .goto("https://www.amazon.com/", { waitUntil: "domcontentloaded", timeout: 90000 })
    .catch((e: Error) => {
      writeStatus({ phase: "GOTO_HOME_WARN", message: String(e.message || e).slice(0, 200) })
    })

  const started = Date.now()
  let session = await detectAmazonSession(page)
  writeStatus({
    phase: "WAITING_CAPTCHA",
    message:
      "Complete the Amazon challenge in VNC, then touch var/captcha-vnc/CAPTCHA_DONE from a second SSH session",
    session,
    homeUrl: page.url(),
    homeTitle: await page.title().catch(() => ""),
  })

  while (Date.now() - started < MAX_WAIT_MS) {
    if (fs.existsSync(ABORT)) {
      writeStatus({ phase: "ABORTED", message: "ABORT marker present" })
      await context.close()
      await closeDbPool()
      process.exit(2)
    }
    session = await detectAmazonSession(page)
    writeStatus({
      phase: "WAITING_CAPTCHA",
      message: `session=${session}`,
      session,
      homeUrl: page.url(),
      homeTitle: await page.title().catch(() => ""),
      elapsedSec: Math.round((Date.now() - started) / 1000),
    })
    // Do not treat an automatically restored ACTIVE cookie as proof that a human completed the challenge.
    // The explicit marker must be created after this browser was launched.
    if (userConfirmedAfterLaunch(started)) {
      await page
        .goto("https://www.amazon.com/", { waitUntil: "domcontentloaded", timeout: 60000 })
        .catch(() => undefined)
      session = await detectAmazonSession(page)
      writeStatus({
        phase: "WAITING_CAPTCHA",
        message: `after CAPTCHA_DONE nudge session=${session}`,
        session,
        homeUrl: page.url(),
      })
      if (session === "ACTIVE") break
    }
    await sleep(5000)
  }

  if (session !== "ACTIVE") {
    writeStatus({
      phase: "TIMEOUT",
      message: "Session did not become ACTIVE; closing without flipping account",
      session,
    })
    await context.close().catch(() => undefined)
    await closeDbPool()
    process.exit(1)
  }

  writeStatus({ phase: "HOME_OK", message: "Homepage session ACTIVE", session, homeUrl: page.url() })

  writeStatus({ phase: "GOTO_PRODUCT", message: `Opening ${PRODUCT_URL}` })
  await page.goto(PRODUCT_URL, { waitUntil: "domcontentloaded", timeout: 90000 })
  await sleep(2500)
  const productTitle = await page.title().catch(() => "")
  const productSession = await detectAmazonSession(page)
  const productBodyHint = await page
    .locator("#productTitle, #title, #dp-container, #centerCol")
    .first()
    .textContent()
    .catch(() => "")
  writeStatus({
    phase: "PRODUCT_OK",
    message: "Product page loaded",
    session: productSession,
    productUrl: page.url(),
    productTitle,
    productHasTitle: Boolean((productBodyHint || "").trim()),
  })

  if (productSession === "CHALLENGE_REQUIRED") {
    writeStatus({
      phase: "PRODUCT_CHALLENGE",
      message: "Challenge returned on product page — not marking ACTIVE; closing",
      session: productSession,
    })
    await context.close().catch(() => undefined)
    await closeDbPool()
    process.exit(1)
  }

  await updateAmazonAccountStatus({
    accountStatus: "ONLINE",
    sessionState: "ACTIVE",
    lastError: null,
    lastLoginAt: new Date(),
  })

  writeStatus({ phase: "CLOSING", message: "Closing Chromium cleanly" })
  await context.close()
  writeStatus({
    phase: "DONE",
    message: "CAPTCHA recovery complete — profile free; restart headless worker next",
    session: "ACTIVE",
  })
  await closeDbPool()
}

main().catch(async (e: unknown) => {
  const msg = e instanceof Error ? e.stack || e.message : String(e)
  writeStatus({ phase: "ERROR", message: msg.slice(0, 800) })
  await closeDbPool().catch(() => undefined)
  process.exit(1)
})

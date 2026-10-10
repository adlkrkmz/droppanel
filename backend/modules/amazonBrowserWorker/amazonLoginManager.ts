import type { Locator, Page } from "playwright"
import { generateTotpCode } from "./totp"
import {
  decryptAmazonPassword,
  decryptAmazonTotpSecret,
  getAmazonWorkerAccount,
  updateAmazonAccountStatus,
  type AmazonWorkerAccountRow,
} from "./amazonWorkerAccountVault"
import { isAmazonChallengeUrl, isAmazonPageNotFound } from "./amazonPageExtract"

const AMAZON_SIGNIN_URL =
  "https://www.amazon.com/ap/signin?openid.pape.max_auth_age=0&openid.return_to=https%3A%2F%2Fwww.amazon.com%2F&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.assoc_handle=usflex&openid.mode=checkid_setup&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0"

const EMAIL_SEL = "#ap_email, #ap_email_login, input[name='email'], input[type='email']"
const PASSWORD_SEL = "#ap_password, input[name='password'][type='password']"
const OTP_SEL = "#auth-mfa-otpcode, input[name='otpCode'], #cvf-input-code, input[autocomplete='one-time-code']"
const CONTINUE_SEL = "input#continue, #continue input.a-button-input, #continue"
const SIGNIN_SEL = "#signInSubmit, input#signInSubmit"
const OTP_SUBMIT_SEL = "#auth-signin-button, input#auth-signin-button, #cvf-submit-otp-button, input[type='submit']"

export type LoginOutcome =
  | { ok: true; state: "ACTIVE" }
  | { ok: false; state: "LOGIN_REQUIRED" | "CHALLENGE_REQUIRED" | "LOGIN_FAILED"; reason: string }

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isAuthUrl(url: string): boolean {
  return /\/ap\/(signin|mfa|cvf|challenge)/i.test(url)
}

async function pageSignals(page: Page): Promise<{ url: string; title: string; body: string }> {
  const url = page.url()
  const title = await page.title().catch(() => "")
  const body = await page
    .evaluate(() => String(document.body && document.body.innerText ? document.body.innerText.slice(0, 800) : ""))
    .catch(() => "")
  return { url, title, body }
}

async function visibleCount(page: Page, selector: string): Promise<number> {
  const loc = page.locator(selector)
  const n = await loc.count()
  if (n === 0) return 0
  try {
    if (await loc.first().isVisible()) return n
  } catch {
    return 0
  }
  return 0
}

async function authErrorText(page: Page): Promise<string> {
  const loc = page.locator("#auth-error-message-box, #auth-warning-message-box, .a-alert-error").first()
  if ((await loc.count()) === 0) return ""
  return ((await loc.textContent().catch(() => "")) || "").trim()
}

export type AmazonSessionDetection = "ACTIVE" | "LOGIN_REQUIRED" | "CHALLENGE_REQUIRED" | "PAGE_NOT_FOUND"

export function isAmazonSignInLocation(url: string, title: string): boolean {
  const href = url.toLowerCase()
  return isAuthUrl(url) || /\/ap\/signin/.test(href) || /^amazon\s+sign[\s-]?in/.test(title.toLowerCase())
}

export async function detectAmazonSession(page: Page): Promise<AmazonSessionDetection> {
  const { url, title, body } = await pageSignals(page)
  const blob = `${title} ${body}`.toLowerCase()
  if (isAmazonChallengeUrl(url, title) || /solve this puzzle|enter the characters you see/.test(blob)) {
    return "CHALLENGE_REQUIRED"
  }
  if (isAmazonPageNotFound(title, body, url)) return "PAGE_NOT_FOUND"
  if (isAmazonSignInLocation(url, title)) return "LOGIN_REQUIRED"
  if ((await visibleCount(page, OTP_SEL)) > 0 && isAuthUrl(url)) return "LOGIN_REQUIRED"

  const nav = await page
    .locator("#nav-link-accountList-nav-line-1, #nav-link-accountList .nav-line-1, #nav-link-accountList")
    .first()
    .textContent()
    .catch(() => "")
  const navText = (nav || "").trim()

  // Logged-out chrome: "Hello, Sign in"
  if (/hello,\s*sign[\s-]?in/i.test(navText) || /^sign[\s-]?in$/i.test(navText)) {
    return "LOGIN_REQUIRED"
  }
  // Logged-in chrome: "Hello, <name>" (not Sign in)
  if (/hello,/i.test(navText) && !/sign[\s-]?in/i.test(navText)) {
    return "ACTIVE"
  }

  const signOutVisible = await visibleCount(page, "#nav-item-signout, a[href*='sign-out'], a[href*='signout']")
  if (signOutVisible > 0) return "ACTIVE"

  // Fail closed: do not treat unknown chrome as authenticated.
  if (/amazon\./i.test(url) && !isAuthUrl(url)) {
    return "LOGIN_REQUIRED"
  }
  return "LOGIN_REQUIRED"
}

async function waitVisible(page: Page, selector: string, timeout: number): Promise<Locator | null> {
  const el = page.locator(selector).first()
  try {
    await el.waitFor({ state: "visible", timeout })
    return el
  } catch {
    return null
  }
}

async function clickVisible(page: Page, selector: string, timeout = 8000): Promise<boolean> {
  const el = await waitVisible(page, selector, timeout)
  if (!el) return false
  await el.click({ timeout: 8000 })
  return true
}

async function failLogin(
  reason: string,
  state: "LOGIN_REQUIRED" | "CHALLENGE_REQUIRED" | "LOGIN_FAILED" = "LOGIN_REQUIRED"
): Promise<LoginOutcome> {
  const accountStatus = state === "CHALLENGE_REQUIRED" ? "CHALLENGE_REQUIRED" : "LOGIN_REQUIRED"
  const lastError =
    state === "LOGIN_FAILED" && !/^LOGIN_FAILED\b/.test(reason) ? `LOGIN_FAILED: ${reason}` : reason
  await updateAmazonAccountStatus({
    accountStatus,
    sessionState: state === "CHALLENGE_REQUIRED" ? "CHALLENGE" : "LOGIN_REQUIRED",
    lastError,
  })
  return { ok: false, state, reason: lastError }
}

export async function ensureAmazonSession(page: Page): Promise<LoginOutcome> {
  const detected = await detectAmazonSession(page)
  if (detected === "ACTIVE") {
    await updateAmazonAccountStatus({ accountStatus: "ONLINE", sessionState: "ACTIVE", lastError: null })
    return { ok: true, state: "ACTIVE" }
  }
  if (detected === "CHALLENGE_REQUIRED") {
    return failLogin("Amazon challenge requires admin review", "CHALLENGE_REQUIRED")
  }
  if (detected === "PAGE_NOT_FOUND") {
    await updateAmazonAccountStatus({ accountStatus: "ONLINE", sessionState: "ACTIVE", lastError: null })
    return { ok: true, state: "ACTIVE" }
  }
  const account = await getAmazonWorkerAccount()
  return performAmazonLogin(page, account)
}

export async function performAmazonLogin(page: Page, account: AmazonWorkerAccountRow): Promise<LoginOutcome> {
  if (!account.email || !account.passwordEncrypted) {
    return failLogin("Amazon account credentials are not configured")
  }

  let password: string | null = null
  let totpSecret: string | null = null
  try {
    password = decryptAmazonPassword(account)
    if (!password) return failLogin("Amazon password is not configured")

    if (!isAuthUrl(page.url())) {
      await page.goto(AMAZON_SIGNIN_URL, { waitUntil: "domcontentloaded", timeout: 45000 })
    }

    const opening = await detectAmazonSession(page)
    if (opening === "CHALLENGE_REQUIRED") {
      return failLogin("Amazon challenge during login", "CHALLENGE_REQUIRED")
    }
    if (opening === "ACTIVE") {
      password = null
      await updateAmazonAccountStatus({
        accountStatus: "ONLINE",
        sessionState: "ACTIVE",
        lastError: null,
        lastLoginAt: new Date(),
      })
      return { ok: true, state: "ACTIVE" }
    }

    const emailField = await waitVisible(page, EMAIL_SEL, 8000)
    if (emailField) {
      await emailField.fill("")
      await emailField.fill(account.email, { timeout: 8000 })
      await clickVisible(page, CONTINUE_SEL, 5000)
      await sleep(400)
    }

    const passwordReady = await waitVisible(page, PASSWORD_SEL, 15000)
    if (passwordReady) {
      await passwordReady.fill("")
      await passwordReady.fill(password, { timeout: 8000 })
      password = null
      await clickVisible(page, SIGNIN_SEL, 8000)
    } else {
      password = null
      const challengeNow = await detectAmazonSession(page)
      if (challengeNow === "CHALLENGE_REQUIRED") {
        return failLogin("Amazon challenge after email", "CHALLENGE_REQUIRED")
      }
      if (challengeNow !== "ACTIVE" && (await visibleCount(page, OTP_SEL)) === 0) {
        const err = await authErrorText(page)
        return failLogin(err ? err.slice(0, 200) : "Amazon password field did not appear", "LOGIN_FAILED")
      }
    }

    const otpEl = await waitVisible(page, OTP_SEL, 12000)
    if (otpEl) {
      if (!account.authenticatorEnabled || !account.totpSecretEncrypted) {
        return failLogin("TOTP_REQUIRED")
      }
      totpSecret = decryptAmazonTotpSecret(account)
      if (!totpSecret) return failLogin("TOTP_MISSING")
      const code = generateTotpCode(totpSecret)
      totpSecret = null
      await otpEl.fill(code)
      await clickVisible(page, OTP_SUBMIT_SEL, 8000)
    }

    await sleep(2000)
    const err = await authErrorText(page)
    if (err && /password|incorrect|e-mail|email|otp|code/i.test(err)) {
      return failLogin(err.slice(0, 200), "LOGIN_FAILED")
    }

    for (let i = 0; i < 8; i++) {
      const state = await detectAmazonSession(page)
      if (state === "ACTIVE") {
        await updateAmazonAccountStatus({
          accountStatus: "ONLINE",
          sessionState: "ACTIVE",
          lastError: null,
          lastLoginAt: new Date(),
        })
        return { ok: true, state: "ACTIVE" }
      }
      if (state === "CHALLENGE_REQUIRED") {
        return failLogin("Amazon extra verification required", "CHALLENGE_REQUIRED")
      }
      await sleep(1000)
    }

    const finalState = await detectAmazonSession(page)
    if (finalState === "ACTIVE") {
      await updateAmazonAccountStatus({
        accountStatus: "ONLINE",
        sessionState: "ACTIVE",
        lastError: null,
        lastLoginAt: new Date(),
      })
      return { ok: true, state: "ACTIVE" }
    }
    if (finalState === "CHALLENGE_REQUIRED") {
      return failLogin("Amazon extra verification required", "CHALLENGE_REQUIRED")
    }
    const finalErr = await authErrorText(page)
    return failLogin(finalErr ? finalErr.slice(0, 200) : "Amazon login did not complete", "LOGIN_FAILED")
  } finally {
    password = null
    totpSecret = null
  }
}

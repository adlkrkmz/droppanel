export const CONTINUE_SHOPPING_HINT = "Click the button below to continue shopping"
export const AMAZON_SCAN_PDP_READY_SELECTOR =
  "#dp, #buybox, #desktop_buybox_buybox, #buybox_feature_div, [id^=\"newAccordionRow_\"], #availability"

export type ContinueShoppingInspect = {
  hasHintText: boolean
  continueButtonVisible: boolean
  hasRealCaptcha: boolean
}

export type ContinueShoppingRecoveryOutcome = "none" | "recovered" | "incomplete" | "captcha"

export type ContinueShoppingRecoveryResult = {
  outcome: ContinueShoppingRecoveryOutcome
  clicks: number
  freshGotos: number
}

function visibleElement(element: Element | null): boolean {
  if (!element) return false
  if (element.getAttribute("aria-hidden") === "true") return false
  if (element.closest('[aria-hidden="true"], [hidden], .aok-hidden, .a-hidden')) return false
  const style = window.getComputedStyle(element)
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false
  const rect = element.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
}

function controlLabel(element: Element): string {
  const input = element as HTMLInputElement
  return `${input.value || ""} ${element.textContent || ""} ${element.getAttribute("aria-label") || ""}`
    .replace(/\s+/g, " ")
    .trim()
}

function findVisibleContinueShoppingControl(): Element | null {
  const nodes = Array.from(
    document.querySelectorAll(
      'button, input[type="submit"], input[type="button"], .a-button-input, span.a-button-text, a[role="button"]'
    )
  )
  for (const el of nodes) {
    if (!/^\s*continue shopping\s*$/i.test(controlLabel(el))) continue
    if (!visibleElement(el)) continue
    return el
  }
  return null
}

/** Browser-side inspect. Playwright `page.evaluate` serializes this function. */
export function inspectContinueShoppingDocument(): ContinueShoppingInspect {
  const body = `${document.body?.innerText || ""}\n${document.title || ""}`
  const hasHintText = /click the button below to continue shopping/i.test(body)
  const hasRealCaptcha = Boolean(
    document.querySelector(
      [
        'form[action*="validateCaptcha" i]',
        'form[action*="validatecaptcha" i]',
        'input[name*="captcha" i]',
        "#captchacharacters",
        'img[src*="captcha" i]',
        'img[alt*="captcha" i]',
      ].join(", ")
    )
  )
  return {
    hasHintText,
    continueButtonVisible: findVisibleContinueShoppingControl() != null,
    hasRealCaptcha,
  }
}

/** Browser-side single click. Returns false if the control is gone. */
export function clickVisibleContinueShoppingButton(): boolean {
  const el = findVisibleContinueShoppingControl()
  if (!el) return false
  ;(el as HTMLElement).click()
  return true
}

export function canonicalAmazonDpUrl(asin: string): string {
  const key = String(asin ?? "")
    .trim()
    .toUpperCase()
  return `https://www.amazon.com/dp/${key}?th=1`
}

export function decideContinueShoppingRecovery(input: {
  inspect: ContinueShoppingInspect
  recoveryAttempted: boolean
}): "none" | "click_once_then_fresh_goto" | "captcha_fail_closed" | "incomplete" {
  if (input.inspect.hasRealCaptcha) return "captcha_fail_closed"
  if (!input.inspect.hasHintText) return "none"
  if (input.recoveryAttempted) return "incomplete"
  if (!input.inspect.continueButtonVisible) return "incomplete"
  return "click_once_then_fresh_goto"
}

export async function recoverContinueShoppingInterstitial(hooks: {
  inspect: () => Promise<ContinueShoppingInspect>
  clickContinueOnce: () => Promise<boolean>
  freshGotoCanonicalDp: () => Promise<void>
  waitPdpReady: () => Promise<void>
}): Promise<ContinueShoppingRecoveryResult> {
  const first = await hooks.inspect()
  const firstDecision = decideContinueShoppingRecovery({ inspect: first, recoveryAttempted: false })
  if (firstDecision === "none") {
    return { outcome: "none", clicks: 0, freshGotos: 0 }
  }
  if (firstDecision === "captcha_fail_closed") {
    return { outcome: "captcha", clicks: 0, freshGotos: 0 }
  }
  if (firstDecision === "incomplete") {
    return { outcome: "incomplete", clicks: 0, freshGotos: 0 }
  }

  const clicked = await hooks.clickContinueOnce()
  if (!clicked) {
    return { outcome: "incomplete", clicks: 0, freshGotos: 0 }
  }
  await hooks.freshGotoCanonicalDp()
  await hooks.waitPdpReady()
  const second = await hooks.inspect()
  const secondDecision = decideContinueShoppingRecovery({ inspect: second, recoveryAttempted: true })
  if (secondDecision === "captcha_fail_closed") {
    return { outcome: "captcha", clicks: 1, freshGotos: 1 }
  }
  if (secondDecision === "none") {
    return { outcome: "recovered", clicks: 1, freshGotos: 1 }
  }
  return { outcome: "incomplete", clicks: 1, freshGotos: 1 }
}

/**
 * READ-ONLY probe: alternate / AOD offers for one ASIN. No DB/eBay mutations.
 */
import path from "node:path"
import { chromium } from "playwright"

async function main(): Promise<void> {
  const asin = process.argv[2] || "B07921PHCF"
  const profile = path.resolve("var/amazon-public-browser-profile/amazon-alt-probe")
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: true,
    timeout: 45000,
    locale: "en-US",
    timezoneId: "America/New_York",
    args: ["--disable-dev-shm-usage", "--lang=en-US"],
  })
  await ctx.addCookies([
    { name: "i18n-prefs", value: "USD", domain: ".amazon.com", path: "/" },
    { name: "lc-main", value: "en_US", domain: ".amazon.com", path: "/" },
  ])
  const page = ctx.pages()[0] ?? (await ctx.newPage())
  await page.goto("https://www.amazon.com/", { waitUntil: "domcontentloaded", timeout: 45000 })
  await page.waitForTimeout(800)
  await page.evaluate(async () => {
    await fetch("/gp/delivery/ajax/address-change.html", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "locationType=LOCATION_INPUT&zipCode=10001&storeContext=generic&deviceType=web&pageType=Gateway&actionSource=glow",
    })
  })
  await page.goto(`https://www.amazon.com/dp/${asin}?th=1`, { waitUntil: "domcontentloaded", timeout: 45000 })
  await page.waitForTimeout(2500)

  const before = await page.evaluate(() => {
    const text = (el: Element | null) => el?.textContent?.replace(/\s+/g, " ").trim() || null
    const buybox = document.querySelector("#buybox, #desktop_buybox_buybox, #buybox_feature_div")
    const links = Array.from(document.querySelectorAll("a, span, div"))
      .map((el) => ({
        tag: el.tagName,
        id: (el as HTMLElement).id || null,
        href: el.getAttribute("href"),
        t: text(el)?.slice(0, 120) || null,
      }))
      .filter((x) => x.t && /buying option|another way|other seller|new \(|from \$|aod/i.test(x.t))
      .slice(0, 40)
    return {
      url: location.href,
      buybox: text(buybox)?.slice(0, 500),
      links,
      aodPresent: Boolean(document.querySelector("#aod-container, #aod-offer-list, #aod-ingress-link")),
    }
  })
  console.log("BEFORE_CLICK", JSON.stringify(before, null, 2))

  // Try open AOD / buying options
  const clicked = await page.evaluate(() => {
    const candidates = [
      "#buybox-see-all-buying-choices-announce",
      "#buybox-see-all-buying-choices a",
      "a[href*='aod=1']",
      "#aod-ingress-link",
      "#olpLinkWidget_feature_div a",
      "a#aod-ingress-link",
      "span[data-action='show-all-offers-display']",
      "[data-action='aod-ingress']",
    ]
    for (const s of candidates) {
      const el = document.querySelector(s) as HTMLElement | null
      if (el) {
        el.click()
        return { clicked: s, text: el.textContent?.trim().slice(0, 80) }
      }
    }
    // text match
    const all = Array.from(document.querySelectorAll("a, span, button")) as HTMLElement[]
    for (const el of all) {
      const t = (el.textContent || "").replace(/\s+/g, " ").trim()
      if (/see all buying options|another way to buy|other sellers on amazon/i.test(t)) {
        el.click()
        return { clicked: "text:" + t.slice(0, 60), text: t.slice(0, 80) }
      }
    }
    return { clicked: null }
  })
  console.log("CLICK", clicked)
  await page.waitForTimeout(3500)

  // Also try URL with aod=1
  if (!clicked.clicked) {
    await page.goto(`https://www.amazon.com/dp/${asin}?th=1&aod=1`, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    })
    await page.waitForTimeout(3500)
  }

  const after = await page.evaluate(() => {
    const text = (el: Element | null) => el?.textContent?.replace(/\s+/g, " ").trim() || null
    const offers = Array.from(
      document.querySelectorAll("#aod-offer-list > div, #aod-offer, [id^='aod-offer-'], .aod-offer")
    ).slice(0, 20)
    const parsed = offers.map((offer, i) => {
      const t = text(offer) || ""
      const price =
        text(offer.querySelector(".a-price .a-offscreen, #aod-price-" + i + " .a-offscreen")) ||
        t.match(/\$\s*\d+(?:\.\d{2})?/)?.[0] ||
        null
      return {
        i,
        id: offer.id,
        price,
        ships: text(offer.querySelector("#aod-offer-shipsFrom, .aod-offer-shipsFrom, [id*='shipsFrom']")),
        sold: text(offer.querySelector("#aod-offer-soldBy, .aod-offer-soldBy, [id*='soldBy']")),
        condition: text(offer.querySelector("#aod-offer-heading, .aod-offer-heading, h5")),
        prime: Boolean(offer.querySelector(".a-icon-prime, [aria-label*='Prime' i]")),
        snippet: t.slice(0, 350),
      }
    })
    // "Another way to buy" cards outside AOD
    const altSection = Array.from(document.querySelectorAll("div, section")).find((el) =>
      /^Another way to buy/i.test((el.textContent || "").trim().slice(0, 40))
    )
    return {
      url: location.href,
      aodCount: offers.length,
      offers: parsed,
      aodHtmlSample: document.querySelector("#aod-container, #aod-offer-list")?.innerHTML?.slice(0, 1500) || null,
      altSection: altSection ? text(altSection)?.slice(0, 1000) : null,
      bodyMatch: (document.body?.innerText || "").match(/Another way to buy[\s\S]{0,1200}/i)?.[0]?.replace(/\s+/g, " ").slice(0, 1000) || null,
    }
  })
  console.log("AFTER", JSON.stringify(after, null, 2))
  await ctx.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

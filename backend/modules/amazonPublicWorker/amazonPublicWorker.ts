/**
 * Public (unauthenticated) Amazon browser worker — adapted from handoff amazon-worker.ts.
 * Changes vs lab (parser/observe DOM path unchanged):
 * - ./db → ./persistence (no SQLite)
 * - Profile under var/amazon-public-browser-profile (never login profile)
 * - Result includes observation/status for production consumers
 */
import path from 'node:path';
import { chromium, BrowserContext, Page } from 'playwright';
import { AppConfig, WorkerName } from './types';
import { logEvent, updateItem } from './persistence';
import { AmazonObservation, challengeReason, classifyAmazonObservation, parseAmazonSnapshot } from './parsing';
import { selectOfferObservation, type AccordionOfferRaw, type OfferSelectionResult } from './alternateOfferSelect';
import {
  AMAZON_SCAN_PDP_READY_SELECTOR,
  canonicalAmazonDpUrl,
  clickVisibleContinueShoppingButton,
  inspectContinueShoppingDocument,
  recoverContinueShoppingInterstitial,
} from './continueShoppingInterstitial';

export type AmazonWorkerState = { name: WorkerName; status: string; browserPid: number | null; lastError: string | null };
export type AmazonResult = {
  kind: 'done' | 'technical' | 'challenge';
  reason?: string;
  observation?: AmazonObservation;
  status?: string;
  selection?: OfferSelectionResult;
};

/** Legacy default root (pre-pool). Prefer per-slot dirs via constructor options. */
export const PUBLIC_AMAZON_PROFILE_ROOT = path.resolve(
  __dirname,
  '..',
  '..',
  'var',
  'amazon-public-browser-profile'
);

/** Public profile geo is often non-US; Stock Guard needs amazon.com US offer surface. */
const PUBLIC_US_ZIP = process.env.AMAZON_PUBLIC_US_ZIP?.trim() || '10001';

export class AmazonPublicWorker {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private state: AmazonWorkerState;
  private usDeliveryReady = false;
  private readonly profileDir: string;

  constructor(
    private readonly name: WorkerName,
    private readonly config: AppConfig,
    options?: { profileDir?: string }
  ) {
    this.profileDir =
      options?.profileDir?.trim() ||
      path.join(PUBLIC_AMAZON_PROFILE_ROOT, `amazon-${this.name}`);
    this.state = { name, status: 'COLD_STANDBY', browserPid: null, lastError: null };
  }

  getState(): AmazonWorkerState { return { ...this.state }; }

  getProfileDir(): string {
    return this.profileDir;
  }

  browserPid(): number | null {
    return this.state.browserPid;
  }

  async newSiblingPage(): Promise<Page> {
    await this.open();
    if (!this.context) throw new Error('Amazon context unavailable');
    const page = await this.context.newPage();
    page.setDefaultTimeout(this.config.navigationTimeout);
    return page;
  }

  primaryPage(): Page | null {
    return this.page;
  }

  async open(): Promise<void> {
    if (this.context) return;
    const profileDir = this.profileDir;
    this.context = await chromium.launchPersistentContext(profileDir, {
      headless: this.config.amazonHeadless,
      timeout: this.config.navigationTimeout,
      locale: 'en-US',
      timezoneId: 'America/New_York',
      chromiumSandbox: true,
      ignoreDefaultArgs: ['--no-sandbox', '--disable-setuid-sandbox'],
      args: ['--disable-dev-shm-usage', '--lang=en-US']
    });
    await this.context.addCookies([
      { name: 'i18n-prefs', value: 'USD', domain: '.amazon.com', path: '/' },
      { name: 'lc-main', value: 'en_US', domain: '.amazon.com', path: '/' }
    ]);
    this.page = this.context.pages()[0] ?? await this.context.newPage();
    this.page.setDefaultTimeout(this.config.navigationTimeout);
    const browser = this.context.browser() as unknown as { process?: () => { pid?: number } } | null;
    this.state.browserPid = browser?.process?.()?.pid ?? null;
    this.state.status = 'READY';
    this.state.lastError = null;
  }

  /** One-time US zip bootstrap so public IP geo (e.g. Finland/EUR) does not poison offer reads. */
  async ensureUsDeliveryLocation(page = this.page, opts?: { force?: boolean }): Promise<void> {
    if ((this.usDeliveryReady && !opts?.force) || !page) return;
    const navMs = Math.min(15000, Math.max(5000, this.config.navigationTimeout));
    // commit + timeout: domcontentloaded can hang under Amazon soft-blocks.
    await page.goto('https://www.amazon.com/', { waitUntil: 'commit', timeout: navMs });
    await page.waitForTimeout(800);
    const zip = PUBLIC_US_ZIP;
    const result = await page.evaluate(async (zipCode) => {
      try {
        const res = await fetch('/gp/delivery/ajax/address-change.html', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `locationType=LOCATION_INPUT&zipCode=${encodeURIComponent(zipCode)}&storeContext=generic&deviceType=web&pageType=Gateway&actionSource=glow`
        });
        const text = await res.text();
        return { ok: res.ok, text: text.slice(0, 240) };
      } catch (error) {
        return { ok: false, text: error instanceof Error ? error.message : String(error) };
      }
    }, zip);
    if (!result.ok || !/isAddressUpdated|successful/i.test(result.text)) {
      throw new Error(`US delivery zip bootstrap failed zip=${zip}: ${result.text}`);
    }
    this.usDeliveryReady = true;
    logEvent('AMAZON_PUBLIC_US_ZIP_SET', null, this.name, `zip=${zip}`);
  }

  /**
   * Abort in-flight Playwright work for THIS worker only (no pkill).
   * close() must not wait for a wedged goto to finish.
   */
  async abortOwnedBrowser(status = 'COLD_STANDBY'): Promise<void> {
    const page = this.page;
    const ctx = this.context;
    const pid = this.state.browserPid;
    this.page = null;
    this.context = null;
    this.usDeliveryReady = false;
    this.state.browserPid = null;
    this.state.status = status;
    try {
      await page?.close({ runBeforeUnload: false });
    } catch {
      /* goto should reject */
    }
    const closing = ctx?.close() ?? Promise.resolve();
    await Promise.race([
      closing.catch(() => undefined),
      new Promise<void>(resolve => setTimeout(resolve, 1500)),
    ]);
    if (pid && pid > 1 && pid !== process.pid) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }

  async close(status = 'COLD_STANDBY'): Promise<void> {
    await this.abortOwnedBrowser(status);
  }

  async observe(asin: string): Promise<AmazonResult> {
    try {
      await this.open();
      if (!this.page) throw new Error('Amazon page unavailable');
      await this.ensureUsDeliveryLocation(this.page);
      return await this.observeOnPage(this.page, asin);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.state.lastError = reason;
      logEvent(`AMAZON_${this.name}_TECHNICAL_ERROR`, asin, this.name, reason);
      return { kind: 'technical', reason };
    }
  }

  /** Same public reader as observe(); used by layout bench extra tabs/contexts. */
  async observeOnPage(page: Page, asin: string): Promise<AmazonResult> {
    const url = canonicalAmazonDpUrl(asin);
    try {
      logEvent(`AMAZON_${this.name}_STARTED`, asin, this.name, `url=${url}`);
      // commit + short settle: under Amazon soft-blocks, domcontentloaded often hangs forever.
      const response = await page.goto(url, { waitUntil: 'commit', timeout: this.config.navigationTimeout });
      await this.settleSamePageUrl(page);
      await page.waitForTimeout(1200);
      await this.waitForPdpReady(page);
      const recovery = await recoverContinueShoppingInterstitial({
        inspect: () => page.evaluate(inspectContinueShoppingDocument),
        clickContinueOnce: () => page.evaluate(clickVisibleContinueShoppingButton),
        freshGotoCanonicalDp: async () => {
          await page.goto(url, { waitUntil: 'commit', timeout: this.config.navigationTimeout });
        },
        waitPdpReady: () => this.waitForPdpReady(page),
      });
      if (recovery.outcome === 'captcha') {
        logEvent('AMAZON_CHALLENGE_PAUSED', asin, this.name, `url=${page.url()}; reason=captcha; recovery=fail_closed`);
        return { kind: 'challenge', reason: 'captcha' };
      }
      await this.settleSamePageUrl(page);
      const snapshot = await page.evaluate(() => {
        const root = document.querySelector('#desktop_buybox_buybox, #buybox, #buybox_feature_div, #tabular-buybox');
        const text = (element: Element | null) => element?.textContent?.replace(/\s+/g, ' ').trim() || null;
        const visible = (element: Element | null): boolean => {
          if (!element) return false;
          if (element.getAttribute('aria-hidden') === 'true' || element.closest('[aria-hidden=\"true\"], [hidden], .aok-hidden, .a-hidden')) return false;
          const style = window.getComputedStyle(element);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        const visibleText = (element: Element | null): string | null => {
          if (!element) return null;
          const clone = element.cloneNode(true) as Element;
          const originalNodes = Array.from(element.querySelectorAll('*'));
          const cloneNodes = Array.from(clone.querySelectorAll('*'));
          for (let index = cloneNodes.length - 1; index >= 0; index -= 1) {
            if (!visible(originalNodes[index] ?? null)) cloneNodes[index].remove();
          }
          return text(clone);
        };
        const scoped = (selector: string) => root?.querySelector(selector) ?? document.querySelector(selector);
        const scopedText = (selector: string) => text(scoped(selector));
        const all = (selectors: string[]) => selectors.map(scopedText).filter(Boolean).filter((value, index, values) => values.indexOf(value) === index).join(' | ') || null;
        const attr = (selector: string) => {
          const element = document.querySelector(selector);
          return element?.getAttribute('value') || element?.getAttribute('content') || element?.getAttribute('data-asin') || element?.textContent?.trim() || null;
        };
        const currentOfferSelectors = ['#desktop_buybox_buybox', '#buybox', '#buybox_feature_div', '#tabular-buybox'];
        const offerContext = currentOfferSelectors.map(selector => text(document.querySelector(selector))).filter(Boolean).filter((value, index, values) => values.indexOf(value) === index).join('\n') || null;
        // Prefer the already-scoped buybox node. The outer desktop buybox can
        // also contain visible alternate-condition links/rows.
        const activeRoot = [
          '#buybox [id^="newAccordionRow_"].a-accordion-active', '#buybox [id*="AccordionRow"].a-accordion-active', '[id^="newAccordionRow_"].a-accordion-active', '[id*="AccordionRow"].a-accordion-active',
          '#qualifiedBuybox', '#buybox', '#buybox_feature_div', '#tabular-buybox', '#desktop_buybox', root
        ].map(selector => typeof selector === 'string' ? document.querySelector(selector) : selector)
          .find(element => visible(element)) ?? root;
        const activeOfferContext = visibleText(activeRoot);
        const activeScoped = (selector: string) => activeRoot?.querySelector(selector);
        const activeScopedText = (selector: string) => visibleText(activeScoped(selector) ?? null);
        const activeAll = (selectors: string[]) => selectors.map(activeScopedText).filter(Boolean).filter((value, index, values) => values.indexOf(value) === index).join(" | ") || null;
        const primeMarkers = activeRoot ? Array.from(activeRoot.querySelectorAll(`.a-icon-prime, [aria-label*="Prime" i], [data-csa-c-content-id*="prime" i], [class*="prime" i]`)).map(element => text(element) || "__PRIME_BADGE__").join(" | ") : null;
        const offerText = offerContext || '';
        const activeOfferText = activeOfferContext || '';
        const purchaseEvidence = /add to cart|buy now|buy new|buy resale|ships from|sold by|availability|in stock|currently unavailable|out of stock|\$\s*\d/i.test(activeOfferText);
        const newOfferEvidence = Boolean(document.querySelector('#newBuyBoxPrice, #newOffer, #newAccordionRow')) || /\bbuy\s+new\b|\bnew\s+offer\b|\bnew\s+condition\b/i.test(offerText);
        const activeOfferEvidence = /\bbuy\s+new\b|\bnew\s+offer\b|\bnew\s+condition\b|\bone-time\s+purchase\b/i.test(activeOfferText);
        const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute('href') || document.querySelector('meta[property="og:url"]')?.getAttribute('content') || null;
        const asinMetadata = attr('#ASIN') || attr('input[name="ASIN"]') || attr('[itemprop="productID"]') || attr('#desktop_buybox_buybox [data-asin]') || attr('#buybox [data-asin]') || null;
        const selectedAsinMetadata = attr('[data-selected-asin]') || attr('[data-selectedasin]') || attr('#twister [data-asin]') || attr('select[name*="asin" i]') || null;

        const accordionOffers = Array.from(document.querySelectorAll('[id^="newAccordionRow_"]')).map((row) => {
          const rowText = text(row) || '';
          const buyingType =
            row.querySelector('[data-csa-c-buying-option-type]')?.getAttribute('data-csa-c-buying-option-type') ||
            row.getAttribute('data-csa-c-buying-option-type');
          const priceText =
            text(row.querySelector('.a-price .a-offscreen')) ||
            rowText.match(/\$\s*\d+(?:\.\d{2})?/)?.[0] ||
            null;
          const shipsFrom =
            rowText.match(/Ships from:\s*([^\n]+?)(?:\s+Sold by:|$)/i)?.[1]?.replace(/\s+/g, ' ').trim().slice(0, 80) ||
            null;
          const soldBy =
            rowText.match(/Sold by:\s*([^\n]+?)(?:\s+Get Fast|\s+FREE delivery|\s+Add to|\s+Or Prime|\s+Returns|\s*$)/i)?.[1]
              ?.replace(/\s+/g, ' ')
              .trim()
              .slice(0, 80) || null;
          const availability = rowText.match(/Only\s+\d+\s+left in stock[^]*|In Stock|Currently unavailable|Out of stock|Temporarily out of stock/i)?.[0] || null;
          const caption = text(row.querySelector('.accordion-caption span, .accordion-caption'));
          const primeIcon = Boolean(row.querySelector('.a-icon-prime, [aria-label*="Prime" i], .header-prime-logo'));
          return {
            id: (row as HTMLElement).id || '',
            buyingType,
            caption,
            priceText,
            shipsFrom,
            soldBy,
            availability,
            primeEvidence: rowText,
            primeIcon,
            rowText: rowText.slice(0, 1200),
          };
        });

        return {
          body: document.body?.innerText || '',
          title: document.title || '',
          canonical,
          finalUrl: location.href,
          asinMetadata,
          selectedAsinMetadata,
          mainPrices: activeAll(["#corePriceDisplay_desktop_feature_div .a-offscreen", "#priceblock_ourprice", "#priceblock_dealprice", "#price_inside_buybox", "#newBuyBoxPrice", ".a-price .a-offscreen"]) || all(["#corePriceDisplay_desktop_feature_div .a-offscreen", "#priceblock_ourprice", "#priceblock_dealprice", "#price_inside_buybox", "#newBuyBoxPrice", ".a-price .a-offscreen"]),
          primePrices: activeAll(["#primeExclusivePrice .a-offscreen", "#primeExclusivePrice"]) || all(["#primeExclusivePrice .a-offscreen", "#primeExclusivePrice"]),
          regularPrices: activeAll(["#regularPrice .a-offscreen", "#regularPrice", "#priceblock_saleprice", "#priceblock_ourprice"]) || all(["#regularPrice .a-offscreen", "#regularPrice", "#priceblock_saleprice", "#priceblock_ourprice"]),
          shipsFrom: activeAll(["#fulfillerInfoFeature_feature_div", "#tabular-buybox .tabular-buybox-text"]) || all(["#fulfillerInfoFeature_feature_div", "#tabular-buybox .tabular-buybox-text"]),
          soldBy: activeAll(["#sellerProfileTriggerId", "#merchant-info", "#tabular-buybox .tabular-buybox-text"]) || all(["#sellerProfileTriggerId", "#merchant-info", "#tabular-buybox .tabular-buybox-text"]),
          availability: activeAll(["#availability", "#outOfStock", "#deliveryBlockMessage"]),
          offerLabel: activeAll([".a-size-medium", ".accordion-caption span", ".accordion-caption"]) || all(["#buybox .a-size-medium", "#buybox_feature_div .a-size-medium", "#desktop_buybox_buybox .a-size-medium"])
          ,offerContext
          ,activeOfferContext
          ,activeOfferEvidence
          ,primeEvidence: primeMarkers ? `${primeMarkers} | ${activeOfferText}` : activeOfferText || null
          ,offerContextComplete: Boolean(activeRoot && activeOfferText && /add to cart|buy now|price|ships from|sold by|availability|delivery/i.test(activeOfferText))
          ,newOfferEvidence
          ,purchaseEvidence
          ,accordionOffers
        };
      });
      const challenge = challengeReason(`${snapshot.title}\n${snapshot.body}`);
      if (challenge) {
        logEvent('AMAZON_CHALLENGE_PAUSED', asin, this.name, `url=${response?.url() ?? snapshot.finalUrl}; reason=${challenge}`);
        return { kind: 'challenge', reason: challenge };
      }

      const primaryObservation: AmazonObservation = parseAmazonSnapshot({ ...snapshot, finalUrl: page.url() || snapshot.finalUrl });
      const accordionOffers = (snapshot as { accordionOffers?: AccordionOfferRaw[] }).accordionOffers ?? [];
      const selection = selectOfferObservation({
        primary: primaryObservation,
        accordionOffers,
      });
      const observation = selection.observation;
      let status = classifyAmazonObservation(observation, asin);
      if (recovery.outcome === "incomplete") {
        status = "AMAZON_INCOMPLETE";
      } else if (selection.finalSelectedSource === 'ALTERNATE' && selection.publicStatusHint) {
        status = selection.publicStatusHint;
      }
      const observationError = status === 'ASIN_MISMATCH_OBSERVED' ? status : null;
      updateItem(asin, {
        amazon_status: status,
        amazon_checked_at: new Date().toISOString(),
        amazon_worker: this.name,
        amazon_requested_asin: asin,
        amazon_actual_asin: observation.actualAsin,
        amazon_final_url: observation.finalUrl,
        amazon_page_exists: observation.pageExists ? 1 : 0,
        amazon_main_price: observation.mainPrice,
        amazon_prime_member_price: observation.primeMemberPrice,
        amazon_regular_price: observation.regularPrice,
        amazon_prime_visible: observation.primeVisible === null ? null : observation.primeVisible ? 1 : 0,
        amazon_ships_from: observation.shipsFrom,
        amazon_sold_by: observation.soldBy,
        amazon_availability: observation.availability,
        amazon_in_stock: observation.inStock === null ? null : observation.inStock ? 1 : 0,
        amazon_offer_label: observation.offerLabel,
        amazon_offer_condition: observation.offerCondition,
        amazon_new_offer_available: observation.newOfferAvailable === null ? null : observation.newOfferAvailable ? 1 : 0,
        amazon_error: observationError,
        amazon_claimed_at: null,
        amazon_offer_source: selection.finalSelectedSource,
        status
      });
      logEvent(
        `AMAZON_${this.name}_DONE`,
        asin,
        this.name,
        observation.pageExists
          ? `Public observation saved source=${selection.finalSelectedSource}`
          : 'Product not found observed'
      );
      return { kind: 'done', observation, status, selection };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.state.lastError = reason;
      logEvent(`AMAZON_${this.name}_TECHNICAL_ERROR`, asin, this.name, reason);
      return { kind: 'technical', reason };
    }
  }

  private async waitForPdpReady(page: Page): Promise<void> {
    await page
      .waitForSelector(AMAZON_SCAN_PDP_READY_SELECTOR, {
        timeout: Math.min(20000, this.config.navigationTimeout),
      })
      .catch(() => undefined);
  }

  private async settleSamePageUrl(page: Page): Promise<void> {
    let previous = page.url();
    let stableReads = 0;
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline && stableReads < 2) {
      await page.waitForTimeout(150);
      const current = page.url();
      if (current === previous) stableReads += 1;
      else { previous = current; stableReads = 0; }
    }
  }
}

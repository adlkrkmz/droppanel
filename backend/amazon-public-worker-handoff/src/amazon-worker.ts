import path from 'node:path';
import { chromium, BrowserContext, Page } from 'playwright';
import { AppConfig, WorkerName } from './types';
import { logEvent, updateItem } from './db';
import { AmazonObservation, challengeReason, classifyAmazonObservation, parseAmazonSnapshot } from './parsing';

export type AmazonWorkerState = { name: WorkerName; status: string; browserPid: number | null; lastError: string | null };
export type AmazonResult = { kind: 'done' | 'technical' | 'challenge'; reason?: string };

export class AmazonWorker {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private state: AmazonWorkerState;

  constructor(private readonly name: WorkerName, private readonly config: AppConfig) {
    this.state = { name, status: 'COLD_STANDBY', browserPid: null, lastError: null };
  }

  getState(): AmazonWorkerState { return { ...this.state }; }

  async open(): Promise<void> {
    if (this.context) return;
    const profileDir = path.resolve(__dirname, '..', 'data', 'browser-profiles', `amazon-${this.name}`);
    this.context = await chromium.launchPersistentContext(profileDir, { headless: this.config.amazonHeadless, timeout: this.config.navigationTimeout });
    this.page = this.context.pages()[0] ?? await this.context.newPage();
    this.page.setDefaultTimeout(this.config.navigationTimeout);
    const browser = this.context.browser() as unknown as { process?: () => { pid?: number } } | null;
    this.state.browserPid = browser?.process?.()?.pid ?? null;
    this.state.status = 'READY';
    this.state.lastError = null;
  }

  async close(status = 'COLD_STANDBY'): Promise<void> {
    await this.context?.close().catch(() => undefined);
    this.context = null;
    this.page = null;
    this.state.browserPid = null;
    this.state.status = status;
  }

  async observe(asin: string): Promise<AmazonResult> {
    const url = `https://www.amazon.com/dp/${asin}?th=1`;
    try {
      await this.open();
      if (!this.page) throw new Error('Amazon page unavailable');
      logEvent(`AMAZON_${this.name}_STARTED`, asin, this.name, `url=${url}`);
      const response = await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.config.navigationTimeout });
      await this.settleSamePageUrl();
      const snapshot = await this.page.evaluate(() => {
        const root = document.querySelector('#desktop_buybox_buybox, #buybox, #buybox_feature_div, #tabular-buybox');
        const text = (element: Element | null) => element?.textContent?.replace(/\s+/g, ' ').trim() || null;
        const scoped = (selector: string) => root?.querySelector(selector) ?? document.querySelector(selector);
        const scopedText = (selector: string) => text(scoped(selector));
        const all = (selectors: string[]) => selectors.map(scopedText).filter(Boolean).filter((value, index, values) => values.indexOf(value) === index).join(' | ') || null;
        const attr = (selector: string) => {
          const element = document.querySelector(selector);
          return element?.getAttribute('value') || element?.getAttribute('content') || element?.getAttribute('data-asin') || element?.textContent?.trim() || null;
        };
        const currentOfferSelectors = ['#desktop_buybox_buybox', '#buybox', '#buybox_feature_div', '#tabular-buybox'];
        const offerContext = currentOfferSelectors.map(selector => text(document.querySelector(selector))).filter(Boolean).filter((value, index, values) => values.indexOf(value) === index).join('\n') || null;
        const primeMarkers = root ? Array.from(root.querySelectorAll('.a-icon-prime, [aria-label*="Prime" i], [data-csa-c-content-id*="prime" i], [class*="prime" i]')).map(element => text(element) || '__PRIME_BADGE__').join(' | ') : null;
        const offerText = offerContext || '';
        const purchaseEvidence = /add to cart|buy now|buy new|buy resale|ships from|sold by|availability|in stock|currently unavailable|out of stock|\$\s*\d/i.test(offerText);
        const newOfferEvidence = Boolean(document.querySelector('#newBuyBoxPrice, #newOffer, #newAccordionRow')) || /\bbuy\s+new\b|\bnew\s+offer\b|\bnew\s+condition\b/i.test(offerText);
        const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute('href') || document.querySelector('meta[property="og:url"]')?.getAttribute('content') || null;
        const asinMetadata = attr('#ASIN') || attr('input[name="ASIN"]') || attr('[itemprop="productID"]') || attr('#desktop_buybox_buybox [data-asin]') || attr('#buybox [data-asin]') || null;
        const selectedAsinMetadata = attr('[data-selected-asin]') || attr('[data-selectedasin]') || attr('#twister [data-asin]') || attr('select[name*="asin" i]') || null;
        return {
          body: document.body?.innerText || '',
          title: document.title || '',
          canonical,
          finalUrl: location.href,
          asinMetadata,
          selectedAsinMetadata,
          mainPrices: all(['#corePriceDisplay_desktop_feature_div .a-offscreen', '#priceblock_ourprice', '#priceblock_dealprice', '#price_inside_buybox', '#newBuyBoxPrice', '.a-price .a-offscreen']),
          primePrices: all(['#primeExclusivePrice .a-offscreen', '#primeExclusivePrice', '[data-csa-c-content-id*="prime" i] .a-offscreen']),
          regularPrices: all(['#regularPrice .a-offscreen', '#regularPrice', '#priceblock_saleprice', '#priceblock_ourprice']),
          shipsFrom: all(['#fulfillerInfoFeature_feature_div', '#tabular-buybox .tabular-buybox-text']),
          soldBy: all(['#sellerProfileTriggerId', '#merchant-info', '#tabular-buybox .tabular-buybox-text']),
          availability: all(['#availability', '#outOfStock', '#deliveryBlockMessage']),
          offerLabel: all(['#buybox .a-size-medium', '#buybox_feature_div .a-size-medium', '#desktop_buybox_buybox .a-size-medium'])
          ,offerContext
          ,primeEvidence: primeMarkers ? `${primeMarkers} | ${offerText}` : offerText || null
          ,offerContextComplete: Boolean(root && offerText && /add to cart|buy now|price|ships from|sold by|availability|delivery/i.test(offerText))
          ,newOfferEvidence
          ,purchaseEvidence
        };
      });
      const challenge = challengeReason(`${snapshot.title}\n${snapshot.body}`);
      if (challenge) {
        logEvent('AMAZON_CHALLENGE_PAUSED', asin, this.name, `url=${response?.url() ?? snapshot.finalUrl}; reason=${challenge}`);
        return { kind: 'challenge', reason: challenge };
      }

      const observation: AmazonObservation = parseAmazonSnapshot({ ...snapshot, finalUrl: this.page.url() || snapshot.finalUrl });
      const status = classifyAmazonObservation(observation, asin);
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
        status
      });
      logEvent(`AMAZON_${this.name}_DONE`, asin, this.name, observation.pageExists ? 'Public observation saved' : 'Product not found observed');
      return { kind: 'done' };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.state.lastError = reason;
      logEvent(`AMAZON_${this.name}_TECHNICAL_ERROR`, asin, this.name, reason);
      return { kind: 'technical', reason };
    }
  }

  private async settleSamePageUrl(): Promise<void> {
    if (!this.page) return;
    let previous = this.page.url();
    let stableReads = 0;
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline && stableReads < 2) {
      await this.page.waitForTimeout(150);
      const current = this.page.url();
      if (current === previous) stableReads += 1;
      else { previous = current; stableReads = 0; }
    }
  }
}

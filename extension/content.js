/**
 * DropPanel — Amazon content script.
 * Extracts Amazon DOM data and responds to:
 *   - { type: "CAPTURE" }
 */
(function () {
  'use strict';

  const MAX_IMAGES = 10;

  function text(el) {
    if (!el) return '';
    return (el.textContent || '').trim();
  }

  function getAsin() {
    const m =
      location.pathname.match(/\/dp\/([A-Z0-9]{10})/i) ||
      location.pathname.match(/\/gp\/product\/([A-Z0-9]{10})/i);
    if (m) return m[1].toUpperCase();
    const dataAsin = document.querySelector('[data-asin][data-asin!=""]');
    if (dataAsin) return (dataAsin.getAttribute('data-asin') || '').trim().toUpperCase().slice(0, 10);
    return '';
  }

  function getTitle() {
    return text(document.querySelector('#productTitle')) || text(document.querySelector('#title'));
  }

  function getBrand() {
    const byline = document.querySelector('#bylineInfo');
    if (byline) {
      const a = byline.querySelector('a');
      if (a) return text(a).replace(/^Visit the\s+|^Brand:\s+|^by\s+/i, '').trim();
      return text(byline).replace(/^Visit the\s+|^Brand:\s+|^by\s+/i, '').trim();
    }
    const brandCell = document.querySelector('.po-brand .po-break-word');
    if (brandCell) return text(brandCell);
    return '';
  }

  function parsePrice(str) {
    if (!str) return 0;
    const num = str.replace(/[^0-9.,]/g, '').replace(',', '.');
    const n = parseFloat(num);
    return isNaN(n) ? 0 : n;
  }

  function getPrice() {
    const sel = [
      '.a-price .a-offscreen',
      '.a-price-whole',
      '#priceblock_ourprice',
      '#priceblock_dealprice',
      '#corePrice_feature_div .a-offscreen',
      '#corePrice_desktop .a-offscreen',
      '.aok-align-center .a-offscreen',
    ];
    for (const s of sel) {
      const el = document.querySelector(s);
      if (el) {
        const v = parsePrice(text(el));
        if (v > 0) return v;
      }
    }
    return 0;
  }

  function getCurrency() {
    const el = document.querySelector('.a-price-symbol');
    if (el) return text(el).replace(/^[\s$€£¥]+|[\s$€£¥]+$/g, '') || 'USD';
    if (document.querySelector('[data-a-color="price"]')) return 'USD';
    return 'USD';
  }

  function getImages() {
    const seen = new Set();
    const urls = [];

    function addUrl(src) {
      if (!src || typeof src !== 'string') return;
      if (!src.includes('media-amazon.com/images/I/')) return;
      if (src.includes('play-button') || src.includes('PKplay') || src.includes('.SS')) return;

      // SL3000 formatına çevir
      const upscaled = src.replace(/\._[A-Z0-9_,]+(?:_[A-Z0-9_,]+)*_\./, '._SL3000_.');

      // Base: sadece görsel ID kısmı (parametre öncesi)
      const base = upscaled.split('/').pop()?.split('.')[0] || upscaled;
      if (seen.has(base)) return;
      seen.add(base);
      urls.push(upscaled);
    }

    // Script'lerden hiRes URL'lerini çek
    try {
      const scripts = document.querySelectorAll('script');
      for (const s of scripts) {
        const text = s.innerText || s.textContent || '';
        if (!text.includes('colorImages')) continue;

        // Önce hiRes URL'lerini dene
        const hiResMatches = text.matchAll(/"hiRes"\s*:\s*"([^"]+)"/g);
        for (const m of hiResMatches) {
          addUrl(m[1]);
        }

        // hiRes bulunamazsa large URL'lerini kullan
        if (urls.length === 0) {
          const largeMatches = text.matchAll(/"large"\s*:\s*"([^"]+)"/g);
          for (const m of largeMatches) {
            addUrl(m[1]);
          }
        }

        if (urls.length > 0) break;
      }
    } catch(e) {}

    // Fallback: DOM'dan çek
    if (urls.length === 0) {
      const imgs = document.querySelectorAll('#imageBlock img, .imgTagWrapper img, #altImages img');
      for (const img of imgs) {
        const hires = img.getAttribute('data-old-hires') || img.src;
        if (hires) addUrl(hires);
        if (urls.length >= MAX_IMAGES) break;
      }
    }

    return urls.slice(0, MAX_IMAGES);
  }

  function getBullets() {
    const bullets = [];
    const items = document.querySelectorAll('#feature-bullets li .a-list-item, #feature-bullets ul li span.a-list-item');
    items.forEach(function (el) {
      const t = text(el);
      if (t && !/^[\s•\-]*$/.test(t)) bullets.push(t);
    });
    return bullets;
  }

  function getDescription() {
    const desc = document.querySelector('#productDescription p, #productDescription');
    if (desc) return text(desc);
    const aplus = document.querySelector('#aplus_feature_div');
    if (aplus) return text(aplus).slice(0, 5000);
    return '';
  }

  function getSpecs() {
    const spec = {};
    const SKIP_KEYS = new Set([
      'customer reviews',
      'best sellers rank',
      'asin',
      'date first available',
      'manufacturer',
      'item model number',
      'country of origin',
    ]);

    function cleanKV(s) {
      return (s || '')
        .replace(/[\n\t:]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    }

    function addSpec(rawKey, rawValue) {
      const k = cleanKV(rawKey);
      const v = cleanKV(rawValue);
      if (!k || !v) return;
      if (SKIP_KEYS.has(k.toLowerCase())) return;
      // Skip JS/function-like content fragments (e.g. Amazon inline scripts).
      if (v.includes('P.when') || v.includes('function(')) return
      // Trim overly long values to keep payload small/noisy.
      const vv = v.length > 500 ? v.slice(0, 200) : v
      spec[k] = vv;
    }

    function parseThTdTable(tableSelector) {
      const table = document.querySelector(tableSelector);
      if (!table) return;
      const rows = table.querySelectorAll('tr');
      rows.forEach(function (row) {
        const th = row.querySelector('th');
        const td = row.querySelector('td');
        if (th && td) addSpec(text(th), text(td));
      });
    }

    parseThTdTable('#productDetails_techSpec_section_1 table');
    parseThTdTable('#productDetails_detailBullets_sections1 table');

    // .prodDetTable -> th=key, td=value
    document.querySelectorAll('.prodDetTable tr').forEach(function (row) {
      const th = row.querySelector('th');
      const td = row.querySelector('td');
      if (th && td) addSpec(text(th), text(td));
    });

    // #detailBullets_feature_div li -> span[0]=key, span[1]=value
    document.querySelectorAll('#detailBullets_feature_div li').forEach(function (li) {
      const spans = li.querySelectorAll('span');
      if (spans && spans.length >= 2) {
        addSpec(text(spans[0]), text(spans[1]));
      }
    });

    // Product information tablosu
    document.querySelectorAll('table.a-normal tr').forEach(function (row) {
      const key = row.querySelector('td:first-child span') ? row.querySelector('td:first-child span').textContent.trim() : null;
      const val = row.querySelector('td:last-child span') ? row.querySelector('td:last-child span').textContent.trim() : null;
      if (key && val) addSpec(key, val);
    });

    // Detail bullets listesi
    document.querySelectorAll('.detail-bullet-list .a-list-item').forEach(function (item) {
      const boldEl = item.querySelector('.a-text-bold');
      const bold = boldEl && boldEl.textContent ? boldEl.textContent.replace(/[:\u200f\u200e]/g, '').trim() : '';
      if (!bold) return;
      const raw = item.textContent || '';
      const val = raw
        .replace(bold, '')
        .replace(/[:\u200f\u200e]/g, '')
        .trim();
      if (val) addSpec(bold, val);
    });

    // Product information - alternatif tablo yapısı
    document.querySelectorAll('#productDetails_feature_div table tr').forEach(function(row) {
      const cells = row.querySelectorAll('td')
      if (cells.length >= 2) {
        addSpec(text(cells[0]), text(cells[1]))
      }
      const th = row.querySelector('th')
      const td = row.querySelector('td')
      if (th && td) addSpec(text(th), text(td))
    });

    // Technical details tablosu
    document.querySelectorAll('#technicalSpecifications_feature_div table tr').forEach(function(row) {
      const th = row.querySelector('th');
      const td = row.querySelector('td');
      if (th && td) addSpec(text(th), text(td));
    });

    // Additional details
    document.querySelectorAll('.content-grid-block table tr').forEach(function(row) {
      const th = row.querySelector('th');
      const td = row.querySelector('td');
      if (th && td) addSpec(text(th), text(td));
    });

    // a-keyvalue span çiftleri
    document.querySelectorAll('.a-section .a-keyvalue tr').forEach(function(row) {
      const th = row.querySelector('th');
      const td = row.querySelector('td');
      if (th && td) addSpec(text(th), text(td));
    });

    return spec;
  }

  function getRating() {
    const el = document.querySelector('.a-icon-star .a-icon-alt, .a-icon-star-small .a-icon-alt, i[data-rating]');
    if (el) {
      const alt = el.getAttribute('alt') || el.textContent || '';
      const m = alt.match(/([0-9.]+)\s*out of/);
      if (m) return parseFloat(m[1]) || 0;
    }
    return 0;
  }

  function getReviews() {
    const el = document.querySelector('#acrCustomerReviewText');
    if (el) {
      const m = text(el).replace(/,/g, '').match(/([0-9]+)/);
      if (m) return parseInt(m[1], 10) || 0;
    }
    return 0;
  }

  function getBsr() {
    const detail =
      document.getElementById('productDetails_detailBullets_sections1') ||
      document.querySelector('#productDetails_detailBullets_sections1');
    const body = detail ? detail.textContent : (document.body.textContent || '');
    const m = body.match(/Best Sellers Rank[:\s#]*([0-9,]+)/i);
    if (m) return parseInt(m[1].replace(/,/g, ''), 10) || null;
    return null;
  }

  function getCategory() {
    const bread = document.querySelector('#wayfinding-breadcrumbs_container a, .nav-a');
    if (bread) return text(bread);
    const links = document.querySelectorAll('#wayfinding-breadcrumbs_container a');
    if (links.length) return text(links[links.length - 1]);
    return '';
  }

  function getIsPrime() {
    const body = document.body.innerHTML;
    return (
      /prime/i.test(body) &&
      (/prime\s*eligible/i.test(body) ||
        /delivery\s*by\s*amazon/i.test(body) ||
        !!document.querySelector('.prime-badge, .prime-icon, #prime-badge'))
    );
  }

  function getIsFreeShipping() {
    const body = document.body.textContent || '';
    return /free\s*(delivery|shipping)/i.test(body);
  }

  function capture() {
    const asin = getAsin();
    const title = getTitle();
    if (!asin || !title) {
      return { ok: false, error: 'Could not find ASIN or title. Open an Amazon product page (e.g. /dp/B0xxxxx).' };
    }

    const data = {
      asin: asin,
      title: title,
      brand: getBrand(),
      price: getPrice(),
      currency: getCurrency(),
      images: getImages(),
      bullets: getBullets(),
      description: getDescription(),
      specs: getSpecs(),
      rating: getRating(),
      reviews: getReviews(),
      bsr: getBsr(),
      category: getCategory(),
      isPrime: getIsPrime(),
      isFreeShipping: getIsFreeShipping(),
    };

    return { ok: true, data: data };
  }

  chrome.runtime.onMessage.addListener(function (request, _sender, sendResponse) {
    if (request.type === 'CAPTURE') {
      const result = capture();
      sendResponse(result);
      return true;
    }
    return false;
  });
})();

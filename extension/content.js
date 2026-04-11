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
    // Önce klasik #productDescription — tüm paragraf ve liste öğelerini al
    const descBlock = document.querySelector('#productDescription');
    if (descBlock) {
      // Tüm metin içerikli öğeleri topla
      const parts = [];
      descBlock.querySelectorAll('p, li, span.a-list-item').forEach(function(el) {
        const t = (el.textContent || '').trim();
        if (t && t.length > 10) parts.push(t);
      });
      if (parts.length > 0) return parts.join(' ').slice(0, 5000);
      // Fallback: tüm textContent
      const t = text(descBlock);
      if (t) return t.slice(0, 5000);
    }

    // Yeni Amazon layout: #productDescription_feature_div
    const descFeature = document.querySelector('#productDescription_feature_div');
    if (descFeature) {
      const t = text(descFeature);
      if (t) return t.slice(0, 5000);
    }

    // A+ içerik (genelde görsel ağırlıklı ama yine de dene)
    const aplus = document.querySelector('#aplus_feature_div, #aplus');
    if (aplus) {
      const parts = [];
      aplus.querySelectorAll('p, li, h3, h4').forEach(function(el) {
        const t = (el.textContent || '').trim();
        if (t && t.length > 10) parts.push(t);
      });
      if (parts.length > 0) return parts.join(' ').slice(0, 5000);
    }

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

    if (request.type === 'CAPTURE_TEMU') {
      if (!location.href.includes('temu.com')) {
        sendResponse({ ok: false, error: 'Temu sayfasında değilsiniz' })
        return true
      }
      try {
        // Başlık
        let title = ''
        for (const s of ['h1', '[data-testid="goods-title"]', '.goods-title']) {
          const el = document.querySelector(s)
          if (el) { title = (el.textContent || '').replace(/\s+/g, ' ').trim(); break }
        }
        if (!title) throw new Error('Başlık bulunamadı')

        // Görsel toplama — DOM: kwcdn.com/product/ img, goods-img-external / recommend hariç; yedek top_gallery_url
        const seen = new Set()
        const images = []

        const allImgs = document.querySelectorAll('img[src*="kwcdn.com/product/"]')
        for (let i = 0; i < allImgs.length; i++) {
          const img = allImgs[i]
          if (images.length >= 8) break
          const src = img.src
          if (!src) continue

          const parentClasses =
            String(img.parentElement && img.parentElement.className ? img.parentElement.className : '') +
            ' ' +
            String(img.parentElement && img.parentElement.parentElement && img.parentElement.parentElement.className
              ? img.parentElement.parentElement.className
              : '')
          if (parentClasses.includes('goods-img-external')) continue
          if (parentClasses.includes('recommend')) continue
          if (parentClasses.includes('_2F5wHDYz')) continue

          let clean = src.split('?')[0]
          const lower = clean.toLowerCase()

          if (lower.includes('avatar') || lower.includes('review') || lower.includes('seller')) continue
          if (lower.includes('upload_aimg') || lower.includes('commimg') || lower.includes('openingemail')) continue

          if (seen.has(lower)) continue
          seen.add(lower)
          images.push(clean)
        }

        if (images.length === 0) {
          try {
            const topUrl = new URL(window.location.href).searchParams.get('top_gallery_url')
            if (topUrl) {
              const dec = decodeURIComponent(topUrl).split('?')[0]
              images.push(dec)
            }
          } catch (e) {}
        }

        if (!images.length) throw new Error('Görsel bulunamadı')

        // Fiyat
        const bodyText = document.body.innerText || ''
        const priceMatches = bodyText.match(/\$\s?\d+(?:[.,]\d{1,2})?/g)
        let price = 0
        if (priceMatches) {
          const nums = priceMatches.map(v => parseFloat(v.replace('$','').replace(',','.').trim())).filter(n => Number.isFinite(n) && n >= 0.5)
          if (nums.length) price = Math.min(...nums)
        }
        if (!price) throw new Error('Fiyat bulunamadı')

        // Ürün ID
        let goodsId = null
        try { goodsId = new URL(window.location.href).searchParams.get('goods_id') } catch(e) {}
        if (!goodsId) {
          const m = window.location.href.match(/goods_id[=_](\d+)/) || window.location.href.match(/-(\d{10,})[.?]/)
          goodsId = m ? m[1] : null
        }
        if (!goodsId) throw new Error('Ürün ID bulunamadı')

        // Reviews
        let reviews = 0
        document.querySelectorAll('*').forEach(el => {
          if (!reviews && el.children.length === 0) {
            const m = el.textContent?.match(/^(\d+)\s+reviews?$/)
            if (m) reviews = parseInt(m[1])
          }
        })

        // Rating
        let rating = 0
        const ratingM = bodyText.match(/Excellent\s+(\d+\.\d+)/i) || bodyText.match(/(\d+\.\d+)\s*★/i)
        if (ratingM) rating = parseFloat(ratingM[1])

        sendResponse({
          ok: true,
          data: {
            asin: 'TEMU' + goodsId,
            external_id: goodsId,
            source: 'temu',
            title,
            brand: '',
            price,
            currency: 'USD',
            images,
            bullets: [],
            description: '',
            specs: {},
            rating,
            reviews,
            bsr: null,
            category: '',
            isPrime: false,
            isFreeShipping: true
          }
        })
      } catch(e) {
        sendResponse({ ok: false, error: e.message })
      }
      return true
    }

    return false;
  });
})();

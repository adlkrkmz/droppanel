// Port of extension/content.js verification readers (Prime/stock/price/merchant).
// Loaded in page.evaluate; do not log secrets.

function text(el) {
  if (!el) return "";
  return (el.textContent || "").trim();
}

function getAsin() {
  var pathMatch =
    location.pathname.match(/\/dp\/([A-Z0-9]{10})/i) ||
    location.pathname.match(/\/gp\/product\/([A-Z0-9]{10})/i);
  if (pathMatch) return pathMatch[1].toUpperCase();
  var asinInput = document.querySelector("#ASIN, input[name='ASIN']");
  var fromInput = asinInput && asinInput.getAttribute
    ? (asinInput.getAttribute("value") || asinInput.value || "").trim().toUpperCase()
    : "";
  if (/^[A-Z0-9]{10}$/.test(fromInput)) return fromInput;
  return "";
}

function getPageUrlAsin() {
  var m =
    location.pathname.match(/\/dp\/([A-Z0-9]{10})/i) ||
    location.pathname.match(/\/gp\/product\/([A-Z0-9]{10})/i);
  return m ? m[1].toUpperCase() : "";
}

function getCanonicalAsin() {
  try {
    var link = document.querySelector("link[rel='canonical']");
    var href = link && link.getAttribute ? String(link.getAttribute("href") || "") : "";
    var m = href.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
    if (m) return m[1].toUpperCase();
  } catch (e) {}
  return "";
}

/** Prefer final URL ASIN, then canonical link, then page DOM/metadata. Never invent from requested. */
function resolveActualPageAsin() {
  var fromUrl = getPageUrlAsin();
  if (fromUrl) return fromUrl;
  var fromCanonical = getCanonicalAsin();
  if (fromCanonical) return fromCanonical;
  var fromDom = getAsin();
  if (/^[A-Z0-9]{10}$/.test(fromDom)) return fromDom;
  return "";
}

function getTitle() {
  return text(document.querySelector("#productTitle")) || text(document.querySelector("#title"));
}

function parsePrice(str) {
  if (!str) return 0;
  var num = String(str).replace(/[^0-9.,]/g, "").replace(",", ".");
  var n = parseFloat(num);
  return isNaN(n) ? 0 : n;
}

function getPrice() {
  var sel = [
    "#corePriceDisplay_desktop_feature_div .apex-pricetopay-value .a-offscreen",
    "#corePrice_feature_div .apex-pricetopay-value .a-offscreen",
    ".apex-pricetopay-value .a-offscreen",
    '#desktop_buybox .a-price[data-a-color="base"] .a-offscreen',
    '#corePrice_feature_div .a-price[data-a-color="base"] .a-offscreen',
    "#corePriceDisplay_desktop_feature_div .a-offscreen",
    "#corePrice_feature_div .a-offscreen",
    "#corePrice_desktop .a-offscreen",
    "#priceblock_ourprice",
    "#priceblock_dealprice",
    "#desktop_buybox .a-price .a-offscreen",
    ".a-price .a-offscreen",
    ".a-price-whole",
  ];
  for (var s = 0; s < sel.length; s++) {
    var el = document.querySelector(sel[s]);
    if (el) {
      var v = parsePrice(text(el));
      if (v > 0) return v;
    }
  }
  return 0;
}

function getCurrency() {
  var el = document.querySelector(".a-price-symbol");
  if (el) return text(el).replace(/^[\s$€£¥]+|[\s$€£¥]+$/g, "") || "USD";
  return "USD";
}

function getBuyBoxRoots() {
  var roots = [];
  var selectors = ["#desktop_buybox", "#buybox", "#qualifiedBuybox"];
  for (var i = 0; i < selectors.length; i++) {
    var el = document.querySelector(selectors[i]);
    if (el) roots.push(el);
  }
  var deliverySelectors = [
    "#mir-layout-DELIVERY_BLOCK",
    "#deliveryBlockMessage",
    "#ddmDeliveryMessage",
    "#deliveryPromise_feature_div",
  ];
  for (var d = 0; d < deliverySelectors.length; d++) {
    var del = document.querySelector(deliverySelectors[d]);
    if (!del) continue;
    if (del.closest("#desktop_buybox, #buybox, #qualifiedBuybox")) roots.push(del);
  }
  return roots;
}

function elementVisible(el) {
  if (!el) return false;
  try {
    if (el.getAttribute && el.getAttribute("aria-hidden") === "true") return false;
    if (el.closest && el.closest('[aria-hidden="true"], [hidden], .aok-hidden, .a-hidden')) return false;
    var style = window.getComputedStyle(el);
    if (style && (style.display === "none" || style.visibility === "hidden" || style.opacity === "0")) return false;
    var rect = el.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return false;
    if (rect.width < 8 || rect.height < 8) return false;
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Prime = visible Amazon Prime badge icon only (not delivery/promo text).
 * Selectors: i.a-icon-prime, span.a-icon-prime, .a-icon.a-icon-prime
 * (covers Inspect-confirmed i.a-icon.a-icon-prime).
 */
function isDisallowedPrimeContext(el) {
  if (!el || !el.closest) return true;
  if (!el.closest("#desktop_buybox, #buybox, #qualifiedBuybox")) return true;
  var bad = el.closest(
    [
      "#nav-main", "#nav-belt", "#navbar", "#nav-logo-sprites",
      "#nav-global-location-slot", "#nav-flyout-anchor",
      "#olp_feature_div", "#olpLinkWidget_feature_div", "#moreBuyingChoices_feature_div",
      "#buybox-see-all-buying-choices", "#aod-container", "#aod-offer-list",
      "#marketplaceFeatureDiv", "#alternativeOfferCapabilityAccordion",
      '[id*="aod-"]', "[data-aod-id]", ".aod-offer",
      "#prime-benefit-feature", "#primeUpsell", "#primeBadgeUpsell",
      "#primeMembershipUpsell", "#pep-signup-link",
    ].join(",")
  );
  if (bad) return true;
  var ctx = "";
  try {
    var host = el.closest("div, span, li, section, tr") || el.parentElement;
    if (host) ctx = (host.textContent || "").slice(0, 400);
  } catch (e) {}
  if (/other\s+sellers\s+on\s+amazon|new\s*&\s*used\s*\(/i.test(ctx)) return true;
  if (/for\s+prime\s+members|join\s+prime|try\s+prime|prime\s+membership|prime\s+video|prime\s+gaming|prime\s+music/i.test(ctx)) {
    return true;
  }
  return false;
}

function detectSelectedOfferPrime() {
  var evidence = [];
  var roots = getBuyBoxRoots();
  if (roots.length === 0) {
    return { primeStatus: "UNKNOWN", isPrime: null, evidence: ["no_buybox_root"] };
  }
  for (var r = 0; r < roots.length; r++) {
    var root = roots[r];
    try {
      var icons = root.querySelectorAll("i.a-icon-prime, span.a-icon-prime, .a-icon.a-icon-prime");
      for (var i = 0; i < icons.length; i++) {
        var icon = icons[i];
        if (!elementVisible(icon)) continue;
        if (isDisallowedPrimeContext(icon)) {
          evidence.push("rejected_a-icon-prime_disallowed_context");
          continue;
        }
        evidence.push("buybox_a-icon-prime");
        return { primeStatus: "PRIME", isPrime: true, evidence: evidence };
      }
    } catch (e) {}
  }
  evidence.push("buybox_no_visible_prime_badge");
  // Explicit NOT_PRIME only when buybox offer area is clearly loaded; otherwise UNKNOWN.
  var buyboxReady =
    getHasAddToCart() ||
    getHasBuyNow() ||
    getPrice() > 0 ||
    Boolean(document.querySelector("#desktop_buybox #availability, #buybox #availability, #availabilityInsideBuyBox_feature_div"));
  if (buyboxReady) {
    return { primeStatus: "NOT_PRIME", isPrime: false, evidence: evidence };
  }
  evidence.push("buybox_not_ready_for_prime_negative");
  return { primeStatus: "UNKNOWN", isPrime: null, evidence: evidence };
}

var LIMITED_STOCK_RE = /only\s+(\d+)\s+(?:item(?:s)?\s+)?left(?:\s+in\s+stock)?/i;
var OUT_OF_STOCK_RE = /currently\s+unavailable|temporarily\s+out\s+of\s+stock|\bout\s+of\s+stock\b|we\s+don'?t\s+know\s+when\s+or\s+if this item will be back/i;
var NORMAL_IN_STOCK_RE = /\bin\s+stock\b/i;

function isDisallowedStockContext(el) {
  if (!el || !el.closest) return true;
  var bad = el.closest(
    [
      "#olp_feature_div", "#olpLinkWidget_feature_div", "#moreBuyingChoices_feature_div",
      "#buybox-see-all-buying-choices", "#aod-container", "#aod-offer-list",
      "#marketplaceFeatureDiv", "#alternativeOfferCapabilityAccordion",
      '[id*="aod-"]', ".aod-offer",
      "#quantity", "#quantity-select", 'select[name="quantity"]',
      "#nav-main", "#nav-belt", "#navbar",
    ].join(",")
  );
  if (bad) return true;
  var ctx = "";
  try {
    var host = el.closest("div, span, li, section") || el.parentElement;
    if (host) ctx = (host.textContent || "").slice(0, 300);
  } catch (e) {}
  if (/other\s+sellers\s+on\s+amazon|new\s*&\s*used\s*\(/i.test(ctx)) return true;
  return false;
}

function visibleBuyBoxButton(selectors) {
  var nodes = document.querySelectorAll(selectors);
  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i];
    if (!elementVisible(el)) continue;
    if (el.disabled || el.getAttribute("disabled") != null || el.getAttribute("aria-disabled") === "true") continue;
    return true;
  }
  return false;
}

function getHasAddToCart() {
  return visibleBuyBoxButton(
    [
      "#add-to-cart-button",
      "#add-to-cart-button-ubb",
      'input[name="submit.add-to-cart"]',
      'input[name="submit.addToCart"]',
      '#desktop_buybox input[name="submit.add-to-cart"]',
      '#buybox input[name="submit.add-to-cart"]',
      "input#add-to-cart-button",
    ].join(",")
  );
}

function getHasBuyNow() {
  return visibleBuyBoxButton(
    [
      "#buy-now-button",
      'input[name="submit.buy-now"]',
      'input[name="submit.buyNow"]',
      "#buyNow_feature_div input[type='submit']",
      "#desktop_buybox #buy-now-button",
    ].join(",")
  );
}

function detectSelectedOfferStock() {
  var evidence = [];
  var selectors = [
    "#availabilityInsideBuyBox_feature_div #availability",
    "#desktop_buybox #availability",
    "#buybox #availability",
    "#qualifiedBuybox #availability",
    "#desktop_buybox_feature_div #availability",
    "#availabilityInsideBuyBox_feature_div",
    "#desktop_buybox #availability_feature_div",
    "#buybox #availability_feature_div",
    "#availability",
    "#outOfStock",
  ];
  var seen = [];
  var texts = [];
  for (var i = 0; i < selectors.length; i++) {
    var nodes = document.querySelectorAll(selectors[i]);
    for (var n = 0; n < nodes.length; n++) {
      var el = nodes[n];
      if (seen.indexOf(el) !== -1) continue;
      seen.push(el);
      if (!elementVisible(el)) continue;
      if (isDisallowedStockContext(el)) continue;
      var inBuybox = !!(el.closest && el.closest("#desktop_buybox, #buybox, #qualifiedBuybox, #availabilityInsideBuyBox_feature_div"));
      var t = text(el);
      if (!t) continue;
      texts.push({ text: t, inBuybox: inBuybox });
    }
  }
  var preferred = texts.filter(function (x) { return x.inBuybox; });
  var pool = preferred.length > 0 ? preferred : texts;
  var inStockNode = null;
  var limitedNode = null;
  var oosNode = null;
  for (var p = 0; p < pool.length; p++) {
    var candidate = pool[p].text.replace(/\s+/g, " ").trim();
    if (!candidate) continue;
    if (NORMAL_IN_STOCK_RE.test(candidate) && !OUT_OF_STOCK_RE.test(candidate)) {
      inStockNode = candidate;
      break;
    }
    if (!limitedNode && LIMITED_STOCK_RE.test(candidate)) limitedNode = candidate;
    if (!oosNode && OUT_OF_STOCK_RE.test(candidate)) oosNode = candidate;
  }
  var availabilityText = inStockNode || limitedNode || oosNode || (pool[0] && pool[0].text) || "";
  availabilityText = String(availabilityText).replace(/\s+/g, " ").trim();
  if (!availabilityText) {
    evidence.push("availability_missing");
    if (getHasAddToCart() || getHasBuyNow()) {
      evidence.push("purchase_buttons_without_availability_text");
      return { stockStatus: "IN_STOCK", availabilityText: "", stockEvidence: evidence };
    }
    return { stockStatus: "UNKNOWN", availabilityText: "", stockEvidence: evidence };
  }
  if (inStockNode) {
    evidence.push("availability_in_stock");
    return { stockStatus: "IN_STOCK", availabilityText: availabilityText, stockEvidence: evidence };
  }
  if (OUT_OF_STOCK_RE.test(availabilityText)) {
    evidence.push("availability_out_of_stock");
    return { stockStatus: "OUT_OF_STOCK", availabilityText: availabilityText, stockEvidence: evidence };
  }
  var lim = availabilityText.match(LIMITED_STOCK_RE);
  if (lim) {
    evidence.push("availability_only_" + lim[1] + "_left");
    return { stockStatus: "LIMITED_STOCK", availabilityText: availabilityText, stockEvidence: evidence };
  }
  if (NORMAL_IN_STOCK_RE.test(availabilityText)) {
    evidence.push("availability_in_stock");
    return { stockStatus: "IN_STOCK", availabilityText: availabilityText, stockEvidence: evidence };
  }
  evidence.push("availability_unclassified");
  return { stockStatus: "UNKNOWN", availabilityText: availabilityText, stockEvidence: evidence };
}

function normalizeMerchantSpace(s) {
  return String(s || "")
    .replace(/\u00a0/g, " ")
    .replace(/[\u2007\u202f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isMerchantLabelOnly(v) {
  return /^(ships\s*from|shipper(\s*\/\s*seller)?|sold\s*by|seller|fulfiller|fulfilled\s*by)[:\s]*$/i.test(
    normalizeMerchantSpace(v)
  );
}

function getMerchantOffer() {
  var ships = "";
  var sold = "";

  function setShips(v) {
    v = normalizeMerchantSpace(v);
    if (!v || ships || isMerchantLabelOnly(v)) return;
    ships = v;
  }
  function setSold(v) {
    v = normalizeMerchantSpace(v);
    if (!v || sold || isMerchantLabelOnly(v)) return;
    sold = v;
  }
  function applyLabelValue(label, value) {
    var L = normalizeMerchantSpace(label)
      .toLowerCase()
      .replace(/[:：]+$/g, "");
    var V = normalizeMerchantSpace(value);
    if (!V || isMerchantLabelOnly(V)) return;
    if (/shipper\s*\/\s*seller|shipper\s+and\s+seller/.test(L)) {
      setShips(V);
      setSold(V);
      return;
    }
    if (/^ships\s*from$|^shipper$|^fulfiller$|^fulfilled\s*by$/.test(L) || /ships\s*from|fulfilled\s*by/.test(L)) {
      setShips(V);
      return;
    }
    if (/^sold\s*by$|^seller$/.test(L) || /sold\s*by/.test(L)) {
      setSold(V);
    }
  }

  var attrNodes = document.querySelectorAll(
    "#tabular-buybox [tabular-attribute-name], #merchantInfoFeature_feature_div [tabular-attribute-name], #fulfillerInfoFeature_feature_div [tabular-attribute-name], #offerDisplayGroup_feature_div [tabular-attribute-name]"
  );
  for (var a = 0; a < attrNodes.length; a++) {
    var attrName = attrNodes[a].getAttribute("tabular-attribute-name") || "";
    var msg = attrNodes[a].querySelector(
      ".tabular-buybox-text-message, .offer-display-feature-text-message, .a-color-base"
    );
    var attrVal = text(msg);
    if (!attrVal) {
      var full = normalizeMerchantSpace(text(attrNodes[a]));
      var stripped = full.replace(
        new RegExp("^" + attrName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*:?\\s*", "i"),
        ""
      );
      attrVal = stripped || full;
    }
    applyLabelValue(attrName, attrVal);
  }

  var roots = document.querySelectorAll(
    "#tabular-buybox, #merchantInfoFeature_feature_div, #fulfillerInfoFeature_feature_div, #merchant-info, #offerDisplayGroup_feature_div, #desktop_buybox, #buybox, #qualifiedBuybox"
  );
  for (var r = 0; r < roots.length; r++) {
    var root = roots[r];
    if (!root) continue;

    var labels = root.querySelectorAll(
      ".a-text-bold, .offer-display-feature-label, [class*='offer-display-feature-label']"
    );
    for (var b = 0; b < labels.length; b++) {
      var lab = text(labels[b]);
      if (!/(ships\s*from|sold\s*by|shipper|seller|fulfiller|fulfilled\s*by)/i.test(lab)) continue;
      var val = "";
      var sib = labels[b].nextElementSibling;
      if (sib) val = text(sib);
      if (!val) {
        var parent = labels[b].parentElement;
        if (parent) {
          var pt = normalizeMerchantSpace(text(parent));
          val = pt.replace(
            new RegExp("^" + lab.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*:?\\s*", "i"),
            ""
          );
        }
      }
      applyLabelValue(lab, val);
    }

    var rows = root.querySelectorAll(
      ".tabular-buybox-text, .offer-display-feature-text, tr, li, .a-spacing-micro, .a-spacing-small, .a-spacing-none"
    );
    for (var i = 0; i < rows.length; i++) {
      var t = normalizeMerchantSpace(text(rows[i]));
      if (!t) continue;
      var m;
      if ((m = t.match(/shipper\s*\/\s*seller\s*:?\s*(.+)$/i))) {
        applyLabelValue("Shipper / Seller", m[1]);
      } else if ((m = t.match(/ships\s*from\s*:?\s*(.+)$/i))) {
        applyLabelValue("Ships from", m[1]);
      } else if ((m = t.match(/sold\s*by\s*:?\s*(.+)$/i))) {
        applyLabelValue("Sold by", m[1]);
      } else if ((m = t.match(/^shipper\s*:?\s*(.+)$/i))) {
        applyLabelValue("Shipper", m[1]);
      } else if ((m = t.match(/^seller\s*:?\s*(.+)$/i)) && !/shipper/i.test(t)) {
        applyLabelValue("Seller", m[1]);
      } else if ((m = t.match(/fulfilled\s*by\s*:?\s*(.+)$/i))) {
        applyLabelValue("Fulfilled by", m[1]);
      }
    }
  }

  return { shipsFrom: ships, soldBy: sold };
}

function isAmazonGonePage() {
  var title = String(document.title || "").toLowerCase();
  var heading = "";
  try {
    var nodes = document.querySelectorAll("h1, h2");
    for (var i = 0; i < Math.min(nodes.length, 6); i++) heading += " " + text(nodes[i]).toLowerCase();
  } catch (e) {}
  var body = "";
  try {
    body = String(document.body && document.body.innerText ? document.body.innerText.slice(0, 1200) : "").toLowerCase();
  } catch (e2) {}
  var blob = title + " " + heading + " " + body;
  return /sorry[\s!,.]*we couldn['\u2019]t find that page|page not found|meet the dogs of amazon|\bdogs of amazon\b|not a functioning page on our site/.test(blob);
}

function capture() {
  var asin = getAsin();
  var title = getTitle();
  if (!asin || !title) {
    return { ok: false, error: "Could not find ASIN or title. Open an Amazon product page (e.g. /dp/B0xxxxx)." };
  }
  var stockDet = detectSelectedOfferStock();
  var primeDet = detectSelectedOfferPrime();
  var merchant = getMerchantOffer();
  return {
    ok: true,
    data: {
      asin: asin,
      price: getPrice(),
      currency: getCurrency(),
      isPrime: primeDet.primeStatus === "PRIME" ? true : primeDet.primeStatus === "NOT_PRIME" ? false : null,
      primeStatus: primeDet.primeStatus,
      availabilityText: stockDet.availabilityText || "",
      stockStatus: stockDet.stockStatus,
      hasAddToCart: getHasAddToCart() === true,
      hasBuyNow: getHasBuyNow() === true,
      shipsFrom: merchant.shipsFrom,
      soldBy: merchant.soldBy,
    },
  };
}

function verifyPriceOffer(expectedAsin) {
  var href = String(location.href || "").toLowerCase();
  var title = String(document.title || "").toLowerCase();
  if (
    document.querySelector("#captchacharacters, form[action*='validateCaptcha'], img[src*='captcha']") ||
    /opfcaptcha|validatecaptcha|enter the characters you see/.test(title)
  ) {
    return { ok: false, errorCode: "CAPTCHA", error: "CAPTCHA" };
  }
  var want = String(expectedAsin || "").trim().toUpperCase();
  if (isAmazonGonePage()) {
    var goneAsin = resolveActualPageAsin();
    return {
      ok: true,
      data: {
        asin: goneAsin || null,
        requestedAsin: want || null,
        finalAsin: goneAsin || null,
        redirected: false,
        pageUnavailable: true,
        displayedPrice: null,
        currency: "USD",
        condition: "New",
        shipsFrom: "",
        soldBy: "",
        isPrime: null,
        hasAddToCart: false,
        hasBuyNow: false,
        availabilityText: "Page not found",
        stockStatus: "OUT_OF_STOCK",
        pageUrl: location.href,
        captcha: false,
      },
    };
  }
  if (/ap\/signin/.test(href) || /^amazon\s+sign[\s-]?in/.test(title) || /\/ap\/signin/.test(href)) {
    return { ok: false, errorCode: "LOGIN_REQUIRED", error: "LOGIN_REQUIRED" };
  }
  var captured = capture();
  if (!captured.ok || !captured.data) {
    // Title/ASIN unreadable → technical, not a business failure
    return { ok: false, errorCode: "EXTRACTOR_FAILED", error: (captured && captured.error) || "capture failed" };
  }
  var d = captured.data;
  var actualAsin = resolveActualPageAsin() || String(d.asin || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(actualAsin)) actualAsin = "";
  // Mismatch only with positive evidence both ASINs exist and differ
  var redirected = !!(want && actualAsin && actualAsin !== want);
  return {
    ok: true,
    data: {
      asin: actualAsin || null,
      requestedAsin: want || null,
      finalAsin: actualAsin || null,
      redirected: redirected,
      pageUnavailable: false,
      displayedPrice: d.price > 0 ? d.price : null,
      currency: d.currency || "USD",
      condition: "New",
      shipsFrom: d.shipsFrom || "",
      soldBy: d.soldBy || "",
      isPrime: d.isPrime,
      hasAddToCart: d.hasAddToCart === true,
      hasBuyNow: d.hasBuyNow === true,
      availabilityText: d.availabilityText || "",
      stockStatus: d.stockStatus,
      pageUrl: location.href,
      captcha: false,
    },
  };
}

return verifyPriceOffer(expectedAsin);

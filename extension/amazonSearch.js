;(function () {
  'use strict'

  // ─── Brand Blacklist (~550 VeRO markaları) ───────────────────────────────
  var BRAND_BLACKLIST = [
    // ELEKTRONİK & TEKNOLOJİ
    'apple','samsung','sony','lg','panasonic','philips','sharp','toshiba','hitachi',
    'huawei','xiaomi','oneplus','oppo','vivo','realme','honor','motorola','nokia',
    'microsoft','dell','hp','lenovo','asus','acer','msi','gigabyte','razer','corsair',
    'logitech','steelseries','hyperx','kingston','sandisk','seagate','western digital',
    'intel','amd','nvidia','qualcomm','roku',
    'canon','nikon','fujifilm','olympus','leica','gopro','dji',
    'bose','beats','jbl','harman kardon','marshall','sennheiser','audio-technica',
    'shure','beyerdynamic','bang & olufsen','sonos','polk audio','klipsch','denon',
    'marantz','pioneer','kenwood',
    'fitbit','garmin','suunto','polar','whoop',
    'dyson','roomba','irobot','shark','bissell','hoover','miele',
    'kitchenaid','vitamix','blendtec','ninja','instant pot','cuisinart','breville',
    'delonghi','nespresso','keurig','krups','tefal',
    'braun','oral-b','gillette','philips sonicare','waterpik','remington',
    'startech','schumacher electric','cree','emporia',
    // MODA & GİYİM
    'nike','adidas','puma','reebok','new balance','under armour','converse','vans',
    'jordan','timberland','ugg','birkenstock','crocs','skechers','clarks',
    'dr. martens','merrell','salomon','asics','hoka','on running','brooks',
    'lululemon','supreme','off-white','palace','stone island','canada goose',
    'moncler','patagonia','the north face','columbia','arc\'teryx','mammut',
    'zara','h&m','uniqlo','mango','gap','banana republic',
    'calvin klein','tommy hilfiger','ralph lauren','polo ralph lauren','lacoste',
    'hugo boss','michael kors','kate spade','tory burch','coach','longchamp',
    'levi\'s','wrangler','lee','diesel','g-star','true religion',
    'fred perry','champion','carhartt','dickies','filson',
    'u.s. polo assn','us polo assn',
    // LÜKS
    'louis vuitton','gucci','prada','chanel','hermes','dior','christian dior',
    'fendi','celine','loewe','balenciaga','bottega veneta','saint laurent','ysl',
    'givenchy','valentino','versace','miu miu','burberry','alexander mcqueen',
    'jimmy choo','manolo blahnik','christian louboutin','ferragamo',
    'brunello cucinelli','loro piana','zegna','montblanc','parker','cross',
    // SAAT & MÜCEVHER
    'rolex','omega','patek philippe','audemars piguet','breitling','tag heuer',
    'hublot','panerai','tissot','longines','cartier','iwc','jaeger-lecoultre',
    'tiffany & co','bulgari','bvlgari','chopard','swarovski','pandora','mikimoto',
    // OTOMOTİV — Araba
    'ford','bmw','mercedes-benz','mercedes','toyota','honda','audi','volkswagen','vw',
    'porsche','ferrari','lamborghini','maserati','alfa romeo','fiat','peugeot',
    'renault','citroen','volvo','saab','opel','seat','skoda','kia','hyundai',
    'chevrolet','dodge','jeep','chrysler','cadillac','buick','gmc','lincoln','ram',
    'tesla','rivian','lucid','subaru','mazda','mitsubishi','nissan','infiniti',
    'lexus','acura','isuzu','suzuki','daihatsu','lancia','dacia','smart','mini',
    'rolls royce','bentley','aston martin','jaguar','land rover','range rover',
    'genesis','bugatti','koenigsegg','pagani','mclaren',
    // OTOMOTİV — Parça
    'bosch','denso','ngk','brembo','bilstein','kyb','monroe','acdelco',
    'motorcraft','mopar','castrol','mobil 1','shell','valvoline','motul',
    'michelin','pirelli','bridgestone','continental','goodyear','dunlop',
    'yokohama','toyo','hankook','falken','nitto','bfgoodrich','firestone',
    'akrapovic','magnaflow','borla','flowmaster','k&n','holley','edelbrock',
    'eibach','curt','michigan motorsports',
    // MOTOSİKLET
    'harley-davidson','ducati','kawasaki','ktm','triumph','royal enfield','aprilia',
    'mv agusta','indian motorcycle',
    // OYUNCAK & OYUN
    'lego','barbie','hot wheels','matchbox','fisher-price','hasbro','mattel',
    'funko','nerf','playmobil','ravensburger','schleich','bruder','joyin',
    'pokemon','sanrio','hello kitty','bandai','tamiya','strider','playmonster',
    'disney','marvel','dc comics','star wars','warner bros',
    // VİDEO OYUN
    'nintendo','playstation','xbox','sega','atari',
    'electronic arts','ea sports','activision','blizzard','rockstar games',
    'ubisoft','capcom','konami','square enix','bandai namco',
    // YAZILIM
    'adobe','autodesk','intuit','quickbooks','turbotax',
    'avast','kaspersky','mcafee','norton','bitdefender',
    // KOZMETİK & SAĞLIK
    'estee lauder','clinique','mac cosmetics','lancome','yves saint laurent beauty',
    'giorgio armani beauty','nars','huda beauty','charlotte tilbury','too faced',
    'urban decay','benefit cosmetics','bare minerals','bobbi brown','la mer',
    'kiehls','kiehl\'s','origins','drunk elephant','tatcha','sunday riley',
    'cerave','cetaphil','neutrogena','olay','nivea','dove','loreal','l\'oreal',
    'maybelline','revlon','covergirl','rimmel','nyx cosmetics',
    'olaplex','kerastase','wella','schwarzkopf','redken','paul mitchell',
    'herbal essences','head & shoulders','pantene',
    'dermalogica','paula\'s choice','the ordinary','innisfree','laneige',
    'sulwhasoo','beauty of joseon','anua','avene','avène',
    'tarte','rene furterer','rené furterer','karseell',
    'thrive causemetics','summer fridays','bloom',
    'australian gold','palmer\'s','kitsch',
    // SAĞLIK & İLAÇ
    'mucinex','clorox','lysol','air wick','airwick','seresto','purina',
    'bausch lomb','bausch & lomb','nutramax','culturelle','prevagen',
    'gundry md','muscletek','muscletech','designs for health','xymogen',
    'bioptimizers','nativepath','goli','nutricost','sports research',
    'ocuvite','lumify','biotrue','mederma','hims','petarmor',
    'k9 advantix','durvet','stella & chewy\'s','tetra',
    'piping rock','lifepro','toniiq','horbäach',
    // EV & TEMİZLİK
    'rubbermaid','o-cedar','ocedar','woolite','bioadvanced',
    'ozium','scoop away','boveda','velcro','flexzilla','flitz',
    'camco','tastepure','3m','loctite','gorilla glue',
    // SPOR & OUTDOOR
    'wilson','titleist','callaway','ping','taylormade','cleveland golf','cobra golf',
    'yeti','stanley','hydro flask','nalgene','camelbak','osprey','deuter',
    'black diamond','petzl','trek','specialized','giant','cannondale',
    'shimano','sram','victorinox','leatherman','gerber','benchmade','spyderco',
    'srixon','selkirk sport','darn tough','rogue',
    // ALET & EKİPMAN
    'dewalt','milwaukee','makita','snap-on','craftsman','ryobi',
    'black & decker','hilti','festool','topdon',
    // DİĞER
    'ikea','coleman','weber','traeger',
    'ray-ban','oakley','maui jim','persol',
    'zippo','otterbox','mfi certified','hario',
    // TELEGRAM DROPSHIPPER — Gerçek VeRO
    'bestsun','syston','resqme','rhino','muddy','truskin','nutrachamps',
    'flame king','bedshelfie','freshcut','stomp rocket',
    'royalblaze','carlyle','xyzal','stellalife','neem',
    'thread protector','aquabliss','grooveit','shibumi shade','leerly',
    'levocetirizine','archer watch','blink','mora','cloudpoem',
    'harry\'s','rogue iron sports','snap supplements','aquadance','mellanni',
    'sof sole','spenco','pmd beauty','dude wipes','carlson',
    'vegamour','bio-botanical research','biocidin','righteous roots',
    '4knines','lubelife','crimpit','beadnova','cgk unlimited',
    'perioSciences','brokeir','pattern','omie',
    'royal designs','battery daddy','ontel','rabbitgoo',
    'lucky egg','gyro ball','mercurydean','lunavia',
    'fsrtep','sincoda','dreamwear','ovega-3','bohning','isotonix',
  ]

  var BRAND_BLACKLIST_SET = new Set(BRAND_BLACKLIST)

  // ─── Parse helpers ───────────────────────────────────────────────────────
  function collapseWS(s) {
    if (typeof s !== 'string') return ''
    return s.replace(/\s+/g, ' ').trim()
  }

  function parseRating(text) {
    if (!text) return null
    var m = text.match(/(\d+(?:\.\d+)?)\s+out\s+of\s+5\s+stars/i)
    if (!m) return null
    var n = parseFloat(m[1])
    return (isFinite(n) && n >= 0 && n <= 5) ? n : null
  }

  function parseReviewCount(text) {
    if (!text) return null
    var m = text.match(/([\d,]+)\s+ratings?\b/i)
    if (!m) return null
    var grp = m[1]
    if (!/^[\d,]+$/.test(grp)) return null
    var n = parseInt(grp.replace(/,/g, ''), 10)
    return (isFinite(n) && n > 0) ? n : null
  }

  function parseBoughtToken(raw) {
    var t = raw.trim().replace(/\+$/, '').replace(/\s+/g, '')
    if (!t) return null
    var kMatch = /^(\d+(?:\.\d+)?)k$/i.exec(t)
    if (kMatch) {
      var n = parseFloat(kMatch[1])
      return isFinite(n) ? Math.round(n * 1000) : null
    }
    var d = t.replace(/,/g, '')
    if (!/^\d+$/.test(d)) return null
    var n2 = parseInt(d, 10)
    return (isFinite(n2) && n2 >= 0) ? n2 : null
  }

  function parseBoughtPastMonth(text) {
    if (!text) return null
    var re = /([\d,]+|\d+(?:\.\d+)?\s*[Kk])\+?\s*bought\s+in\s+(?:the\s+)?(?:past|last)\s+month/gi
    var best = null
    var m
    while ((m = re.exec(text)) !== null) {
      var tok = (m[1] || '').replace(/\s+/g, '')
      var n = parseBoughtToken(tok)
      if (n !== null) best = n
    }
    return best
  }

  var FAST_DELIVERY_RE = /\b(?:same[-\s]?day|overnight|next[-\s]?day|one[-\s]?day|1[-\s]?day|two[-\s]?day|2[-\s]?day|1[-\s]?2\s*day|today|tomorrow)\b/i
  function suggestsFastDelivery(text) {
    if (!text) return false
    if (!FAST_DELIVERY_RE.test(text)) return false
    var lower = text.toLowerCase()
    if (/\b(today|tomorrow)\b/i.test(text)) {
      return /\bdelivery\b/.test(lower) || /\barrives\b/.test(lower) || /\bshipping\b/.test(lower) || /\bget it\b/.test(lower)
    }
    return true
  }

  var LOW_STOCK_RE = /\bonly\s+\d+\s+left\s+in\s+stock\b|\bleft\s+in\s+stock\b[\s\S]{0,80}\border\s+soon\b|\border\s+soon\b/i
  function suggestsLowStock(text) {
    if (!text) return false
    return LOW_STOCK_RE.test(text)
  }

  function parseDollarPrices(text) {
    if (!text) return []
    var s = collapseWS(text).replace(/^from\s+/i, '').replace(/[–—−]/g, '-')
    var amounts = []
    var re = /\$\s*(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?/gi
    var m
    while ((m = re.exec(s)) !== null) {
      var int = m[1].replace(/,/g, '')
      var dec = m[2]
      var n = parseFloat(dec !== undefined ? int + '.' + dec : int)
      if (isFinite(n) && n >= 0 && n < 1000000) amounts.push(n)
    }
    return amounts
  }

  function parseAmazonPrice(text) {
    var amounts = parseDollarPrices(text)
    return amounts.length ? Math.min.apply(null, amounts) : null
  }

  function priceFromPriceParts(root) {
    try {
      var wholeEl = root.querySelector('.a-price-whole')
      if (!wholeEl) return null
      var whole = (wholeEl.textContent || '').replace(/[^\d]/g, '')
      if (!whole) return null
      var fracEl = root.querySelector('.a-price-fraction')
      var frac = fracEl ? (fracEl.textContent || '').replace(/[^\d]/g, '') : ''
      var n = frac.length > 0 ? parseFloat(whole + '.' + frac.slice(0, 2)) : parseFloat(whole)
      return (isFinite(n) && n >= 0 && n < 1000000) ? n : null
    } catch (e) { return null }
  }

  function elementShowsPrime(scope) {
    if (!scope) return false
    try {
      if (scope.querySelector("i.a-icon-prime, span.a-icon-prime, [class*='a-icon-prime']")) return true
      var labels = scope.querySelectorAll('[aria-label]')
      for (var i = 0; i < labels.length; i++) {
        if (/\bprime\b/i.test(labels[i].getAttribute('aria-label') || '')) return true
      }
    } catch (e) {}
    return false
  }

  // ─── Card data extraction ────────────────────────────────────────────────
  var SPONSORED_SELECTORS = [
    '[data-component-type*="sponsored"]',
    '[data-component-type="sp-sponsored-result"]',
    '[data-ad-feedback-details]',
    '[data-ad-id]',
    '[data-ad-slot]',
    '.AdHolder',
    "[data-cy='ad-recipe']",
    '.puis-sponsored-label-text',
    'span[data-component-type="s-sponsored-label"]',
  ]

  function looksSponsored(card) {
    for (var i = 0; i < SPONSORED_SELECTORS.length; i++) {
      try {
        if (card.matches(SPONSORED_SELECTORS[i]) || card.querySelector(SPONSORED_SELECTORS[i])) return true
      } catch (e) {}
    }
    try {
      if (card.closest('.AdHolder, [data-ad-slot], [data-ad-feedback-details]')) return true
    } catch (e) {}
    return false
  }

  var TITLE_SELECTORS = [
    'h2 a span.a-text-normal',
    'h2 .a-text-normal',
    "[data-cy='title-recipe'] span",
    'h2 a.a-link-normal',
    'h2 span',
  ]

  function pickTitle(card) {
    for (var i = 0; i < TITLE_SELECTORS.length; i++) {
      try {
        var el = card.querySelector(TITLE_SELECTORS[i])
        var t = el && el.textContent && el.textContent.trim()
        if (t && t.length > 3) return collapseWS(t)
      } catch (e) {}
    }
    try {
      var h2 = card.querySelector('h2')
      var fb = h2 && h2.textContent && h2.textContent.trim()
      if (fb && fb.length > 3) return collapseWS(fb)
    } catch (e) {}
    return null
  }

  function pickBrand(card) {
    try {
      var store = card.querySelector('a[href*="/stores/"]')
      if (store) {
        var t = (store.textContent || '').trim()
          .replace(/^visit\s+the\s+/i, '')
          .replace(/\s+store\s*$/i, '')
          .trim()
        if (t && t.length > 0 && t.length < 120) return collapseWS(t)
      }
      var bn = card.querySelector("[data-cy='brand-name']")
      var bt = bn && (bn.textContent || '').trim()
      if (bt && bt.length > 0 && bt.length < 120) return collapseWS(bt)
    } catch (e) {}
    return null
  }

  function pickUrl(card, asin) {
    try {
      var anchors = card.querySelectorAll('a[href*="/dp/"], a[href*="/gp/product/"]')
      for (var i = 0; i < anchors.length; i++) {
        var href = anchors[i].getAttribute('href') || ''
        if (href.includes('/' + asin)) {
          return href.startsWith('http') ? href : 'https://www.amazon.com' + href
        }
      }
    } catch (e) {}
    return null
  }

  function extractRatingReview(card) {
    var rating = null
    var reviewCount = null

    try {
      var labeled = card.querySelectorAll('[aria-label]')
      for (var i = 0; i < labeled.length; i++) {
        var al = labeled[i].getAttribute('aria-label') || ''
        if (!al) continue
        if (rating === null) { var r = parseRating(al); if (r !== null) rating = r }
        if (reviewCount === null) { var rc = parseReviewCount(al); if (rc !== null) reviewCount = rc }
        if (rating !== null && reviewCount !== null) break
      }
    } catch (e) {}

    if (rating === null || reviewCount === null) {
      try {
        var alts = card.querySelectorAll('.a-icon-alt')
        for (var j = 0; j < alts.length; j++) {
          var t = alts[j].textContent || ''
          if (rating === null) { var r2 = parseRating(t); if (r2 !== null) rating = r2 }
          if (reviewCount === null) { var rc2 = parseReviewCount(t); if (rc2 !== null) reviewCount = rc2 }
        }
      } catch (e) {}
    }

    if (rating === null || reviewCount === null) {
      try {
        var body = collapseWS((card.textContent || '').slice(0, 14000))
        if (rating === null) { var r3 = parseRating(body); if (r3 !== null) rating = r3 }
        if (reviewCount === null) { var rc3 = parseReviewCount(body); if (rc3 !== null) reviewCount = rc3 }
      } catch (e) {}
    }

    return { rating: rating, reviewCount: reviewCount }
  }

  function extractPrice(card) {
    var tryOffscreens = ['.a-price .a-offscreen', '.a-price-range .a-offscreen', '.a-section .a-price .a-offscreen']
    for (var i = 0; i < tryOffscreens.length; i++) {
      try {
        var els = card.querySelectorAll(tryOffscreens[i])
        for (var j = 0; j < els.length; j++) {
          var t = (els[j].textContent || '').trim()
          if (!t) continue
          var p = parseAmazonPrice(t)
          if (p !== null) return p
        }
      } catch (e) {}
    }
    try {
      var blocks = card.querySelectorAll('.a-price')
      for (var k = 0; k < blocks.length; k++) {
        var p2 = priceFromPriceParts(blocks[k])
        if (p2 !== null) return p2
      }
    } catch (e) {}
    try {
      var range = card.querySelector('.a-price-range')
      if (range) {
        var rt = (range.textContent || '').trim()
        if (rt) { var p3 = parseAmazonPrice(rt); if (p3 !== null) return p3 }
      }
    } catch (e) {}
    return null
  }

  var DELIVERY_SELECTORS = ["[data-cy='delivery-recipe']", '.a-color-base.a-text-bold', '[class*="delivery"]']
  function extractDeliveryBlob(card) {
    var parts = []
    for (var i = 0; i < DELIVERY_SELECTORS.length; i++) {
      try {
        var el = card.querySelector(DELIVERY_SELECTORS[i])
        var t = el && (el.textContent || '').trim()
        if (t) parts.push(t)
      } catch (e) {}
    }
    try { parts.push((card.textContent || '').slice(0, 14000)) } catch (e) {}
    return collapseWS(parts.join(' '))
  }

  function extractBoughtPastMonth(card) {
    try {
      var els = card.querySelectorAll('*')
      for (var i = 0; i < els.length; i++) {
        var t = ''
        try { t = (els[i].textContent || '').trim() } catch (e) { continue }
        if (!t || t.length > 400) continue
        var low = t.toLowerCase()
        if (!low.includes('bought in past month') && !low.includes('bought in last month')) continue
        var v = parseBoughtPastMonth(t)
        if (v !== null) return v
      }
    } catch (e) {}
    try {
      var body = (card.textContent || '').slice(0, 14000)
      return parseBoughtPastMonth(body)
    } catch (e) {}
    return null
  }

  function titleAllCapsPrefix(title) {
    if (typeof title !== 'string') return false
    var t = title.trim()
    if (!t.length) return false
    var first = t.charAt(0)
    if (first >= '0' && first <= '9') return false
    if (!/[a-zA-Z]/.test(first)) return false
    var letters = []
    for (var i = 0; i < t.length && letters.length < 4; i++) {
      var ch = t.charAt(i)
      if (/[a-zA-Z]/.test(ch)) letters.push(ch)
    }
    if (letters.length < 4) return false
    return letters.every(function (ch) { return ch >= 'A' && ch <= 'Z' })
  }

  // ─── Card collection ─────────────────────────────────────────────────────
  function collectCards(excludeSponsored) {
    var all = []
    try {
      all = Array.from(document.querySelectorAll('[data-component-type="s-search-result"][data-asin], div.s-result-item[data-asin]'))
    } catch (e) { return [] }

    var seenAsins = new Set()
    var result = []
    for (var i = 0; i < all.length; i++) {
      var node = all[i]
      if (excludeSponsored && looksSponsored(node)) continue
      var raw = ''
      try { raw = (node.getAttribute('data-asin') || '').trim() } catch (e) { continue }
      if (!raw || raw === '0') continue
      if (seenAsins.has(raw)) continue
      seenAsins.add(raw)
      result.push(node)
    }
    return result
  }

  // ─── Brand blacklist check ───────────────────────────────────────────────
  function brandBlacklisted(title, brand, userList) {
    var t = (title || '').toLowerCase()
    var b = (brand || '').toLowerCase()
    var combined = new Set(BRAND_BLACKLIST_SET)
    if (userList && userList.length) {
      for (var i = 0; i < userList.length; i++) {
        var s = (userList[i] || '').toLowerCase().trim()
        if (s) combined.add(s)
      }
    }
    for (var needle of combined) {
      if (!needle) continue
      if (t.includes(needle) || b.includes(needle)) return true
    }
    return false
  }

  // ─── Business rules check ────────────────────────────────────────────────
  function collectRejections(c, cfg) {
    var reasons = []
    var t = (c.title || '').trim()
    if (!t) reasons.push('missing_title')

    if (cfg.bannedWords && cfg.bannedWords.length) {
      var tl = t.toLowerCase()
      for (var i = 0; i < cfg.bannedWords.length; i++) {
        var w = cfg.bannedWords[i]
        if (w && tl.includes(w)) { reasons.push('title_banned_word'); break }
      }
    }

    if (cfg.minReviewCount > 0) {
      if (c.reviewCount === null) reasons.push('missing_review_count')
      else if (c.reviewCount < cfg.minReviewCount) reasons.push('review_count_below_minimum')
    }

    if (cfg.minRating > 0) {
      if (c.rating === null) reasons.push('missing_rating')
      else if (c.rating < cfg.minRating) reasons.push('rating_below_minimum')
    }

    if (cfg.minBoughtPastMonth != null && cfg.minBoughtPastMonth > 0) {
      if (c.boughtPastMonth === null) reasons.push('missing_bought_past_month')
      else if (c.boughtPastMonth < cfg.minBoughtPastMonth) reasons.push('bought_past_month_below_minimum')
    }

    if (cfg.minPrice != null || cfg.maxPrice != null) {
      if (c.price === null) reasons.push('missing_price')
      else {
        if (cfg.minPrice != null && c.price < cfg.minPrice) reasons.push('price_below_min')
        if (cfg.maxPrice != null && c.price > cfg.maxPrice) reasons.push('price_above_max')
      }
    }

    if (cfg.primeRequired && !c.hasPrime) reasons.push('prime_required')
    if (cfg.fastDeliveryRequired && !c.hasFastDelivery) reasons.push('fast_delivery_required')
    if (cfg.lowStockBlocked && c.hasLowStockWarning) reasons.push('low_stock_not_allowed')

    if (cfg.titleAllCapsRule && t && titleAllCapsPrefix(t)) reasons.push('title_allcaps_prefix')

    return reasons
  }

  // ─── Main scan ───────────────────────────────────────────────────────────
  function scanPage(filters) {
    var cfg = {
      minRating:            filters.minRating       || 0,
      minReviewCount:       filters.minReviewCount  || 0,
      minPrice:             filters.minPrice        != null ? filters.minPrice        : null,
      maxPrice:             filters.maxPrice        != null ? filters.maxPrice        : null,
      minBoughtPastMonth:   filters.minMonthlySales != null ? filters.minMonthlySales : null,
      primeRequired:        !!filters.primeRequired,
      fastDeliveryRequired: !!filters.fastDeliveryRequired,
      lowStockBlocked:      !!filters.lowStockBlocked,
      titleAllCapsRule:     filters.titleAllCapsRule !== false, // default true
      bannedWords:          Array.isArray(filters.bannedWords) ? filters.bannedWords : [],
      userBrandBlacklist:   Array.isArray(filters.userBrandBlacklist) ? filters.userBrandBlacklist : [],
      excludeSponsored:     !!filters.excludeSponsored,
      skipBrandBlacklist:   !!filters.skipBrandBlacklist,
    }

    var cards = collectCards(cfg.excludeSponsored)
    var candidates = []
    var passed = []
    var rejected = []
    var skippedBrand = 0

    for (var i = 0; i < cards.length; i++) {
      var card = cards[i]
      var asin = ''
      try { asin = (card.getAttribute('data-asin') || '').trim() } catch (e) { continue }
      if (!asin || !/^[A-Z0-9]{10}$/.test(asin)) continue

      var isSponsored = looksSponsored(card)
      var title = pickTitle(card)
      var brand = pickBrand(card)

      // Brand blacklist
      if (!cfg.skipBrandBlacklist && brandBlacklisted(title, brand, cfg.userBrandBlacklist)) {
        skippedBrand++
        continue
      }

      var rr         = extractRatingReview(card)
      var price      = extractPrice(card)
      var bought     = extractBoughtPastMonth(card)
      var hasPrime   = elementShowsPrime(card)
      var delivBlob  = extractDeliveryBlob(card)
      var cardText   = ''
      try { cardText = collapseWS((card.textContent || '').slice(0, 14000)) } catch (e) {}
      var hasFast    = suggestsFastDelivery(delivBlob)
      var hasLow     = suggestsLowStock(cardText)

      var url = pickUrl(card, asin)

      var c = {
        asin:              asin,
        title:             title,
        brand:             brand,
        rating:            rr.rating,
        reviewCount:       rr.reviewCount,
        reviews:           rr.reviewCount,   // alias for panel display
        boughtPastMonth:   bought,
        price:             price,
        hasPrime:          hasPrime,
        hasFastDelivery:   hasFast,
        hasLowStockWarning: hasLow,
        isSponsored:       isSponsored,
        url:               url,
      }

      candidates.push(c)

      var reasons = collectRejections(c, cfg)
      if (reasons.length === 0) {
        passed.push(c)
      } else {
        rejected.push({ candidate: c, reasons: reasons })
      }
    }

    return {
      ok:           true,
      candidates:   candidates,
      passed:       passed,
      rejected:     rejected,
      skippedBrand: skippedBrand,
      pageUrl:      location.href,
      scannedAt:    new Date().toISOString(),
    }
  }

  // ─── Next page ───────────────────────────────────────────────────────────
  var NEXT_SELECTORS = [
    'a.s-pagination-next',
    'a[aria-label="Go to next page"]',
    'a[aria-label="Sonraki sayfa"]',
    'a[aria-label="Next page"]',
  ]

  function clickNextPage() {
    for (var i = 0; i < NEXT_SELECTORS.length; i++) {
      var el
      try { el = document.querySelector(NEXT_SELECTORS[i]) } catch (e) { continue }
      if (!(el instanceof HTMLAnchorElement)) continue
      var li = el.closest('li')
      if (li && li.classList.contains('s-pagination-disabled')) continue
      if (el.getAttribute('aria-disabled') === 'true') continue
      el.click()
      return { ok: true }
    }
    return { ok: false, reason: 'no-next' }
  }

  function isReady() {
    if (document.readyState !== 'complete') return false
    return document.querySelectorAll('[data-component-type="s-search-result"]').length > 0
  }

  // ─── Message listener ────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (msg.type === 'SEARCH_CHECK_READY') {
      sendResponse({ ready: isReady() })
      return false
    }

    if (msg.type === 'SEARCH_SCAN_PAGE') {
      var result = scanPage(msg.filters || {})
      sendResponse(result)
      return false
    }

    if (msg.type === 'SEARCH_CLICK_NEXT') {
      sendResponse(clickNextPage())
      return false
    }
  })
})()

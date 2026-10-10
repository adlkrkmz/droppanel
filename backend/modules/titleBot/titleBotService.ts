// ----------------------------------------------------------------
// titleBotService.ts — deterministic eBay title from Amazon title (no AI)
// ----------------------------------------------------------------

export type TitleBotInput = {
  amazonTitle:  string
  brand?:       string | null
  productType?: string | null
  maxLength?:   number
}

export type TitleBotResult = {
  title:         string
  charCount:     number
  source:        "titlebot"
  droppedTokens: string[]
  warnings:      string[]
  fallbackUsed:  boolean
  strategy?:     string
  productType?:  string | null
  slots?:        Record<string, string[]>
  qualityScore?: number
}

export type TitleMode = "titlebot" | "ai" | "original"

const DEFAULT_MAX = 80
const TARGET_MIN = 72
const QUALITY_MIN = 55
const GOOD_TITLE_MIN = 60
const TARGET_TITLE_MIN = 65

/** Never appear in compiled titles — case-insensitive */
const BANNED_SEASONAL_RE =
  /\b(christmas|xmas|x-mas|crismis|chrismas|chritmas|cristmas)\b/gi

const BANNED_ALWAYS_DROP = new Set([
  "christmas", "xmas", "crismis", "chrismas", "chritmas", "cristmas", "holiday", "decoration",
])

const MARKETING_WORDS = new Set([
  "best", "hot", "sale", "new", "2024", "2025", "2026", "upgraded", "upgrade",
  "premium", "amazing", "perfect", "must", "have", "viral", "tiktok", "brand",
  "high", "quality", "multifunctional", "multi", "functional", "official",
  "latest", "top", "rated", "limited", "edition", "exclusive", "deal", "off",
  "durable", "universal", "multipurpose", "decoration",
])

const AMAZON_WORDS = new Set([
  "prime", "amazon", "fba", "shipping", "free", "delivery", "fast", "sold",
  "by", "fulfilled", "official", "store",
])

const COLOR_WORDS = new Set([
  "black", "white", "clear", "blue", "red", "green", "pink", "gray", "grey",
  "silver", "gold", "brown", "beige", "navy", "purple", "orange", "yellow",
  "multicolor", "multi-color",
])

const STOP_WORDS = new Set([
  "with", "for", "and", "the", "a", "an", "of", "in", "on", "at", "to", "from", "by", "or",
])

const LOW_VALUE_ADJECTIVES = new Set([
  "large", "small", "medium", "mini", "big", "great", "super", "ultra", "extra",
  "sports", "flask", "home", "easy", "use", "purpose",
])

const LOW_VALUE_PHRASES: string[] = [
  "plant cover", "high quality", "multi purpose", "easy use",
  "perfect fit", "best seller",
  "suitable for cutting wood bamboo plywood", "suitable for cutting",
  "cutting wood bamboo plywood", "cutting wood",
  "cordless electric portable mini chainsaw", "portable mini chainsaw",
  "mini chainsaw", "cordless electric portable",
].sort((a, b) => b.length - a.length)

const MATERIAL_PHRASES: string[] = [
  "hot dip galvanized", "hot-dip galvanized", "stainless steel",
  "abs plastic", "galvanized", "hardwood", "silicone", "aluminum", "aluminium", "plastic",
  "leather", "cotton", "glass", "metal", "wood", "manganese steel",
].sort((a, b) => b.length - a.length)

const MAIN_PRODUCT_PHRASES: string[] = [
  "self care skincare set", "skin care set", "skincare set",
  "landscape staples", "garden stakes", "weed barrier pins", "tent stakes",
  "yard pins", "plant cover spikes", "landscaping fabric sod pins",
  "fabric sod pins", "sod pins",
  "plant t-type tags", "plant t type tags", "t-type plant tags",
  "plant tags", "plant labels", "garden labels", "nursery markers",
].sort((a, b) => b.length - a.length)

/** Gift, drinkware, cards — longest n-grams first */
const GIFT_PRODUCT_PHRASES: string[] = [
  "stainless steel bullet tumbler coffee mug",
  "bullet tumbler coffee mug",
  "insulated stainless steel tumbler",
  "stainless steel travel tumbler",
  "stainless steel tumbler",
  "bullet tumbler",
  "travel coffee mug",
  "coffee mug",
  "travel mug",
  "wine tumbler",
  "assortment of sweet roasted salted gourmet nuts",
  "gourmet nuts gift basket",
  "sweet roasted salted gourmet nuts",
  "nuts gift basket",
  "food gift box",
  "gift basket",
  "fill in the blanks keepsake card",
  "fill in blanks keepsake card",
  "keepsake card",
  "greeting card",
  "fathers day card",
  "mothers day card",
  "birthday card",
  "anniversary card",
].sort((a, b) => b.length - a.length)

/** Tools, hardware, automotive care */
const HARDWARE_PRODUCT_PHRASES: string[] = [
  "outdoor extension cord cover weatherproof electrical connection box",
  "weatherproof electrical connection box",
  "outdoor extension cord cover",
  "extension cord cover",
  "outdoor electrical box",
  "electrical connection box",
  "outdoor power strip with stake",
  "outdoor power strip",
  "magnetic garage hooks",
  "magnetic storage hooks",
  "waterproof junction box",
  "outdoor electrical box waterproof junction box",
  "junction box",
  "electrical box",
  "metal spatula set",
  "stainless steel spatula set",
  "spatula set",
  "slotted turner flipper",
  "solid slotted turner",
  "turner flipper",
  "cordless drill driver set",
  "drill driver set",
  "replacement saw chain",
  "mini saw chain",
  "chainsaw chain",
  "saw chain",
  "foam party wash wax",
  "foam party car wash",
  "foam party wash",
  "car wash wax",
].sort((a, b) => b.length - a.length)

const PRODUCT_TYPE_PHRASES: string[] = [
  ...GIFT_PRODUCT_PHRASES,
  ...MAIN_PRODUCT_PHRASES,
  ...HARDWARE_PRODUCT_PHRASES,
].sort((a, b) => b.length - a.length)

const OCCASION_PHRASES: string[] = [
  "father's day", "fathers day", "mother's day", "mothers day",
  "valentine's day", "valentines day", "valentines",
  "stocking stuffers", "birthday gift", "birthday gifts",
  "christmas", "anniversary", "sympathy",
].sort((a, b) => b.length - a.length)

const RECIPIENT_PHRASES: string[] = [
  "gifts for dad from daughter wife", "gifts for dad from daughter",
  "gifts for dad", "gifts for men", "gift for dad", "gift for men",
  "dad gift from son daughter", "dad gift from son", "dad gift",
  "dad gifts", "for dad from daughter", "for dad", "for men",
  "from daughter wife", "from daughter", "from son daughter", "from son",
  "for him", "men and women", "men women", "grandpa", "husband", "wife",
  "daughter", "son",
].sort((a, b) => b.length - a.length)

const GIFT_FEATURE_PHRASES: string[] = [
  "fill in the blanks", "fill in blanks",
  "sweet & roasted salted", "sweet roasted salted",
  "gourmet nuts", "assortment of sweet roasted salted gourmet nuts",
].sort((a, b) => b.length - a.length)

const CONCRETE_PRODUCT_NOUNS = new Set([
  "mug", "tumbler", "basket", "box", "card", "tags", "tag", "labels", "label",
  "markers", "marker", "cream", "staples", "staple", "pins", "pin", "stakes",
  "stake", "spikes", "spike", "lotion", "serum", "mask", "set", "kit",
  "spatula", "turner", "flipper", "drill", "driver", "chain", "hooks", "hook",
  "strip", "cover", "wash", "wax", "shampoo", "enclosure",
])

const OCCASION_ONLY_WORDS = new Set([
  "fathers", "father", "dads", "dad", "daddy", "men", "women", "gift", "gifts",
  "daughter", "son", "grandpa", "husband", "wife", "him", "her", "christmas",
  "anniversary", "valentines", "sympathy", "birthday", "ideas", "funny",
])

const USE_KEYWORD_PHRASES: string[] = [
  "weed barrier pins", "weed barrier fabric", "garden stakes pins",
  "landscape pins", "yard pins", "tent stakes", "fabric sod pins",
  "sod pins", "landscaping pins",
].sort((a, b) => b.length - a.length)

const USE_PHRASES: string[] = [
  "plug socket box", "plug socket", "connection box", "electrical enclosure",
  "kitchen cooking utensils", "cooking utensils", "kitchen use",
  "car wash", "auto shampoo", "auto wash", "tool kit", "saw chain",
].sort((a, b) => b.length - a.length)

const FEATURE_PHRASES: string[] = [
  "heavy duty", "battery and charger", "battery charger", "drill bits", "tangerine scent",
  "manganese steel", "tool storage", "replacement saw chain",
  "solid and slotted turner", "solid slotted turner", "solid & slotted turner",
  "slotted turner flipper", "slotted turner", "turner flipper",
  "foam party car wash", "storage hooks",
  "fragrance free", "very dry sensitive skin", "dry sensitive skin", "sensitive skin",
  "non comedogenic", "non-comedogenic", "non greasy", "non-greasy",
  "leak proof", "non slip", "non-slip", "wall mounted",
  "hardwood floors", "phone holder", "drain tray", "floor protectors",
  "chair leg", "sink organizer", "sponge holder", "water bottle",
  "storage rack", "draft stopper", "toy storage",
].sort((a, b) => b.length - a.length)

const FEATURE_WORDS = new Set([
  "magnetic", "foldable", "adjustable", "waterproof", "rustproof", "rust",
  "proof", "reusable", "portable", "organizer", "holder", "storage", "sliding",
  "drain", "tray", "mounted", "leak", "slip", "duty", "heavy", "solid", "slotted",
  "funny", "gourmet", "keepsake", "hydrating", "moisturizing", "cordless",
  "flipper", "kitchen", "stake", "replacement", "shampoo", "enclosure",
])

/** Priority: lower = keep longer when trimming */
const BLOCK_PRIORITY = {
  qty:         1,
  size:        2,
  material:    3,
  modifier:    4,
  product:     5,
  tech:        6,
  setContents: 7,
  feature:     8,
  use:         9,
  occasion:    10,
  recipient:   11,
  color:       12,
  filler:      13,
} as const

const PROTECTED_TRIM_KINDS = new Set<BlockKind>(["qty", "size", "material", "product", "setContents", "tech", "use"])

const SET_SIGNAL_RE = /\b(set|kit|routine|bundle)\b/i
const BEAUTY_SIGNAL_RE =
  /\b(skincare|skin\s*care|face|cleanser|toner|serum|moisturizer|moisturiser|lip\s*mask|lotion|cream)\b/i

const NON_BRAND_FIRST_WORDS = new Set([
  "outdoor", "indoor", "heavy", "medium", "large", "small", "portable", "waterproof",
  "magnetic", "electric", "cordless", "professional", "premium", "new",
])

const HARDWARE_CONTEXT_RE =
  /\b(extension cord|electrical box|junction box|power strip|outlet|plug|socket|waterproof|ip\d{2}|awg|drill|chainsaw|spatula|magnetic garage|cord cover)\b/i

const PLANT_LABEL_SIGNAL_RE =
  /\bplant\s*tags?\b|\bplant\s*labels?\b|\bgarden\s*labels?\b|\bnursery\b|\bmarkers?\b|\bt[\s-]?(type|shaped)\b/i

const BEAUTY_CONTENT_ORDER = [
  "face", "cleanser", "toner", "serum", "moisturizer", "moisturiser", "lip mask", "cream", "lotion",
] as const

const BEAUTY_PRODUCT_PHRASES: string[] = [
  "hydrating moisturizing cream", "moisturizing cream", "face and body moisturizer",
  "face body moisturizer", "face moisturizer", "body moisturizer",
].sort((a, b) => b.length - a.length)

type BlockKind = keyof typeof BLOCK_PRIORITY

type TitleBlock = {
  text:   string
  kind:   BlockKind
  atomic: boolean
}

const QTY_PATTERNS: { re: RegExp; format: (m: RegExpMatchArray) => string }[] = [
  { re: /\b(\d+)\s*packs?\b/i,      format: m => `${m[1]} Pcs` },
  { re: /\bpacks?\s+of\s+(\d+)\b/i, format: m => `${m[1]} Pcs` },
  { re: /\bset\s+of\s+(\d+)\b/i,    format: m => `${m[1]} Pcs` },
  { re: /\b(\d+)\s*pieces?\b/i,     format: m => `${m[1]} Pcs` },
  { re: /\b(\d+)pcs\b/i,            format: m => `${m[1]} Pcs` },
  { re: /\b(\d+)\s*pcs?\b/i,        format: m => `${m[1]} Pcs` },
  { re: /\b(\d+)\s*count\b/i,       format: m => `${m[1]} Pcs` },
  { re: /\b(\d+)\s*ct\b/i,          format: m => `${m[1]} Pcs` },
  { re: /\bpair\b/i,                format: () => "2 Pcs" },
  { re: /\bbundle\b/i,              format: () => "Bundle" },
]

const DEDUP_SPAM_WORDS = new Set([
  "portable", "waterproof", "weatherproof", "storage", "magnetic", "extension", "organizer", "drill",
])

const TECHNICAL_TOKEN_RES = [
  /\bIP\s*\d{2}\b/gi,
  /\bETL\s+Listed\b/gi,
  /\bETL\b/gi,
  /\b\d+\s+AWG\b/gi,
  /\b\d+\s+Gauge\b/gi,
  /\b\d+\s*A\s*\/\s*\d+\s*W\b/gi,
  /\b\d+\s*Drive\s+Links\b/gi,
  /\b\d+\s+Grounded\s+Outlets\b/gi,
  /\b\d+\s+Cable\s+Entry\s+Ports\b/gi,
  /\b\d+\s*V\b/gi,
  /\b\d+\s*A\b/gi,
  /\b\d+\s*W\b/gi,
]

/** No bare `g` — avoids splitting "11 Gauge" */
const DIM_SIZE_PATTERN =
  /\b(\d+(?:\.\d+)?)\s*[xX]\s*(\d+(?:\.\d+)?)\s*[xX]\s*(\d+(?:\.\d+)?)\s*(cm|mm|in|inch|inches|ft|feet|foot)?\b|\b(\d+(?:\.\d+)?)\s*[xX]\s*(\d+(?:\.\d+)?)\s*(cm|mm|in|inch|inches|ft|feet|foot)?\b|\b(\d+(?:\.\d+)?)[xX](\d+(?:\.\d+)?)(cm|mm|in|inch|inches|ft|feet)\b/gi

const SIZE_PATTERN =
  /\b(\d+(?:\.\d+)?)\s*(oz|fl\s*oz|ml|l|lb|lbs|kg|gallon|gallons|gal|inch|inches|in|ft|feet|foot|cm|mm|centimeter|centimeters|millimeter|millimeters|ounce|ounces|pound|pounds)\b|\b(\d+)\s*(w|v|a|mah|watt|watts)\b/gi

const TECH_GAUGE_RE = /\b(\d+)\s*gauge\b/gi
const TECH_AWG_RE = /\b(\d+)\s*awg\b/gi

const TRAILING_STOP_WORDS = new Set(["and", "with", "for", "of", "in", "on", "at", "to", "or", "the", "a", "an"])

function collapseWS(s: string): string {
  return s.replace(/\s+/g, " ").trim()
}

function stripSymbols(s: string): string {
  return s
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, "")
    .replace(/[™®©|/\\[\]{}()]+/g, " ")
    .replace(/[^\w\s.'\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function normalizeToken(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9]/g, "")
}

function titleCaseWord(w: string): string {
  if (!w) return w
  if (/^\d/.test(w)) return w
  if (w.length <= 3 && w === w.toUpperCase()) return w
  return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
}

function titleCasePhrase(phrase: string): string {
  return phrase.split(/\s+/).map(titleCaseWord).join(" ")
}

function normalizeMaterialDisplay(phrase: string): string {
  const lower = phrase.toLowerCase()
  if (/hot[- ]?dip\s+galvanized/.test(lower)) return "Galvanized"
  if (lower === "stainless steel") return "Stainless Steel"
  return titleCasePhrase(phrase)
}

function shortUnit(unit: string): string {
  const u = unit.toLowerCase().replace(/\s+/g, "")
  const unitMap: Record<string, string> = {
    inch: "in", inches: "in", in: "in",
    foot: "ft", feet: "ft", ft: "ft",
    ounce: "oz", ounces: "oz", oz: "oz",
    pound: "lb", pounds: "lb", lb: "lb", lbs: "lb",
    gallon: "gal", gallons: "gal", gal: "gal",
    centimeter: "cm", centimeters: "cm", cm: "cm",
    millimeter: "mm", millimeters: "mm", mm: "mm",
    ml: "ml", l: "l", kg: "kg",
  }
  return unitMap[u] ?? u
}

function containsBannedSeasonalTerm(text: string): boolean {
  BANNED_SEASONAL_RE.lastIndex = 0
  return BANNED_SEASONAL_RE.test(text)
}

function stripBannedSeasonalTerms(text: string, warnings: string[]): string {
  BANNED_SEASONAL_RE.lastIndex = 0
  if (!BANNED_SEASONAL_RE.test(text)) return text
  BANNED_SEASONAL_RE.lastIndex = 0
  const cleaned = collapseWS(text.replace(BANNED_SEASONAL_RE, " "))
  if (cleaned !== text && !warnings.includes("banned_term_removed")) {
    warnings.push("banned_term_removed")
  }
  return cleaned
}

function normalizeSourcePhrases(text: string): string {
  let t = text
  t = t.replace(/\s*&\s*/g, " and ")
  t = t.replace(/\bt-\s*type\b/gi, "t type")
  t = t.replace(/\bdry\s+to\s+very\s+dry\s+sensitive\s+skin\b/gi, "dry sensitive skin")
  t = t.replace(/\bface\s+and\s+body\b/gi, "face body")
  t = t.replace(/\b(\d+)\s*floz\b/gi, "$1 fl oz")
  t = t.replace(/\b(\d+)\s*fluid\s+ounces?\b/gi, "$1 fl oz")
  t = t.replace(/\b(\d+)\s*ft\b/gi, "$1 ft")
  t = t.replace(/\b(\d+)v\b/gi, "$1V")
  t = t.replace(/\bip(\d{2})\b/gi, "IP$1")
  t = t.replace(/\betl\b/gi, "ETL")
  return normalizeDimensionsInText(t)
}

function normalizeDimensionsInText(text: string): string {
  let t = text
  t = t.replace(
    /\b(\d+(?:\.\d+)?)\s*[xX]\s*(\d+(?:\.\d+)?)\s*[xX]\s*(\d+(?:\.\d+)?)\s*(?:"|in|inch|inches)?\b/gi,
    (_, a, b, c) => `${a}x${b}x${c} in`
  )
  t = t.replace(
    /\b(\d+(?:\.\d+)?)\s*[xX]\s*(\d+(?:\.\d+)?)(cm|mm|in|inch|inches|ft|feet)\b/gi,
    (_, a, b, u) => `${a}x${b} ${shortUnit(u)}`
  )
  t = t.replace(
    /\b(\d+(?:\.\d+)?)\s*[xX]\s*(\d+(?:\.\d+)?)\s*(cm|mm|in|inch|inches|ft|feet)\b/gi,
    (_, a, b, u) => `${a}x${b} ${shortUnit(u)}`
  )
  t = t.replace(
    /\b(\d+(?:\.\d+)?)\s*(?:fl\s*oz|floz)\b/gi,
    (_, n) => `${n} fl oz`
  )
  t = t.replace(
    /\b(\d+(?:\.\d+)?)(oz|ml|lb|lbs|gal|cm|mm)\b/gi,
    (_, n, u) => `${n} ${shortUnit(u)}`
  )
  t = t.replace(
    /\b(\d+(?:\.\d+)?)(inch|inches|in|ft|feet|foot)\b/gi,
    (_, n, u) => `${n} ${shortUnit(u)}`
  )
  return collapseWS(t)
}

function normalizeSizeToken(raw: string): string {
  const compact = raw.replace(/\s+/g, " ").trim()

  const dim3 = compact.match(
    /\b(\d+(?:\.\d+)?)\s*[xX]\s*(\d+(?:\.\d+)?)\s*[xX]\s*(\d+(?:\.\d+)?)\s*(cm|mm|in|inch|inches|ft|feet|foot)?\b/i
  )
  if (dim3) {
    const unit = dim3[4] ? shortUnit(dim3[4]) : "in"
    return `${dim3[1]}x${dim3[2]}x${dim3[3]} ${unit}`
  }

  const dimStuck = compact.match(
    /\b(\d+(?:\.\d+)?)[xX](\d+(?:\.\d+)?)(cm|mm|in|inch|inches|ft|feet)\b/i
  )
  if (dimStuck) {
    return `${dimStuck[1]}x${dimStuck[2]} ${shortUnit(dimStuck[3])}`
  }

  const dim = compact.match(
    /\b(\d+(?:\.\d+)?)\s*[xX]\s*(\d+(?:\.\d+)?)\s*(cm|mm|in|inch|inches|ft|feet|foot)?\b/i
  )
  if (dim) {
    const unit = dim[3] ? shortUnit(dim[3]) : "in"
    return `${dim[1]}x${dim[2]} ${unit}`
  }

  const numUnit = compact.match(/\b(\d+(?:\.\d+)?)\s*(oz|fl\s*oz|ml|l|lb|lbs|kg|gal|inch|inches|in|ft|feet|foot|cm|mm)\b/i)
  if (numUnit) {
    return `${numUnit[1]} ${shortUnit(numUnit[2])}`
  }

  return titleCasePhrase(compact)
}

function extractTType(text: string): { phrase: string | null; remainder: string } {
  const re = /\bt[\s-]?(type|shaped)\b/gi
  if (!re.test(text)) return { phrase: null, remainder: text }
  re.lastIndex = 0
  return { phrase: "T Type", remainder: collapseWS(text.replace(re, " ")) }
}

function isPlantLabelContext(source: string): boolean {
  return PLANT_LABEL_SIGNAL_RE.test(source)
}

function isBeautySetContext(source: string): boolean {
  return SET_SIGNAL_RE.test(source) && BEAUTY_SIGNAL_RE.test(source)
}

function isBeautyProductContext(source: string): boolean {
  return BEAUTY_SIGNAL_RE.test(source) && !SET_SIGNAL_RE.test(source)
}

function pickBeautyProduct(found: string[], words: string[]): string {
  const pool = dedupeWords([...found.flatMap(p => tokenize(p)), ...words])
  const lower = pool.map(w => w.toLowerCase())
  const parts: string[] = []
  if (lower.includes("hydrating")) parts.push("Hydrating")
  if (lower.includes("face")) parts.push("Face")
  if (lower.includes("body")) parts.push("Body")
  if (lower.includes("moisturizing") || lower.includes("moisturizer")) parts.push("Moisturizing")
  if (lower.includes("cream")) parts.push("Cream")
  if (parts.length >= 2) return parts.join(" ")
  if (found.length > 0) return titleCasePhrase(found[0])
  return pool.slice(0, 5).map(titleCaseWord).join(" ")
}

function extractBeautyMainProduct(source: string): string | null {
  if (/\bself\s+care\s+skincare\s+set\b/i.test(source)) return "Self Care Skincare Set"
  if (/\bskincare\s+set\b/i.test(source)) return "Skincare Set"
  if (/\bskin\s+care\s+set\b/i.test(source)) return "Skin Care Set"
  return null
}

function extractBeautyContents(source: string): string[] {
  const lower = source.toLowerCase()
  const found: string[] = []
  for (const item of BEAUTY_CONTENT_ORDER) {
    if (item === "lip mask") {
      if (/\blip\s+mask\b/i.test(lower)) found.push("Lip Mask")
      continue
    }
    if (new RegExp(`\\b${item}\\b`, "i").test(lower)) {
      found.push(item === "moisturiser" ? "Moisturizer" : titleCaseWord(item))
    }
  }
  return dedupeStrings(found)
}

function phraseAlreadyInTitle(title: string, phrase: string): boolean {
  const lower = title.toLowerCase()
  const p = phrase.toLowerCase().trim()
  if (!p) return true
  if (lower.includes(p)) return true
  return p.split(/\s+/).every(w => lower.includes(w))
}

function enrichShortTitle(
  title: string,
  maxLength: number,
  extras: string[],
  warnings: string[]
): string {
  if (title.length >= GOOD_TITLE_MIN) return title
  let t = title
  for (const extra of extras) {
    if (!extra.trim()) continue
    if (phraseAlreadyInTitle(t, extra)) continue
    const candidate = collapseWS(`${t} ${extra}`)
    if (candidate.length > maxLength) continue
    t = candidate
    if (t.length >= GOOD_TITLE_MIN) break
  }
  if (t.length < GOOD_TITLE_MIN) warnings.push("short_title")
  return t
}

function extractMandatoryPhrases(source: string): string[] {
  const phrases: string[] = []
  const add = (phrase: string) => {
    if (!phrases.some(p => p.toLowerCase() === phrase.toLowerCase())) phrases.push(phrase)
  }

  if (/\bspatula\b/i.test(source)) {
    if (/\bsolid\b/i.test(source)) add("Solid")
    if (/\bslotted\s+turner\b/i.test(source)) add("Slotted Turner")
    else if (/\bturner\s+flipper\b/i.test(source)) add("Turner Flipper")
    if (/\bflipper\b/i.test(source) && !phrases.some(p => /flipper/i.test(p))) add("Flipper")
    if (/\bkitchen\b/i.test(source)) add("Kitchen")
    else if (/\bcooking\s+utensils\b/i.test(source)) add("Cooking Utensils")
  }

  if (/\bextension cord cover\b/i.test(source)) {
    if (/\bplug\b/i.test(source) && /\bsocket\b/i.test(source)) add("Plug Socket Box")
    else if (/\bconnection\s+box\b/i.test(source)) add("Connection Box")
    if (/\bwaterproof\b/i.test(source)) add("Waterproof")
  }

  if (/\bfoam party\b/i.test(source) && /\bwash\b/i.test(source)) {
    add("Foam Party")
    if (/\bwax\b/i.test(source)) add("Wax")
    add("Car Wash")
    if (/\bcars?\b|\btrucks?\b|\bsuv/i.test(source)) add("Auto Shampoo")
    if (/\btangerine\s+scent\b/i.test(source)) add("Tangerine Scent")
    if (/\bpink\b/i.test(source)) add("Pink")
  }

  if (/\bpower strip\b/i.test(source)) {
    if (/\bstake\b/i.test(source)) add("Stake")
    const om = source.match(/\b(\d+)\s+Grounded\s+Outlets\b/i)
    if (om) add(`${om[1]} Outlets`)
  }

  if (/\bjunction box\b/i.test(source) || /\belectrical box\b/i.test(source)) {
    if (/\benclosure\b/i.test(source)) add("Electrical Enclosure")
    if (/\babs\s+plastic\b/i.test(source)) add("ABS Plastic")
    else if (/\bplastic\b/i.test(source)) add("Plastic")
  }

  if (/\bdrill driver set\b/i.test(source) || /\bcordless drill\b/i.test(source)) {
    if (/\bbattery\b/i.test(source)) add("Battery")
    if (/\bcharger\b/i.test(source)) add("Charger")
    if (/\btools?\s+kit\b/i.test(source)) add("Tool Kit")
    else if (/\bdrill bits\b/i.test(source)) add("Drill Bits")
  }

  if (/\bchainsaw chain\b/i.test(source) || /\bsaw chain\b/i.test(source)) {
    if (/\bmanganese/i.test(source)) add("Manganese Steel")
    if (/\breplacement\b/i.test(source) || /\bsaw chain\b/i.test(source)) add("Replacement")
    else if (/\bsaw chain\b/i.test(source)) add("Saw Chain")
  }

  if (/\bmagnetic garage hooks\b/i.test(source)) {
    add("Heavy Duty")
    add("Tool Storage")
    if (/\bstorage hooks\b/i.test(source)) add("Storage Hooks")
  }

  return phrases
}

function hasStrongFeatureOrUse(title: string, mandatoryPhrases: string[]): boolean {
  if (mandatoryPhrases.length === 0) return true
  const matched = mandatoryPhrases.filter(p => phraseAlreadyInTitle(title, p))
  if (matched.length < Math.min(2, mandatoryPhrases.length)) return false
  const needsKit = mandatoryPhrases.some(p => /drill bits|tool kit/i.test(p))
  if (needsKit && !matched.some(p => /drill bits|tool kit/i.test(p))) return false
  return true
}

function enrichWeakTitle(
  title: string,
  mandatoryPhrases: string[],
  extras: string[],
  maxLength: number,
  warnings: string[]
): string {
  let t = title

  const appendPhrase = (phrase: string, isMandatory: boolean) => {
    if (phraseAlreadyInTitle(t, phrase)) return
    const candidate = collapseWS(`${t} ${phrase}`)
    if (candidate.length > maxLength) return
    t = candidate
    if (!warnings.includes("weak_title_enriched")) warnings.push("weak_title_enriched")
    if (isMandatory && !warnings.includes("important_feature_preserved")) {
      warnings.push("important_feature_preserved")
    }
  }

  for (const phrase of mandatoryPhrases) appendPhrase(phrase, true)

  if (t.length < TARGET_TITLE_MIN || !hasStrongFeatureOrUse(t, mandatoryPhrases)) {
    for (const phrase of extras) appendPhrase(phrase, false)
  }

  return t
}

function removeBrandFromText(text: string, brand: string | null | undefined): string {
  if (!brand?.trim()) return text
  let work = text
  const parts = brand.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return text

  const fullRe = new RegExp(`\\b${parts.map(escapeRegExp).join("\\s+")}\\b`, "gi")
  work = work.replace(fullRe, " ")

  for (const part of parts) {
    const re = new RegExp(`\\b${escapeRegExp(part)}\\b`, "gi")
    work = work.replace(re, " ")
  }
  return collapseWS(work)
}

function removeBrandTokens(words: string[], brand: string | null | undefined): string[] {
  if (!brand?.trim()) return words
  const brandParts = brand.toLowerCase().split(/\s+/).filter(Boolean)
  if (brandParts.length === 0) return words

  const out: string[] = []
  let i = 0
  while (i < words.length) {
    let matched = false
    for (let len = brandParts.length; len >= 1; len--) {
      const slice = words.slice(i, i + len).map(w => w.toLowerCase())
      if (slice.join(" ") === brandParts.slice(0, len).join(" ")) {
        i += len
        matched = true
        break
      }
    }
    if (!matched) {
      out.push(words[i])
      i++
    }
  }
  return out
}

function containsBrand(title: string, brand: string | null | undefined): boolean {
  if (!brand?.trim()) return false
  const lower = title.toLowerCase()
  const parts = brand.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return false
  if (lower.includes(parts.join(" "))) return true
  return parts.every(p => new RegExp(`\\b${escapeRegExp(p)}\\b`, "i").test(title))
}

function extractAndRemove(text: string, re: RegExp, format: (m: RegExpMatchArray) => string): {
  values: string[]
  remainder: string
} {
  const values: string[] = []
  let remainder = text
  let m: RegExpExecArray | null
  const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`
  const globalRe = new RegExp(re.source, flags)
  while ((m = globalRe.exec(text)) !== null) {
    values.push(format(m))
    remainder = remainder.replace(m[0], " ")
  }
  return { values: dedupeStrings(values), remainder: collapseWS(remainder) }
}

function dedupeStrings(items: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of items) {
    const key = item.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

function removePhrases(text: string, phrases: string[]): { remainder: string; found: string[] } {
  let work = ` ${text.toLowerCase()} `
  const found: string[] = []
  for (const phrase of phrases) {
    const p = phrase.toLowerCase()
    const re = new RegExp(`\\b${p.replace(/\s+/g, "\\s+").replace(/-/g, "[-\\s]?")}\\b`, "gi")
    if (re.test(work)) {
      found.push(phrase)
      work = work.replace(re, " ")
    }
  }
  return { remainder: collapseWS(work), found }
}

function extractQtyPhrase(text: string): { phrase: string | null; remainder: string } {
  const lower = text.toLowerCase()
  for (const { re, format } of QTY_PATTERNS) {
    const m = lower.match(re)
    if (m) {
      const remainder = text.replace(new RegExp(escapeRegExp(m[0]), "i"), " ")
      return { phrase: format(m), remainder: collapseWS(remainder) }
    }
  }
  const embedded = lower.match(/\b(\d+)pcs\b/i)
  if (embedded) {
    const remainder = text.replace(new RegExp(escapeRegExp(embedded[0]), "i"), " ")
    return { phrase: `${embedded[1]} Pcs`, remainder: collapseWS(remainder) }
  }
  return { phrase: null, remainder: text }
}

function extractSizeTokens(text: string): { tokens: string[]; remainder: string } {
  const tokens: string[] = []
  let remainder = text

  const consume = (pattern: RegExp) => {
    let m: RegExpExecArray | null
    const re = new RegExp(pattern.source, pattern.flags)
    while ((m = re.exec(remainder)) !== null) {
      const raw = m[0].trim()
      tokens.push(normalizeSizeToken(raw))
      remainder = remainder.replace(new RegExp(escapeRegExp(raw), "i"), " ")
      re.lastIndex = 0
    }
  }

  consume(DIM_SIZE_PATTERN)
  consume(SIZE_PATTERN)

  return { tokens: dedupeStrings(tokens), remainder: collapseWS(remainder) }
}

function extractTechSpecs(text: string): { specs: string[]; remainder: string } {
  const specs: string[] = []
  let remainder = text

  const gauge = extractAndRemove(remainder, TECH_GAUGE_RE, m => `${m[1]} Gauge`)
  specs.push(...gauge.values)
  remainder = gauge.remainder

  const awg = extractAndRemove(remainder, TECH_AWG_RE, m => `${m[1]} AWG`)
  specs.push(...awg.values)
  remainder = awg.remainder

  const extended = extractExtendedTechSpecs(remainder)
  specs.push(...extended.specs)
  remainder = extended.remainder

  return { specs: dedupeStrings(specs), remainder }
}

function tokenize(text: string): string[] {
  return collapseWS(text)
    .split(/\s+/)
    .map(w => w.trim())
    .filter(Boolean)
}

function filterNoiseWords(words: string[]): { kept: string[]; dropped: string[] } {
  const dropped: string[] = []
  const kept: string[] = []
  for (const w of words) {
    const n = normalizeToken(w)
    if (!n) continue
    if (BANNED_ALWAYS_DROP.has(n)) {
      dropped.push(w)
      continue
    }
    if (MARKETING_WORDS.has(n) || AMAZON_WORDS.has(n) || STOP_WORDS.has(n)) {
      dropped.push(w)
      continue
    }
    if (LOW_VALUE_ADJECTIVES.has(n)) {
      dropped.push(w)
      continue
    }
    if (/^\d{4}$/.test(n)) {
      dropped.push(w)
      continue
    }
    kept.push(w)
  }
  return { kept, dropped }
}

function dedupeWords(words: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const w of words) {
    const key = normalizeToken(w)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(w)
  }
  return out
}

function joinBlocks(blocks: TitleBlock[]): string {
  return collapseWS(dedupeBlockTexts(blocks.map(b => b.text).filter(Boolean)).join(" "))
}

function dedupeBlockTexts(texts: string[]): string[] {
  const out: string[] = []
  for (const t of texts) {
    const lower = t.toLowerCase().trim()
    if (!lower) continue
    const dupIdx = out.findIndex(o => o.toLowerCase() === lower)
    if (dupIdx >= 0) continue
    const subIdx = out.findIndex(o => lower.includes(o.toLowerCase()) && o.length < lower.length)
    if (subIdx >= 0) {
      out[subIdx] = t
      continue
    }
    if (out.some(o => o.toLowerCase().includes(lower) && lower.length < o.length)) continue
    out.push(t)
  }
  return out
}

function isProtectedTechnicalToken(token: string): boolean {
  const bare = token.replace(/[^A-Za-z0-9]/g, "")
  if (/^IP\d{2}$/i.test(bare)) return true
  if (/^ETL$/i.test(bare)) return true
  if (/^\d+AWG$/i.test(bare)) return true
  if (/^\d+Gauge$/i.test(bare)) return true
  if (/^\d+A$/i.test(bare)) return true
  if (/^\d+W$/i.test(bare)) return true
  if (/^\d+V$/i.test(bare)) return true
  if (/^\d+x[\d.]+x[\d.]+$/i.test(bare)) return true
  if (/^\d+x[\d.]+$/i.test(bare)) return true
  return false
}

function stripModelSkuCodes(text: string, warnings: string[]): string {
  return collapseWS(
    text.replace(/\b[A-Za-z]{2,}\d{3,}[A-Za-z0-9]*\b/g, (match) => {
      if (isProtectedTechnicalToken(match)) return match
      warnings.push("model_code_removed")
      return " "
    }).replace(/\b[A-Za-z]{2,}-\d{4,}\b/g, (match) => {
      warnings.push("model_code_removed")
      return " "
    })
  )
}

function extractExtendedTechSpecs(text: string): { specs: string[]; remainder: string } {
  const specs: string[] = []
  let remainder = text

  const patterns: { re: RegExp; fmt: (m: RegExpMatchArray) => string }[] = [
    { re: /\bIP\s*(\d{2})\b/gi,                       fmt: m => `IP${m[1]}` },
    { re: /\bETL\s+Listed\b/gi,                       fmt: () => "ETL" },
    { re: /\bETL\s+Certified\b/gi,                    fmt: () => "ETL" },
    { re: /\b(\d+)\s*A\s*\/\s*(\d+)\s*W\b/gi,        fmt: m => `${m[1]}A ${m[2]}W` },
    { re: /\b(\d+)\s+Drive\s+Links\b/gi,              fmt: m => `${m[1]} Drive Links` },
    { re: /\b(\d+)\s+Grounded\s+Outlets\b/gi,         fmt: m => `${m[1]} Outlets` },
    { re: /\b(\d+)\s+Cable\s+Entry\s+Ports\b/gi,      fmt: m => `${m[1]} Cable Ports` },
    { re: /\b(\d+)\s*V\b/gi,                          fmt: m => `${m[1]}V` },
    { re: /\b(\d+)\s*A\b(?![a-z])/gi,                 fmt: m => `${m[1]}A` },
    { re: /\b(\d+)\s*W\b(?![a-z])/gi,                 fmt: m => `${m[1]}W` },
  ]

  for (const { re, fmt } of patterns) {
    const extracted = extractAndRemove(remainder, re, fmt)
    specs.push(...extracted.values)
    remainder = extracted.remainder
  }

  return { specs: dedupeStrings(specs), remainder }
}

function normalizeTitleTechnicalCase(title: string): string {
  let t = title
  t = t.replace(/\bip(\d{2})\b/gi, (_, n) => `IP${n}`)
  t = t.replace(/\betl\b/gi, "ETL")
  t = t.replace(/\b(\d+)\s*awg\b/gi, (_, n) => `${n} AWG`)
  t = t.replace(/\b(\d+)\s*gauge\b/gi, (_, n) => `${n} Gauge`)
  t = t.replace(/\b(\d+)v\b/gi, (_, n) => `${n}V`)
  t = t.replace(/\b(\d+)a\b(?=\s|$)/gi, (_, n) => `${n}A`)
  t = t.replace(/\b(\d+)w\b(?=\s|$)/gi, (_, n) => `${n}W`)
  t = t.replace(/\b(\d+)\s*floz\b/gi, (_, n) => `${n} fl oz`)
  return collapseWS(t)
}

function dedupeAdjacentTokens(title: string, warnings: string[]): string {
  const parts = title.split(/\s+/)
  const out: string[] = []
  for (const p of parts) {
    const prev = out[out.length - 1]
    if (prev && normalizeToken(prev) === normalizeToken(p)) {
      if (!warnings.includes("duplicate_token_removed")) warnings.push("duplicate_token_removed")
      continue
    }
    out.push(p)
  }
  return out.join(" ")
}

function dedupeSemanticSpam(title: string, warnings: string[]): string {
  let t = dedupeAdjacentTokens(title, warnings)

  for (const word of DEDUP_SPAM_WORDS) {
    const re = new RegExp(`\\b(${word})\\b(?:\\s+\\1\\b)+`, "gi")
    if (re.test(t)) {
      t = t.replace(re, "$1")
      if (!warnings.includes("duplicate_token_removed")) warnings.push("duplicate_token_removed")
    }
  }

  if (/storage organizer/i.test(t)) {
    const before = t
    t = t.replace(/\bStorage\b(?!\s+Organizer)/gi, " ")
    if (t !== before && !warnings.includes("duplicate_token_removed")) warnings.push("duplicate_token_removed")
  }

  if (/waterproof/i.test(t) && /weatherproof/i.test(t)) {
    t = t.replace(/\bWeatherproof\b/gi, " ")
    if (!warnings.includes("duplicate_token_removed")) warnings.push("duplicate_token_removed")
  }

  if (/garage hooks/i.test(t)) {
    const before = t
    t = collapseWS(t.replace(/\bGarage Hooks\b(?:\s+Garage Hooks\b)+/gi, "Garage Hooks"))
    if (t !== before && !warnings.includes("duplicate_token_removed")) warnings.push("duplicate_token_removed")
  }

  const protectedPhrases = ["drill bits", "tool kit", "plug socket", "plug socket box"]
  for (const pp of protectedPhrases) {
    const re = new RegExp(`\\b${pp.replace(/\s+/g, "\\s+")}\\b`, "gi")
    if (re.test(t)) {
      t = t.replace(re, m => m.split(/\s+/).map(titleCaseWord).join(" "))
    }
  }

  const parts = t.split(/\s+/).filter(Boolean)
  const seenSpam = new Set<string>()
  const out: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    const key = normalizeToken(p)
    const next = parts[i + 1]
    const pair = next ? `${p} ${next}`.toLowerCase() : ""
    if (next && protectedPhrases.some(pp => pair === pp)) {
      out.push(p, next)
      i++
      continue
    }
    if (DEDUP_SPAM_WORDS.has(key) && seenSpam.has(key)) {
      if (!warnings.includes("duplicate_token_removed")) warnings.push("duplicate_token_removed")
      continue
    }
    if (DEDUP_SPAM_WORDS.has(key)) seenSpam.add(key)
    out.push(p)
  }

  return collapseWS(out.join(" "))
}

function stripOrphanHonorifics(title: string, warnings: string[]): string {
  const before = title
  const t = collapseWS(title.replace(/\bMr\.?\b/gi, " "))
  if (t !== before) warnings.push("orphan_honorific_removed")
  return t
}

function dedupeRepeatedSizeMentions(title: string, warnings: string[]): string {
  const sizeMatch = title.match(/\b(\d+(?:\.\d+)?\s*(?:fl\s*oz|oz|ft|in))\b/i)
  if (!sizeMatch) return title
  const size = sizeMatch[1]
  const re = new RegExp(`\\b${escapeRegExp(size)}\\b`, "gi")
  let seen = false
  const before = title
  const t = collapseWS(title.replace(re, () => {
    if (seen) return " "
    seen = true
    return size
  }))
  if (t !== before && !warnings.includes("duplicate_token_removed")) warnings.push("duplicate_token_removed")
  return t
}

function polishCompiledTitle(
  title: string,
  brand: string | null | undefined,
  techSpecs: string[],
  warnings: string[]
): string {
  let t = normalizeTitleTechnicalCase(title)
  t = removeBrandFromText(t, brand)
  t = stripOrphanHonorifics(t, warnings)
  t = dedupeSemanticSpam(t, warnings)
  t = dedupeRepeatedSizeMentions(t, warnings)
  t = stripOrphanTrailingNumber(t, techSpecs)
  t = stripTrailingStopWords(t)
  if (containsBrand(t, brand)) {
    t = removeBrandFromText(t, brand)
    if (!warnings.includes("brand_removed")) warnings.push("brand_removed")
  }
  t = stripBannedSeasonalTerms(t, warnings)
  return collapseWS(t)
}

type ChainsawResolution = {
  primary:       string | null
  extraFeatures: string[]
  extraTech:     string[]
  excludeFound:  string[]
}

function resolveChainsawHeadProduct(source: string): ChainsawResolution {
  const empty: ChainsawResolution = { primary: null, extraFeatures: [], extraTech: [], excludeFound: [] }
  if (!/\b(chainsaw chain|saw chain|mini saw chain)\b/i.test(source)) return empty

  const extraFeatures: string[] = []
  if (/manganese/i.test(source)) extraFeatures.push("Manganese Steel")
  if (/replacement/i.test(source)) extraFeatures.push("Replacement")

  const extraTech: string[] = []
  const drive = source.match(/\b(\d+)\s+Drive\s+Links\b/i)
  if (drive) extraTech.push(`${drive[1]} Drive Links`)

  const excludeFound = [
    "cordless electric portable mini chainsaw",
    "mini chainsaw",
    "portable mini chainsaw",
    "cordless electric portable",
  ]

  return {
    primary:       "Chainsaw Chain",
    extraFeatures,
    extraTech,
    excludeFound,
  }
}

function blocksLength(blocks: TitleBlock[]): number {
  return joinBlocks(blocks).length
}

function trimBlocksToMax(blocks: TitleBlock[], maxLength: number): TitleBlock[] {
  let work = [...blocks]
  while (work.length > 0 && blocksLength(work) > maxLength) {
    const droppable = [...work]
      .map((b, idx) => ({ b, idx }))
      .filter(({ b }) => !PROTECTED_TRIM_KINDS.has(b.kind))
      .sort((a, b) => BLOCK_PRIORITY[b.b.kind] - BLOCK_PRIORITY[a.b.kind])

    if (droppable.length > 0) {
      const featureOnly = droppable.filter(({ b }) => b.kind === "feature")
      if (featureOnly.length > 0) {
        const dropIdx = featureOnly[featureOnly.length - 1].idx
        work.splice(dropIdx, 1)
        continue
      }
      work.splice(droppable[0].idx, 1)
      continue
    }

    const lastRemovable = [...work]
      .map((b, idx) => ({ b, idx }))
      .filter(({ b }) => b.kind !== "qty" && b.kind !== "size")
      .sort((a, b) => BLOCK_PRIORITY[b.b.kind] - BLOCK_PRIORITY[a.b.kind])

    if (lastRemovable.length > 0) {
      work.splice(lastRemovable[0].idx, 1)
      continue
    }
    break
  }

  let title = joinBlocks(work)
  if (title.length <= maxLength) return work

  title = truncateAtPhraseBoundary(title, maxLength)
  return [{ text: title, kind: "filler", atomic: true }]
}

function truncateAtPhraseBoundary(title: string, maxLength: number): string {
  let t = collapseWS(title)
  if (t.length <= maxLength) return t

  const parts = t.split(/\s+/)
  while (parts.length > 1 && parts.join(" ").length > maxLength) {
    const last = parts[parts.length - 1]
    if (/^\d+$/.test(last) && parts.length > 1) {
      parts.pop()
      continue
    }
    parts.pop()
  }

  t = parts.join(" ")
  if (t.length <= maxLength) return t

  const within = t.slice(0, maxLength)
  const lastSpace = within.lastIndexOf(" ")
  if (lastSpace > maxLength * 0.5) {
    return collapseWS(within.slice(0, lastSpace))
  }
  return collapseWS(within)
}

function stripOrphanTrailingNumber(title: string, techSpecs: string[]): string {
  const parts = title.split(/\s+/)
  if (parts.length < 2) return title

  const last = parts[parts.length - 1]
  if (!/^\d+$/.test(last)) return title

  const gaugeSpec = techSpecs.find(s => s.startsWith(`${last} Gauge`))
  if (gaugeSpec) {
    parts[parts.length - 1] = gaugeSpec
    return parts.join(" ")
  }

  const awgSpec = techSpecs.find(s => s.startsWith(`${last} AWG`))
  if (awgSpec) {
    parts[parts.length - 1] = awgSpec
    return parts.join(" ")
  }

  parts.pop()
  return collapseWS(parts.join(" "))
}

function stripTrailingStopWords(title: string): string {
  const parts = title.split(/\s+/)
  while (parts.length > 1 && TRAILING_STOP_WORDS.has(parts[parts.length - 1].toLowerCase())) {
    parts.pop()
  }
  return collapseWS(parts.join(" "))
}

function collectFinalQualityWarnings(
  title: string,
  brand: string | null | undefined,
  productType: string | null,
  maxLength: number,
  warnings: string[]
): void {
  const parts = title.split(/\s+/).filter(Boolean)
  for (let i = 1; i < parts.length; i++) {
    if (normalizeToken(parts[i]) === normalizeToken(parts[i - 1])) {
      if (!warnings.includes("duplicate_token_remaining")) warnings.push("duplicate_token_remaining")
      break
    }
  }

  if (/\b[A-Za-z]{2,}\d{3,}[A-Za-z0-9]*\b/.test(title)) {
    const m = title.match(/\b[A-Za-z]{2,}\d{3,}[A-Za-z0-9]*\b/)
    if (m && !isProtectedTechnicalToken(m[0]) && !warnings.includes("model_code_remaining")) {
      warnings.push("model_code_remaining")
    }
  }

  if (containsBrand(title, brand) && !warnings.includes("brand_remaining")) {
    warnings.push("brand_remaining")
  }

  if (/\bMr\.?\b/i.test(title) && !warnings.includes("orphan_honorific_remaining")) {
    warnings.push("orphan_honorific_remaining")
  }

  if (/\bip\d{2}\b/i.test(title) && !/\bIP\d{2}\b/.test(title)) {
    warnings.push("lowercase_technical_token")
  }
  if (/\betl\b/i.test(title) && !/\bETL\b/.test(title)) warnings.push("lowercase_technical_token")
  if (/\bawg\b/i.test(title) && !/\bAWG\b/.test(title)) warnings.push("lowercase_technical_token")

  if (!productType && !hasConcreteProductNoun(title) && !warnings.includes("product_type_missing")) {
    warnings.push("product_type_missing")
  }

  if (title.length > maxLength && !warnings.includes("title_over_max")) {
    warnings.push("title_over_max")
  }

  if (containsBannedSeasonalTerm(title) && !warnings.includes("banned_term_remaining")) {
    warnings.push("banned_term_remaining")
  }
}

function finalizeTitle(
  title: string,
  maxLength: number,
  brand: string | null | undefined,
  techSpecs: string[],
  warnings: string[]
): string {
  let t = polishCompiledTitle(collapseWS(title), brand, techSpecs, warnings)
  t = stripOrphanTrailingNumber(t, techSpecs)
  t = stripTrailingStopWords(t)
  t = removeBrandFromText(t, brand)

  if (t.length > maxLength) {
    t = truncateAtPhraseBoundary(t, maxLength)
    warnings.push("phrase_truncated")
  }

  t = stripOrphanTrailingNumber(t, techSpecs)
  t = stripTrailingStopWords(t)

  if (containsBrand(t, brand)) {
    t = removeBrandFromText(t, brand)
    warnings.push("brand_stripped_late")
  }

  const parts = t.split(/\s+/)
  const last = parts[parts.length - 1]
  if (/^\d+$/.test(last)) {
    parts.pop()
    t = collapseWS(parts.join(" "))
    warnings.push("orphan_number_removed")
  }

  t = stripBannedSeasonalTerms(t, warnings)
  return collapseWS(t).slice(0, maxLength)
}

function inferBrandFromTitle(title: string): string | null {
  const first = title.trim().split(/\s+/)[0]
  if (!first || first.length < 2) return null
  if (/^\d/.test(first)) return null
  if (/^(fathers|mothers|daddy|funny|the|a|an|for|with|gift|gifts|assortment|hydrating)/i.test(first)) return null
  if (MARKETING_WORDS.has(first.toLowerCase())) return null
  if (OCCASION_ONLY_WORDS.has(first.toLowerCase())) return null
  if (NON_BRAND_FIRST_WORDS.has(first.toLowerCase())) return null
  return first
}

function normalizeFeatureDisplay(phrase: string): string {
  const lower = phrase.toLowerCase()
  if (/fill in/i.test(lower)) return "Fill in Blanks"
  if (/sweet.*roasted.*salted/i.test(lower)) return "Sweet Roasted Salted"
  if (/gourmet nuts/i.test(lower)) return "Gourmet Nuts"
  if (/heavy duty/i.test(lower)) return "Heavy Duty"
  if (/battery and charger/i.test(lower)) return "Battery Charger"
  if (/drill bits/i.test(lower)) return "Drill Bits"
  if (/solid and slotted turner/i.test(lower)) return "Solid Slotted Turner"
  if (/slotted turner flipper/i.test(lower)) return "Slotted Turner Flipper"
  if (/slotted turner/i.test(lower)) return "Slotted Turner"
  if (/turner flipper/i.test(lower)) return "Turner Flipper"
  if (/plug socket box/i.test(lower)) return "Plug Socket Box"
  if (/plug socket/i.test(lower)) return "Plug Socket"
  if (/connection box/i.test(lower)) return "Connection Box"
  if (/electrical enclosure/i.test(lower)) return "Electrical Enclosure"
  if (/car wash/i.test(lower)) return "Car Wash"
  if (/auto shampoo/i.test(lower)) return "Auto Shampoo"
  if (/tool kit/i.test(lower)) return "Tool Kit"
  if (/kitchen use/i.test(lower)) return "Kitchen"
  if (/cooking utensils/i.test(lower)) return "Cooking Utensils"
  return titleCasePhrase(phrase)
}

function isGiftSeasonalContext(source: string, occasions: string[]): boolean {
  const hardware = HARDWARE_CONTEXT_RE.test(source)
  const giftProduct = /\b(gift basket|gift box|greeting card|keepsake card|tumbler|mug|nuts gift|wine tumbler|coffee mug)\b/i.test(source)
  if (hardware && !giftProduct) {
    return occasions.some(o => /father|mother|birthday|valentine|anniversary/i.test(o))
  }
  if (occasions.length > 0) return true
  return /\b(fathers?\s*day|mothers?\s*day|christmas|valentine|birthday\s+gift|gift\s+basket|gift\s+box|keepsake\s+card|greeting\s+card)\b/i.test(source)
}

function hasConcreteProductNoun(text: string): boolean {
  return tokenize(text.toLowerCase()).some(w => CONCRETE_PRODUCT_NOUNS.has(normalizeToken(w)))
}

function isOccasionOnlyTitle(title: string): boolean {
  const words = tokenize(title.toLowerCase())
  if (words.length === 0) return true
  const hasConcrete = words.some(w => CONCRETE_PRODUCT_NOUNS.has(normalizeToken(w)))
  if (hasConcrete) return false
  const materialOrSize = /\b(\d+\s*(oz|in|cm|mm|pcs|gauge|awg)|stainless|steel|plastic|galvanized)\b/i.test(title)
  if (materialOrSize) return false
  return words.every(w => OCCASION_ONLY_WORDS.has(normalizeToken(w)) || STOP_WORDS.has(normalizeToken(w)))
}

function pickPrimaryOccasion(found: string[]): string | null {
  const eligible = found.filter(o => !containsBannedSeasonalTerm(o))
  if (eligible.length === 0) return null
  const priority = (s: string): number => {
    const l = s.toLowerCase()
    if (/father/i.test(l)) return 10
    if (/mother/i.test(l)) return 9
    if (/birthday/i.test(l)) return 8
    if (/valentine/i.test(l)) return 3
    return 5
  }
  return [...eligible].sort((a, b) => priority(b) - priority(a))[0]
}

function pickPrimaryRecipient(found: string[]): string | null {
  if (found.length === 0) return null
  const priority = (s: string): number => {
    const l = s.toLowerCase()
    if (/dad gift/i.test(l)) return 10
    if (/for dad/i.test(l)) return 9
    if (/gift for dad/i.test(l)) return 9
    if (/for men/i.test(l)) return 3
    if (/daughter/i.test(l)) return 2
    if (/grandpa/i.test(l)) return 4
    return 5
  }
  const ranked = [...found].sort((a, b) => priority(b) - priority(a))
  const best = ranked[0]
  if (/dad/i.test(best)) return "Dad Gift"
  if (/for men/i.test(best)) return "For Men"
  return titleCasePhrase(best)
}

function formatOccasionDisplay(phrase: string): string {
  return titleCasePhrase(phrase)
    .replace(/Father's Day/i, "Fathers Day")
    .replace(/Mother's Day/i, "Mothers Day")
}

function pickProductTypes(
  found: string[],
  plantCtx: boolean,
  beautyMain: string | null,
  beautyProduct: string | null,
  chainsawPrimary: string | null,
  source: string,
): string[] {
  if (chainsawPrimary) return [chainsawPrimary]
  if (beautyMain) return [beautyMain]
  if (beautyProduct) return [beautyProduct]
  if (/\bcordless\b/i.test(source) && /\bdrill driver set\b/i.test(source)) {
    return ["Cordless Drill Driver Set"]
  }
  if (plantCtx) {
    const plantTag = found.find(f => /plant tags/i.test(f))
    if (plantTag) return [titleCasePhrase(plantTag)]
    return ["Plant Tags"]
  }

  const ranked = found.map(titleCasePhrase).sort((a, b) => b.length - a.length)
  const prefer = (pattern: RegExp, label: string): string | null => {
    if (!pattern.test(source)) return null
    const hit = ranked.find(p => pattern.test(p))
    return hit ?? label
  }

  if (/\bspatula\s+set\b/i.test(source)) return ["Spatula Set"]
  if (/\bfoam party\b/i.test(source) && /\bwash\b/i.test(source)) {
    return ["Foam Party Car Wash"]
  }
  if (/\boutdoor power strip\b/i.test(source)) return ["Outdoor Power Strip"]

  const preferred =
    prefer(/spatula set/i, "Spatula Set") ??
    prefer(/cordless drill driver set/i, "Cordless Drill Driver Set") ??
    prefer(/magnetic garage hooks/i, "Magnetic Garage Hooks") ??
    prefer(/outdoor power strip/i, "Outdoor Power Strip With Stake") ??
    prefer(/outdoor extension cord cover/i, "Outdoor Extension Cord Cover") ??
    prefer(/outdoor electrical box/i, "Outdoor Electrical Box")

  if (preferred) return [titleCasePhrase(preferred)]

  const out: string[] = []
  for (const p of ranked) {
    if (/mini chainsaw/i.test(p) && ranked.some(x => /chain/i.test(x))) continue
    if (/magnetic storage hooks/i.test(p) && ranked.some(x => /magnetic garage hooks/i.test(x))) continue
    if (out.some(x => x.toLowerCase().includes(p.toLowerCase()) || p.toLowerCase().includes(x.toLowerCase()))) continue
    out.push(p)
    if (out.length >= 2) break
  }
  return out
}

function inferHeadNounProduct(source: string): string | null {
  const lower = source.toLowerCase()
  const tokens = tokenize(lower)
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (!CONCRETE_PRODUCT_NOUNS.has(normalizeToken(tokens[i]))) continue
    const start = Math.max(0, i - 3)
    const slice = tokens.slice(start, i + 1)
    return titleCasePhrase(slice.join(" "))
  }
  return null
}

function scoreTitleQuality(
  title: string,
  productTypes: string[],
  brand: string | null | undefined,
  techSpecs: string[],
  maxLength: number,
  mandatoryPhrases: string[] = []
): number {
  let score = 0
  if (title.length <= maxLength) score += 10
  if (title.length >= TARGET_TITLE_MIN) score += 15
  else if (title.length >= GOOD_TITLE_MIN) score += 8
  else score -= 15
  if (productTypes.length > 0 && productTypes.some(p => title.toLowerCase().includes(p.toLowerCase().split(" ")[0]))) {
    score += 25
  } else if (hasConcreteProductNoun(title)) {
    score += 20
  }
  if (mandatoryPhrases.length > 0 && !hasStrongFeatureOrUse(title, mandatoryPhrases)) score -= 20
  if (!containsBrand(title, brand)) score += 15
  if (!isOccasionOnlyTitle(title)) score += 20
  if (containsBannedSeasonalTerm(title)) score -= 50
  const parts = title.split(/\s+/)
  const last = parts[parts.length - 1]
  if (!/^\d+$/.test(last)) score += 10
  if (!/\b\d+\s*$/.test(title) || techSpecs.some(s => title.includes(s))) score += 5
  return score
}

function buildCleanedFallbackTitle(
  amazonTitle: string,
  brand: string | null | undefined,
  maxLength: number,
  techSpecs: string[]
): string {
  let cleaned = removeBrandFromText(titleCasePhrase(stripSymbols(amazonTitle)), brand)
  cleaned = normalizeSourcePhrases(cleaned)
  cleaned = finalizeTitle(cleaned, maxLength, brand, techSpecs, [])
  return cleaned
}

function pickBestMainProduct(found: string[], plantCtx: boolean): string | null {
  if (plantCtx) return "Plant Tags"
  if (found.length === 0) return null
  const priority = (s: string): number => {
    if (/self care skincare set/i.test(s)) return 12
    if (/skincare set|skin care set/i.test(s)) return 11
    if (/plant tags/i.test(s)) return 10
    if (/landscape staples/i.test(s)) return 10
    if (/garden stakes/i.test(s)) return 9
    if (/tent stakes/i.test(s)) return 8
    if (/plant cover spikes/i.test(s)) return 7
    if (/weed barrier pins/i.test(s)) return 6
    if (/yard pins/i.test(s)) return 5
    if (/sod pins/i.test(s)) return 2
    return 4
  }
  return [...found]
    .map(titleCasePhrase)
    .sort((a, b) => priority(b) - priority(a))[0]
}

function pickBestUseKeyword(found: string[], mainProduct: string | null): string | null {
  if (found.length === 0) return null
  const mainLower = (mainProduct ?? "").toLowerCase()

  const ranked = found
    .map(f => titleCasePhrase(f))
    .sort((a, b) => {
      const aHasPins = /\bpins?\b/i.test(a) ? 1 : 0
      const bHasPins = /\bpins?\b/i.test(b) ? 1 : 0
      if (aHasPins !== bHasPins) return bHasPins - aHasPins
      if (mainLower.includes("staple") && /weed barrier/i.test(a)) return -1
      if (mainLower.includes("stake") && /garden/i.test(a)) return -1
      return b.length - a.length
    })

  const best = ranked[0]
  if (/weed barrier fabric/i.test(best) && !/pins/i.test(best)) {
    return "Weed Barrier Pins"
  }
  if (/garden stakes/i.test(best) && !/pins/i.test(best) && mainLower.includes("staple")) {
    return "Garden Stakes Pins"
  }
  return best
}

function simplifyMaterialForSpace(materials: string[]): string[] {
  const out: string[] = []
  for (const m of materials) {
    const display = normalizeMaterialDisplay(m)
    if (out.some(x => x.toLowerCase() === display.toLowerCase())) continue
    out.push(display)
  }
  if (out.some(m => /galvanized/i.test(m))) {
    return out.filter(m => !/hot/i.test(m))
  }
  return out
}

export function buildTitleBotTitle(input: TitleBotInput): TitleBotResult {
  const maxLength = input.maxLength ?? DEFAULT_MAX
  const droppedTokens: string[] = []
  const warnings: string[] = []
  let fallbackUsed = false
  let strategy = "compiler"

  const sourceTitle = stripSymbols(input.amazonTitle ?? "")
  const brand = input.brand?.trim() || inferBrandFromTitle(sourceTitle) || null

  const plantCtx = isPlantLabelContext(sourceTitle)
  const beautyCtx = isBeautySetContext(sourceTitle)
  const beautyProductCtx = isBeautyProductContext(sourceTitle)
  const beautyContents = beautyCtx ? extractBeautyContents(sourceTitle) : []
  const beautyMain = beautyCtx ? extractBeautyMainProduct(sourceTitle) : null

  const mandatoryPhrases = extractMandatoryPhrases(sourceTitle)

  let raw = normalizeSourcePhrases(sourceTitle)
  raw = stripBannedSeasonalTerms(raw, warnings)
  raw = stripModelSkuCodes(raw, warnings)
  raw = removeBrandFromText(raw, brand)

  if (!raw) {
    warnings.push("empty_amazon_title")
    return { title: "", charCount: 0, source: "titlebot", droppedTokens, warnings, fallbackUsed, strategy }
  }

  const chainsaw = resolveChainsawHeadProduct(sourceTitle)

  const tTypeExtract = extractTType(raw)
  raw = tTypeExtract.remainder

  const techExtract = extractTechSpecs(raw)
  raw = techExtract.remainder
  const allTechSpecs = techExtract.specs

  const qtyExtract = extractQtyPhrase(raw)
  raw = qtyExtract.remainder

  const sizeExtract = extractSizeTokens(raw)
  raw = sizeExtract.remainder

  const giftFeatureExtract = removePhrases(raw, GIFT_FEATURE_PHRASES)
  raw = giftFeatureExtract.remainder

  const occasionExtract = removePhrases(raw, OCCASION_PHRASES)
  raw = occasionExtract.remainder

  const recipientExtract = removePhrases(raw, RECIPIENT_PHRASES)
  raw = recipientExtract.remainder

  const lowValueExtract = removePhrases(raw, LOW_VALUE_PHRASES)
  raw = lowValueExtract.remainder

  const productTypeExtract = removePhrases(raw, PRODUCT_TYPE_PHRASES)
  raw = productTypeExtract.remainder
  let productTypeFound = productTypeExtract.found
  if (chainsaw.primary) {
    productTypeFound = productTypeFound.filter(f =>
      !chainsaw.excludeFound.some(ex => f.toLowerCase().includes(ex))
    )
  }

  const useKeywordExtract = removePhrases(raw, USE_KEYWORD_PHRASES)
  raw = useKeywordExtract.remainder

  const usePhraseExtract = removePhrases(raw, USE_PHRASES)
  raw = usePhraseExtract.remainder

  const featureExtract = removePhrases(raw, FEATURE_PHRASES)
  raw = featureExtract.remainder

  const beautyProductExtract = beautyProductCtx
    ? removePhrases(raw, BEAUTY_PRODUCT_PHRASES)
    : { remainder: raw, found: [] as string[] }
  raw = beautyProductExtract.remainder

  const materialExtract = removePhrases(raw, MATERIAL_PHRASES)
  raw = materialExtract.remainder

  let colorWords: string[] = []
  const bodyWords = tokenize(raw)
  const bodyFiltered: string[] = []
  for (const w of bodyWords) {
    const n = normalizeToken(w)
    if (COLOR_WORDS.has(n)) {
      colorWords.push(titleCaseWord(w))
    } else {
      bodyFiltered.push(w)
    }
  }

  let words = removeBrandTokens(bodyFiltered, brand)
  const noise = filterNoiseWords(words)
  words = noise.kept
  droppedTokens.push(...noise.dropped, ...recipientExtract.found, ...occasionExtract.found.filter(o =>
    !pickPrimaryOccasion(occasionExtract.found)?.toLowerCase().includes(o.toLowerCase())
  ))
  words = dedupeWords(words)
  if (chainsaw.primary) {
    words = words.filter(w => !/^(portable|cordless|electric|mini|wood|wear|resistant)$/i.test(normalizeToken(w)))
  }

  const materials = simplifyMaterialForSpace(materialExtract.found)
  const productTypes = pickProductTypes(
    productTypeFound,
    plantCtx,
    beautyMain,
    beautyProductCtx ? pickBeautyProduct(beautyProductExtract.found, words) : null,
    chainsaw.primary,
    sourceTitle,
  )

  let primaryProduct: string | null = productTypes[0] ?? pickBestMainProduct(productTypeFound, plantCtx)
  if (!primaryProduct && input.productType?.trim()) {
    primaryProduct = titleCasePhrase(input.productType.trim())
  }
  if (!primaryProduct) {
    primaryProduct = inferHeadNounProduct(sourceTitle)
  }

  const secondaryProduct = productTypes.length > 1 ? productTypes[1] : null
  const primaryOccasion = pickPrimaryOccasion(occasionExtract.found)
  const primaryRecipient = pickPrimaryRecipient(recipientExtract.found)
  const giftSeasonal = isGiftSeasonalContext(sourceTitle, occasionExtract.found)
  const hasPhysicalSlots = !!(qtyExtract.phrase || sizeExtract.tokens.length || materials.length)

  const useKeyword = plantCtx
    ? null
    : pickBestUseKeyword(useKeywordExtract.found, primaryProduct)

  const plantUseKeywords = plantCtx ? ["Garden Labels", "Nursery Markers"] : []

  const useTexts = dedupeStrings([
    ...usePhraseExtract.found.map(normalizeFeatureDisplay),
    ...mandatoryPhrases.filter(p => /plug|socket|connection|kitchen|cooking|car wash|auto shampoo|tool kit|saw chain/i.test(p)),
  ])

  const featureTexts = dedupeStrings([
    ...chainsaw.extraFeatures,
    ...mandatoryPhrases.filter(p => !useTexts.some(u => u.toLowerCase() === p.toLowerCase())),
    ...giftFeatureExtract.found.map(normalizeFeatureDisplay),
    ...featureExtract.found.map(normalizeFeatureDisplay),
    ...words.filter(w => FEATURE_WORDS.has(normalizeToken(w))).map(titleCaseWord),
  ])

  const featurePriority = (f: string): number => {
    if (/fragrance free/i.test(f)) return 1
    if (/dry sensitive skin/i.test(f)) return 2
    if (/fill in blanks/i.test(f)) return 3
    if (/funny/i.test(f)) return 4
    if (/gourmet/i.test(f)) return 5
    if (/sweet roasted/i.test(f)) return 6
    return 8
  }
  const sortedFeatures = featureTexts.sort((a, b) => featurePriority(a) - featurePriority(b))

  const blocks: TitleBlock[] = []
  const sizeBlocks: TitleBlock[] = sizeExtract.tokens.map(s => ({
    text: s, kind: "size" as const, atomic: true,
  }))

  const push = (text: string, kind: BlockKind, atomic = true) => {
    if (!text.trim()) return
    blocks.push({ text: text.trim(), kind, atomic })
  }

  if (giftSeasonal && !hasPhysicalSlots && !plantCtx && !beautyProductCtx) {
    strategy = "gift_seasonal"
    const cardFeature = sortedFeatures.find(f => /funny|fill in/i.test(f))
    const foodFeature = sortedFeatures.find(f => /gourmet|sweet roasted/i.test(f))
    if (cardFeature) push(cardFeature, "feature")
    if (/\bdaddy\b/i.test(sourceTitle) && /card/i.test(sourceTitle)) {
      push("Daddy", "modifier")
    }
    if (primaryOccasion) push(formatOccasionDisplay(primaryOccasion), "occasion")
    if (foodFeature && foodFeature !== cardFeature) push(foodFeature, "feature")
    if (primaryProduct) push(primaryProduct, "product")
    if (secondaryProduct) push(secondaryProduct, "product")
    for (const f of sortedFeatures) {
      if (f === cardFeature || f === foodFeature) continue
      push(f, "feature")
    }
    if (primaryRecipient) push(primaryRecipient, "recipient")
    else if (/gift/i.test(sourceTitle) && !/gift basket|gift box/i.test(primaryProduct ?? "")) {
      push("Gift", "recipient")
    }
  } else if (giftSeasonal && hasPhysicalSlots) {
    strategy = "gift_physical"
    if (qtyExtract.phrase) push(qtyExtract.phrase, "qty")
    blocks.push(...sizeBlocks)
    for (const m of materials) push(m, "material")
    if (tTypeExtract.phrase) push(tTypeExtract.phrase, "modifier")
    if (primaryProduct) push(primaryProduct, "product")
    if (secondaryProduct) push(secondaryProduct, "product")
    for (const spec of allTechSpecs) push(spec, "tech")
    for (const f of sortedFeatures.slice(0, 2)) push(f, "feature")
    if (primaryOccasion) push(formatOccasionDisplay(primaryOccasion), "occasion")
    if (primaryRecipient) push(primaryRecipient, "recipient")
  } else {
    strategy = beautyProductCtx ? "beauty_product" : beautyCtx ? "beauty_set" : plantCtx ? "plant" : "standard"
    if (qtyExtract.phrase) push(qtyExtract.phrase, "qty")
    if (!beautyProductCtx) blocks.push(...sizeBlocks)
    for (const m of materials) push(m, "material")
    if (tTypeExtract.phrase) push(tTypeExtract.phrase, "modifier")
    if (primaryProduct) push(primaryProduct, "product")
    if (beautyProductCtx) blocks.push(...sizeBlocks)
    for (const spec of [...allTechSpecs, ...chainsaw.extraTech]) push(spec, "tech")
    if (beautyContents.length > 0) push(beautyContents.join(" "), "setContents")
    if (useKeyword) push(useKeyword, "use")
    for (const u of useTexts) push(u, "use")
    for (const kw of plantUseKeywords) push(kw, "use")
    if (/\bdry\s+sensitive\s+skin\b/i.test(sourceTitle)) push("Dry Sensitive Skin", "feature")
    if (/\bfragrance free\b/i.test(sourceTitle)) push("Fragrance Free", "feature")
    for (const f of sortedFeatures) {
      if (/dry sensitive skin|fragrance free/i.test(f)) continue
      push(f, "feature")
    }
    if (primaryOccasion && blocks.length < 6) push(titleCasePhrase(primaryOccasion), "occasion")
    for (const c of dedupeStrings(colorWords).slice(0, 1)) push(c, "color")
  }

  let trimmed = trimBlocksToMax(blocks, maxLength)
  let title = joinBlocks(trimmed)

  const enrichExtras: string[] = []
  if (primaryProduct) enrichExtras.push(primaryProduct)
  if (secondaryProduct) enrichExtras.push(secondaryProduct)
  for (const kw of plantUseKeywords) enrichExtras.push(kw)
  if (useKeyword) enrichExtras.push(useKeyword)
  if (beautyContents.length > 0) enrichExtras.push(beautyContents.join(" "))
  for (const f of sortedFeatures) enrichExtras.push(f)
  for (const m of materials) enrichExtras.push(m)
  for (const s of sizeExtract.tokens) enrichExtras.push(s)
  if (primaryOccasion) enrichExtras.push(titleCasePhrase(primaryOccasion))
  if (primaryRecipient) enrichExtras.push(primaryRecipient)
  if (tTypeExtract.phrase) enrichExtras.push(tTypeExtract.phrase)

  const allEnrichExtras = dedupeStrings([...mandatoryPhrases, ...enrichExtras, ...useTexts, ...sortedFeatures])

  title = enrichWeakTitle(title, mandatoryPhrases, allEnrichExtras, maxLength, warnings)
  title = finalizeTitle(title, maxLength, brand, allTechSpecs, warnings)

  if (title.length < GOOD_TITLE_MIN || !hasStrongFeatureOrUse(title, mandatoryPhrases)) {
    title = enrichWeakTitle(title, mandatoryPhrases, allEnrichExtras, maxLength, warnings)
    title = finalizeTitle(title, maxLength, brand, allTechSpecs, warnings)
  }

  const productTypeLabel = primaryProduct ?? productTypes[0] ?? null
  let qualityScore = scoreTitleQuality(
    title,
    productTypes.length ? productTypes : primaryProduct ? [primaryProduct] : [],
    brand,
    allTechSpecs,
    maxLength,
    mandatoryPhrases
  )

  const slots: Record<string, string[]> = {
    qty:       qtyExtract.phrase ? [qtyExtract.phrase] : [],
    size:      sizeExtract.tokens,
    material:  materials,
    product:   productTypes.length ? productTypes : primaryProduct ? [primaryProduct] : [],
    feature:   sortedFeatures,
    use:       useTexts,
    occasion:  primaryOccasion ? [titleCasePhrase(primaryOccasion)] : [],
    recipient: primaryRecipient ? [primaryRecipient] : [],
  }

  const needsFallback =
    !primaryProduct ||
    isOccasionOnlyTitle(title) ||
    qualityScore < QUALITY_MIN ||
    containsBrand(title, brand)

  if (needsFallback) {
    const fallbackTitle = buildCleanedFallbackTitle(sourceTitle, brand, maxLength, allTechSpecs)
    const fallbackScore = scoreTitleQuality(
      fallbackTitle,
      productTypes.length ? productTypes : inferHeadNounProduct(sourceTitle) ? [inferHeadNounProduct(sourceTitle)!] : [],
      brand,
      allTechSpecs,
      maxLength,
      mandatoryPhrases
    )
    if (fallbackTitle.length >= 3 && (fallbackScore >= qualityScore || isOccasionOnlyTitle(title))) {
      title = fallbackTitle
      qualityScore = fallbackScore
      fallbackUsed = true
      strategy = "fallback_cleaned_amazon"
      warnings.push("fallback_cleaned_amazon_title")
    }
  }

  if (title.length > maxLength) {
    title = finalizeTitle(truncateAtPhraseBoundary(title, maxLength), maxLength, brand, allTechSpecs, warnings)
    warnings.push("hard_truncated")
  }

  collectFinalQualityWarnings(title, brand, productTypeLabel, maxLength, warnings)

  qualityScore = scoreTitleQuality(
    title,
    productTypes.length ? productTypes : primaryProduct ? [primaryProduct] : [],
    brand,
    allTechSpecs,
    maxLength,
    mandatoryPhrases
  )

  return {
    title,
    charCount: title.length,
    source:    "titlebot",
    droppedTokens,
    warnings,
    fallbackUsed,
    strategy,
    productType: productTypeLabel,
    slots,
    qualityScore,
  }
}

export { parseTitleMode } from "../listingAiMode/listingAiModeService"

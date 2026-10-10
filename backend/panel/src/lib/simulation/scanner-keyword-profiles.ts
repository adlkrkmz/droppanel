export type ScannerKeywordProfileId =
  | 'default'
  | 'electronics'
  | 'home-kitchen'
  | 'pet-supplies'
  | 'sports-outdoors'

export type ScannerKeywordProfile = {
  id: ScannerKeywordProfileId
  displayName: string
  /** Keyword shown during simulated typing. */
  demoKeyword: string
  /** Lines revealed during scan phase (demo copy). */
  scanLines: string[]
  /** Result chips after scan completes. */
  resultTags: string[]
  /** Simulated match count for ticker. */
  matchCount: number
  /** Simulated avg opportunity score. */
  opportunityScore: number
}

export const SCANNER_KEYWORD_PROFILES: Record<
  ScannerKeywordProfileId,
  ScannerKeywordProfile
> = {
  default: {
    id: 'default',
    displayName: 'General',
    demoKeyword: 'magnetic cable organizer',
    scanLines: [
      'Parsing keyword cluster…',
      'Cross-referencing ASIN velocity…',
      'Estimating listing gap…',
    ],
    resultTags: ['Low competition', 'Rising intent', 'Bundle-friendly'],
    matchCount: 128,
    opportunityScore: 78,
  },
  electronics: {
    id: 'electronics',
    displayName: 'Electronics',
    demoKeyword: 'usb-c charging dock',
    scanLines: [
      'Indexing electronics taxonomy…',
      'Scanning compatible ASIN families…',
      'Modeling price bands…',
    ],
    resultTags: ['Variant-rich', 'Fast turnover', 'Spec-driven'],
    matchCount: 214,
    opportunityScore: 72,
  },
  'home-kitchen': {
    id: 'home-kitchen',
    displayName: 'Home & Kitchen',
    demoKeyword: 'silicone air fryer liner',
    scanLines: [
      'Mapping kitchen sub-niches…',
      'Reviewing seasonal demand curve…',
      'Checking margin spread…',
    ],
    resultTags: ['Consumable repeat', 'Visual listing', 'Giftable'],
    matchCount: 96,
    opportunityScore: 84,
  },
  'pet-supplies': {
    id: 'pet-supplies',
    displayName: 'Pet Supplies',
    demoKeyword: 'calming pet bed',
    scanLines: [
      'Aggregating pet search terms…',
      'Ranking velocity by weight class…',
      'Surfacing whitespace SKUs…',
    ],
    resultTags: ['Emotional hook', 'Size variants', 'Loyalty niche'],
    matchCount: 67,
    opportunityScore: 81,
  },
  'sports-outdoors': {
    id: 'sports-outdoors',
    displayName: 'Sports & Outdoors',
    demoKeyword: 'resistance band set',
    scanLines: [
      'Loading fitness keyword graph…',
      'Benchmarking competitor density…',
      'Projecting 30-day momentum…',
    ],
    resultTags: ['Kit bundling', 'Influencer lift', 'Seasonal peak'],
    matchCount: 143,
    opportunityScore: 75,
  },
}

export const DEFAULT_SCANNER_PROFILE_ID: ScannerKeywordProfileId = 'default'

export function getScannerKeywordProfile(
  id: ScannerKeywordProfileId = DEFAULT_SCANNER_PROFILE_ID
): ScannerKeywordProfile {
  return SCANNER_KEYWORD_PROFILES[id] ?? SCANNER_KEYWORD_PROFILES.default
}

export function listScannerKeywordProfileIds(): ScannerKeywordProfileId[] {
  return Object.keys(SCANNER_KEYWORD_PROFILES) as ScannerKeywordProfileId[]
}

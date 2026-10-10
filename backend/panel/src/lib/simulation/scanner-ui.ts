import type { ScannerKeywordProfile, ScannerKeywordProfileId } from './scanner-keyword-profiles'
import { getScannerKeywordProfile } from './scanner-keyword-profiles'

/** Staged lines shown during scan (demo simulation). */
export const SCANNER_STAGED_LINES = [
  'Initializing market scan',
  'Scanning active listings',
  'Analyzing seasonal demand',
  'Computing saturation index',
  'Scoring AI opportunity window',
] as const

export type ScannerDemoResults = {
  demandScore: number
  saturationIndex: number
  seasonalTrend: string
  aiOpportunityScore: number
  recommendation: string
}

function hashKeyword(keyword: string): number {
  let h = 0
  for (let i = 0; i < keyword.length; i++) {
    h = (h * 31 + keyword.charCodeAt(i)) >>> 0
  }
  return h
}

function detectProfileId(keyword: string): ScannerKeywordProfileId {
  const k = keyword.toLowerCase()
  if (/usb|charger|electronic|dock|cable|phone|laptop/.test(k)) return 'electronics'
  if (/kitchen|air fryer|cook|silicone|home|linen/.test(k)) return 'home-kitchen'
  if (/pet|dog|cat|groom|calming/.test(k)) return 'pet-supplies'
  if (/fitness|sport|band|outdoor|gym/.test(k)) return 'sports-outdoors'
  return 'default'
}

/** Deterministic demo scores from keyword + profile (not live data). */
export function deriveScannerDemoResults(keyword: string): ScannerDemoResults & {
  profile: ScannerKeywordProfile
} {
  const profileId = detectProfileId(keyword)
  const profile = getScannerKeywordProfile(profileId)
  const h = hashKeyword(keyword.trim() || profile.demoKeyword)
  const demandScore = Math.min(96, Math.max(48, profile.opportunityScore + (h % 17) - 8))
  const saturationIndex = Math.min(88, Math.max(12, 35 + (h % 40)))
  const seasonalOptions = ['Rising Q2 curve', 'Stable year-round', 'Early seasonal lift', 'Late-cycle cooling']
  const seasonalTrend = seasonalOptions[h % seasonalOptions.length]
  const aiOpportunityScore = Math.min(
    98,
    Math.max(42, Math.round((demandScore * 0.55 + (100 - saturationIndex) * 0.45)))
  )

  let recommendation =
    'Moderate opportunity — validate margin and shipping before scaling dispatch.'
  if (aiOpportunityScore >= 80) {
    recommendation =
      'Strong AI opportunity window — prioritize listing tests and controlled dispatch volume.'
  } else if (aiOpportunityScore >= 65) {
    recommendation =
      'Viable niche with manageable saturation — bundle positioning may improve conversion.'
  } else if (saturationIndex >= 70) {
    recommendation =
      'Elevated saturation — narrow to a micro-keyword or differentiated bundle before dispatch.'
  }

  return {
    profile,
    demandScore,
    saturationIndex,
    seasonalTrend,
    aiOpportunityScore,
    recommendation,
  }
}

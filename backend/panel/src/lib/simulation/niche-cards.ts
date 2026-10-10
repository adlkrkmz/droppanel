export type NicheCardTrend = 'up' | 'flat' | 'down'

export type NicheCardData = {
  id: string
  label: string
  category: string
  /** Demo opportunity score 0–100. */
  score: number
  trend: NicheCardTrend
  deltaLabel: string
  insight: string
}

export type NicheCardDeck = {
  cards: NicheCardData[]
}

const NICHE_SEED: NicheCardData[] = [
  {
    id: 'niche-kitchen-gadgets',
    label: 'Kitchen Gadgets',
    category: 'Home & Kitchen',
    score: 82,
    trend: 'up',
    deltaLabel: '+18% demand',
    insight: 'Low listing density vs rising search volume in cordless prep tools.',
  },
  {
    id: 'niche-pet-grooming',
    label: 'Pet Grooming',
    category: 'Pet Supplies',
    score: 76,
    trend: 'up',
    deltaLabel: '+11% velocity',
    insight: 'Repeat-purchase accessories trending on short-form discovery.',
  },
  {
    id: 'niche-desk-ergonomics',
    label: 'Desk Ergonomics',
    category: 'Office Products',
    score: 71,
    trend: 'flat',
    deltaLabel: 'Stable spread',
    insight: 'Mature niche — margin wins from bundle positioning.',
  },
  {
    id: 'niche-outdoor-lighting',
    label: 'Outdoor Lighting',
    category: 'Tools & Home',
    score: 68,
    trend: 'up',
    deltaLabel: '+9% seasonal',
    insight: 'Seasonal uplift; watch fulfillment lead times.',
  },
  {
    id: 'niche-travel-accessories',
    label: 'Travel Accessories',
    category: 'Luggage & Travel',
    score: 64,
    trend: 'down',
    deltaLabel: '-3% comps',
    insight: 'Compression saturated — micro-niches still viable.',
  },
  {
    id: 'niche-fitness-recovery',
    label: 'Fitness Recovery',
    category: 'Sports & Outdoors',
    score: 79,
    trend: 'up',
    deltaLabel: '+14% intent',
    insight: 'Portable recovery tools showing breakout keyword clusters.',
  },
]

/** Simulated niche opportunity cards for homepage ambient layer. */
export function createNicheCardDeck(): NicheCardDeck {
  return { cards: NICHE_SEED.map((c) => ({ ...c })) }
}

export function getNicheCardById(deck: NicheCardDeck, id: string): NicheCardData | undefined {
  return deck.cards.find((c) => c.id === id)
}

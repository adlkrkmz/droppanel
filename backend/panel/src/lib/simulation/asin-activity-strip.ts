export type AsinStripSignal = 'neutral' | 'rising' | 'hot' | 'cooling'

export type AsinStripItem = {
  asin: string
  title: string
  signal: AsinStripSignal
  /** Simulated relative velocity label (demo only). */
  velocityLabel: string
  /** 0–100 demo score. */
  pulseScore: number
}

export type AsinActivityStripData = {
  items: AsinStripItem[]
  cycleMs: number
}

const DEMO_ASINS: Omit<AsinStripItem, 'asin'>[] = [
  { title: 'Cordless Desk Lamp', signal: 'rising', velocityLabel: '+12%', pulseScore: 74 },
  { title: 'Magnetic Cable Organizer', signal: 'hot', velocityLabel: '+28%', pulseScore: 91 },
  { title: 'Portable Blender Cup', signal: 'neutral', velocityLabel: '±2%', pulseScore: 52 },
  { title: 'Pet Grooming Glove', signal: 'rising', velocityLabel: '+9%', pulseScore: 68 },
  { title: 'Silicone Baking Mat Set', signal: 'cooling', velocityLabel: '-4%', pulseScore: 41 },
  { title: 'LED Strip Controller', signal: 'hot', velocityLabel: '+31%', pulseScore: 88 },
  { title: 'Travel Jewelry Case', signal: 'rising', velocityLabel: '+7%', pulseScore: 63 },
  { title: 'Stainless Herb Scissors', signal: 'neutral', velocityLabel: '+1%', pulseScore: 55 },
  { title: 'Foldable Laptop Stand', signal: 'hot', velocityLabel: '+24%', pulseScore: 85 },
  { title: 'Waterproof Phone Pouch', signal: 'cooling', velocityLabel: '-6%', pulseScore: 38 },
]

const ASIN_PREFIXES = ['B0', 'B1', 'B2', 'B3']

function demoAsin(index: number): string {
  const prefix = ASIN_PREFIXES[index % ASIN_PREFIXES.length]
  const suffix = (1000000 + index * 7919).toString(36).toUpperCase().slice(0, 7)
  return `${prefix}${suffix}`
}

/** Simulated ASIN marquee data — no API. */
export function createAsinActivityStrip(): AsinActivityStripData {
  const items: AsinStripItem[] = DEMO_ASINS.map((row, i) => ({
    asin: demoAsin(i),
    ...row,
  }))
  return { items, cycleMs: 4200 }
}

/** Rotate strip order for CSS marquee tick (immutable). */
export function rotateAsinStrip(
  data: AsinActivityStripData,
  steps = 1
): AsinActivityStripData {
  const items = [...data.items]
  for (let s = 0; s < steps; s++) {
    const first = items.shift()
    if (first) items.push(first)
  }
  return { ...data, items }
}

export function signalColorToken(signal: AsinStripSignal): string {
  switch (signal) {
    case 'hot':
      return 'var(--pub-accent, #f43f5e)'
    case 'rising':
      return 'var(--accent, #00ff88)'
    case 'cooling':
      return 'var(--sub, #888888)'
    default:
      return 'var(--dim, #555555)'
  }
}

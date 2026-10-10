export type AmbientLabel = {
  id: string
  text: string
  top: string
  left: string
  delay: string
}

export const AMBIENT_LABELS: AmbientLabel[] = [
  { id: 'a1', text: 'US-EAST-2', top: '12%', left: '8%', delay: '0s' },
  { id: 'a2', text: 'DISPATCH ACTIVE', top: '22%', left: '72%', delay: '1.2s' },
  { id: 'a3', text: 'SYNCED', top: '48%', left: '4%', delay: '2.4s' },
  { id: 'a4', text: 'QUEUE STABLE', top: '58%', left: '82%', delay: '0.6s' },
  { id: 'a5', text: 'TREND SIGNAL', top: '78%', left: '14%', delay: '3s' },
  { id: 'a6', text: 'SATURATION LOW', top: '85%', left: '68%', delay: '1.8s' },
  { id: 'a7', text: 'RT-8842', top: '35%', left: '88%', delay: '4s' },
  { id: 'a8', text: 'AI SCORE', top: '68%', left: '38%', delay: '2s' },
]

export const AMBIENT_LABELS_LITE: AmbientLabel[] = AMBIENT_LABELS.slice(0, 4)

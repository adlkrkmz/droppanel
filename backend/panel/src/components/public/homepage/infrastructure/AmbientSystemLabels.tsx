'use client'

import { AMBIENT_LABELS, AMBIENT_LABELS_LITE } from '@/lib/infrastructure/ambient-labels'

import { useInfraCapabilities } from './hooks/useInfraCapabilities'

export default function AmbientSystemLabels() {
  const { isMobile, motionEnabled } = useInfraCapabilities()
  const labels = isMobile ? AMBIENT_LABELS_LITE : AMBIENT_LABELS

  return (
    <div className="ops-ambient-labels" aria-hidden>
      {labels.map((label) => (
        <span
          key={label.id}
          className={`ops-ambient-label${motionEnabled ? ' ops-ambient-label--blink' : ''}`}
          style={{
            top: label.top,
            left: label.left,
            animationDelay: label.delay,
          }}
        >
          {label.text}
        </span>
      ))}
    </div>
  )
}

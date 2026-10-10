'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  DEMO_MODE_LABEL,
  SCANNER_PLACEHOLDER,
  SCANNER_STAGED_LINES,
  createScannerSequenceTimeline,
  createTimerRegistry,
  deriveScannerDemoResults,
  getScannerDurationMs,
  getScannerPhaseAt,
  getScannerProgress,
  prefersReducedMotion,
} from '@/lib/simulation'
import type { ScannerDemoResults, ScannerSequenceTimeline } from '@/lib/simulation'

type ScanState = 'idle' | 'running' | 'complete'

function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)')
    const apply = () => setMobile(mq.matches)
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [])
  return mobile
}

function visibleLineCount(
  elapsedMs: number,
  timeline: ScannerSequenceTimeline
): number {
  const phase = getScannerPhaseAt(timeline, elapsedMs)
  if (phase.id === 'results') return SCANNER_STAGED_LINES.length
  if (phase.id !== 'scanning' && phase.id !== 'analyzing') return 0
  const scanning = timeline.phases.find((p) => p.id === 'scanning')
  const analyzing = timeline.phases.find((p) => p.id === 'analyzing')
  if (!scanning || !analyzing) return 0
  const progress = Math.max(
    0,
    Math.min(1, (elapsedMs - scanning.startMs) / (analyzing.endMs - scanning.startMs))
  )
  if (progress <= 0) return 0
  return Math.min(
    SCANNER_STAGED_LINES.length,
    Math.ceil(progress * SCANNER_STAGED_LINES.length)
  )
}

export default function InteractiveScanner() {
  const isMobile = useIsMobile()
  const [keyword, setKeyword] = useState('')
  const [scanState, setScanState] = useState<ScanState>('idle')
  const [elapsedMs, setElapsedMs] = useState(0)
  const [results, setResults] = useState<ScannerDemoResults | null>(null)
  const registryRef = useRef<ReturnType<typeof createTimerRegistry> | null>(null)
  const startRef = useRef(0)

  const canScan = keyword.trim().length >= 3
  const durationMs = getScannerDurationMs({ isMobile, respectReducedMotion: true })
  const timeline = createScannerSequenceTimeline('default', { isMobile })
  const phase =
    scanState === 'running' || scanState === 'complete'
      ? getScannerPhaseAt(timeline, elapsedMs)
      : { id: 'idle' as const, startMs: 0, endMs: 0 }
  const progress =
    scanState === 'running' ? getScannerProgress(timeline, elapsedMs) : scanState === 'complete' ? 1 : 0
  const linesVisible = visibleLineCount(elapsedMs, timeline)

  const stopTimers = useCallback(() => {
    registryRef.current?.clearAll()
    registryRef.current = null
  }, [])

  const finishScan = useCallback(
    (term: string) => {
      stopTimers()
      setResults(deriveScannerDemoResults(term))
      setElapsedMs(timeline.totalDurationMs)
      setScanState('complete')
    },
    [stopTimers, timeline.totalDurationMs]
  )

  const runScan = useCallback(() => {
    const term = keyword.trim()
    if (term.length < 3) return

    stopTimers()
    setResults(null)
    setScanState('running')
    setElapsedMs(0)
    startRef.current = Date.now()

    if (durationMs <= 0 || prefersReducedMotion()) {
      finishScan(term)
      return
    }

    const registry = createTimerRegistry()
    registryRef.current = registry
    registry.setInterval(() => {
      const elapsed = Date.now() - startRef.current
      if (elapsed >= timeline.totalDurationMs) {
        finishScan(term)
        return
      }
      setElapsedMs(elapsed)
    }, 50)
  }, [keyword, durationMs, finishScan, stopTimers, timeline.totalDurationMs])

  useEffect(() => () => stopTimers(), [stopTimers])

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && canScan && scanState !== 'running') {
      e.preventDefault()
      runScan()
    }
  }

  return (
    <section className="lj-scanner-section" id="scanner">
      <div className="lj-scanner-card">
        <div className="lj-scanner-head">
          <span className="lj-scanner-title">Interactive market scanner</span>
          <span className="lj-demo-label">{DEMO_MODE_LABEL}</span>
        </div>
        <div className="lj-scanner-body">
          <div className="lj-scanner-input-col">
            <div className="lj-scanner-input-wrap">
              <input
                type="text"
                className="lj-scanner-input"
                placeholder={SCANNER_PLACEHOLDER}
                value={keyword}
                onChange={(e) => {
                  setKeyword(e.target.value)
                  if (scanState === 'complete') {
                    setScanState('idle')
                    setResults(null)
                    setElapsedMs(0)
                  }
                }}
                onKeyDown={onKeyDown}
                disabled={scanState === 'running'}
                aria-label="Niche or keyword"
                autoComplete="off"
              />
              <button
                type="button"
                className={`lj-btn lj-btn--primary lj-scanner-run${
                  canScan ? ' lj-scanner-run--visible' : ''
                }`}
                onClick={runScan}
                disabled={!canScan || scanState === 'running'}
              >
                {scanState === 'running' ? 'Scanning…' : 'Run market scan'}
              </button>
            </div>
            <div className="lj-scanner-lines" aria-live="polite">
              {SCANNER_STAGED_LINES.map((line, i) => {
                const active = scanState === 'running' && i === linesVisible - 1
                const done =
                  scanState === 'complete' || (scanState === 'running' && i < linesVisible - 1)
                return (
                  <div
                    key={line}
                    className={`lj-scanner-line${
                      active ? ' lj-scanner-line--active' : done ? ' lj-scanner-line--done' : ''
                    }`}
                  >
                    {active ? '▸ ' : done ? '✓ ' : '  '}
                    {line}
                  </div>
                )
              })}
            </div>
            {scanState === 'running' ? (
              <div className="lj-scanner-progress" aria-hidden>
                <div
                  className="lj-scanner-progress-bar"
                  style={{ width: `${progress * 100}%` }}
                />
              </div>
            ) : null}
          </div>
          <div className="lj-scanner-results-col">
            {results ? (
              <>
                <div className="lj-scanner-metrics">
                  <div className="lj-metric">
                    <div className="lj-metric-label">Demand score</div>
                    <div className="lj-metric-value">{results.demandScore}</div>
                  </div>
                  <div className="lj-metric">
                    <div className="lj-metric-label">Saturation index</div>
                    <div className="lj-metric-value">{results.saturationIndex}</div>
                  </div>
                  <div className="lj-metric">
                    <div className="lj-metric-label">Seasonal trend</div>
                    <div className="lj-metric-value" style={{ fontSize: '0.85rem' }}>
                      {results.seasonalTrend}
                    </div>
                  </div>
                  <div className="lj-metric">
                    <div className="lj-metric-label">AI opportunity</div>
                    <div className="lj-metric-value">{results.aiOpportunityScore}</div>
                  </div>
                </div>
                <p className="lj-scanner-rec">{results.recommendation}</p>
                <a href="/demo" className="lj-btn lj-btn--primary lj-scanner-cta">
                  Start dispatching this niche
                </a>
              </>
            ) : (
              <p className="lj-scanner-results-empty">
                Enter a niche or keyword (3+ characters) and run a demo scan. Results are
                simulated for preview — not live market data.
              </p>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}

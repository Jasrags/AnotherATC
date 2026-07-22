import { describe, it, expect } from 'vitest'
import type { RunwayIncursion } from '@anotheratc/sim'
import { incursionBanner } from './alerts'

function inc(over: Partial<RunwayIncursion> = {}): RunwayIncursion {
  return {
    kind: 'occupiedVsLanding',
    severity: 'alert',
    occupantId: 'a',
    conflictId: 'b',
    message: 'SWA1 on the runway — DAL2 landing, 1.0 nm final',
    ...over,
  }
}

describe('incursionBanner', () => {
  it('is empty when nothing is wrong — the normal case must not paint a bar', () => {
    expect(incursionBanner([])).toBe('')
  })

  it('leads with the worst one, spelled out, because that is the one to act on', () => {
    expect(incursionBanner([inc()])).toBe('⛔ RUNWAY — SWA1 on the runway — DAL2 landing, 1.0 nm final')
  })

  it('marks an advisory differently from an alert', () => {
    // Same sentence in a different voice: the controller should be able to tell at a glance
    // whether this is developing or happening.
    expect(incursionBanner([inc({ severity: 'advisory', message: 'SWA1 on the runway' })])).toBe(
      '⚠ RUNWAY — SWA1 on the runway',
    )
  })

  it('counts the rest rather than stacking sentences nobody can read in time', () => {
    const banner = incursionBanner([inc(), inc({ occupantId: 'c' }), inc({ occupantId: 'd' })])
    expect(banner).toContain('SWA1 on the runway')
    expect(banner).toMatch(/\+2 more$/)
  })

  it('takes the list as given — the sim has already ordered it worst first', () => {
    // Defensive re-sorting here would let the two orderings drift apart silently.
    const banner = incursionBanner([inc({ severity: 'advisory', message: 'first' }), inc({ message: 'second' })])
    expect(banner).toBe('⚠ RUNWAY — first · +1 more')
  })
})

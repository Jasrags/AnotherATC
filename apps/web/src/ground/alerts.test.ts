import { describe, it, expect } from 'vitest'
import type { RunwayIncursion } from '@anotheratc/sim'
import { incursionAlert } from './alerts'

function inc(over: Partial<RunwayIncursion> = {}): RunwayIncursion {
  return {
    kind: 'occupiedVsLanding',
    severity: 'alert',
    occupantId: 'a',
    conflictId: 'b',
    message: 'SWA1 on the runway — DAL2 landing',
    finalNm: 1,
    ...over,
  }
}

describe('incursionAlert', () => {
  it('is empty when nothing is wrong — the normal case must not paint a bar', () => {
    expect(incursionAlert([])).toEqual({ text: '', announcement: '', severity: null, focusId: null })
  })

  it('leads with the worst one, spelled out, because that is the one to act on', () => {
    expect(incursionAlert([inc()]).text).toBe('⛔ RUNWAY — SWA1 on the runway — DAL2 landing, 1.0 nm final')
  })

  it('marks an advisory differently from an alert', () => {
    // Same sentence in a different voice: the controller should be able to tell at a glance
    // whether this is developing or happening.
    const a = incursionAlert([inc({ severity: 'advisory', finalNm: null, message: 'SWA1 on the runway' })])
    expect(a.text).toBe('⚠ RUNWAY — SWA1 on the runway')
    expect(a.severity).toBe('advisory')
  })

  it('keeps the closing range out of what is announced, so it is spoken once', () => {
    // role="alert" interrupts on every change. The range ticks continuously, so including it
    // would re-interrupt for the whole approach; the visible line still shows it.
    const near = incursionAlert([inc({ finalNm: 1.2 })])
    const nearer = incursionAlert([inc({ finalNm: 0.9 })])
    expect(near.text).not.toBe(nearer.text)
    expect(near.announcement).toBe(nearer.announcement)
    expect(near.announcement).not.toMatch(/nm/)
    expect(near.announcement).toBe('Runway alert. SWA1 on the runway — DAL2 landing')
  })

  it('does re-announce when the situation itself changes', () => {
    const before = incursionAlert([inc({ severity: 'advisory' })])
    const after = incursionAlert([inc({ severity: 'alert' })])
    expect(before.announcement).not.toBe(after.announcement)
  })

  it('counts the rest rather than stacking sentences nobody can read in time', () => {
    const a = incursionAlert([inc(), inc({ occupantId: 'c' }), inc({ occupantId: 'd' })])
    expect(a.text).toContain('SWA1 on the runway')
    expect(a.text).toMatch(/\+2 more$/)
    expect(a.announcement).toMatch(/\+2 more$/)
  })

  it('points at the intruder, which is the aircraft the menu levers apply to', () => {
    expect(incursionAlert([inc({ occupantId: 'swa1' })]).focusId).toBe('swa1')
  })

  it('takes the list as given — the sim has already ordered it worst first', () => {
    // Defensive re-sorting here would let the two orderings drift apart silently.
    const a = incursionAlert([inc({ severity: 'advisory', finalNm: null, message: 'first' }), inc({ message: 'second' })])
    expect(a.text).toBe('⚠ RUNWAY — first · +1 more')
  })
})

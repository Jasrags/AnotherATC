import { describe, it, expect } from 'vitest'
import type { RunwayIncursion } from '@anotheratc/sim'
import { AWAITING_ADVISORY_SEC, awaitingAlert, incursionAlert, type AwaitingItem } from './alerts'

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
    expect(incursionAlert([])).toEqual({ mark: '', text: '', announcement: '', severity: null, focusId: null })
  })

  it('leads with the worst one, spelled out, because that is the one to act on', () => {
    const a = incursionAlert([inc()])
    expect(a.text).toBe('RUNWAY — SWA1 on the runway — DAL2 landing, 1.0 nm final')
    // The glyph is separate so it can be rendered decoratively: it is a severity cue for the
    // eye, not a word, and prefixing every announcement with "no entry sign" helps nobody.
    expect(a.mark).toBe('⛔')
  })

  it('marks an advisory differently from an alert', () => {
    // Same sentence in a different voice: the controller should be able to tell at a glance
    // whether this is developing or happening.
    const a = incursionAlert([inc({ severity: 'advisory', finalNm: null, message: 'SWA1 on the runway' })])
    expect(a.text).toBe('RUNWAY — SWA1 on the runway')
    expect(a.mark).toBe('⚠')
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
    expect(a.text).toBe('RUNWAY — first · +1 more')
  })
})

describe('awaitingAlert', () => {
  const wait = (callsign: string, awaitingSec: number, intent: 'arrival' | 'departure' = 'arrival') =>
    ({ callsign, awaitingSec, intent }) as AwaitingItem

  it('is empty when nobody has been left waiting long enough to mention', () => {
    expect(awaitingAlert([])).toBe('')
    expect(awaitingAlert([wait('AAL1', AWAITING_ADVISORY_SEC - 1)])).toBe('')
  })

  it('names who is waiting and for how long, once it is worth saying', () => {
    expect(awaitingAlert([wait('AAL1', 45)])).toBe('⧗ AAL1 AWAITING TAXI 0:45')
  })

  it('leads with whoever has waited longest — that is the one to answer first', () => {
    const line = awaitingAlert([wait('AAL1', 40), wait('DAL2', 130), wait('SWA3', 65)])
    expect(line).toBe('⧗ DAL2 AWAITING TAXI 2:10 · SWA3 1:05 · AAL1 0:40')
  })

  it('counts the rest rather than listing a whole bay of them', () => {
    // Past a handful this is no longer a list of aircraft to act on, it is a statement about
    // how the session is going — and a HUD line that wraps is one nobody reads.
    const many = [140, 130, 120, 110, 100, 90].map((s, i) => wait(`AAL${i}`, s))
    expect(awaitingAlert(many)).toBe('⧗ AAL0 AWAITING TAXI 2:20 · AAL1 2:10 · AAL2 2:00 · +3 more')
  })
})

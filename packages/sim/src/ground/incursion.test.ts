import { describe, it, expect } from 'vitest'
import { detectIncursions, type IncursionView } from './incursion'

function view(id: string, over: Partial<IncursionView> = {}): IncursionView {
  return {
    id,
    callsign: id.toUpperCase(),
    use: null,
    airborne: false,
    clearedToLand: false,
    finalNm: 0,
    ...over,
  }
}

describe('runway incursion detection', () => {
  it('finds nothing when the runway is empty', () => {
    expect(detectIncursions([view('a'), view('b')])).toEqual([])
  })

  it('says nothing about a single aircraft using the runway as cleared', () => {
    expect(detectIncursions([view('a', { use: 'takeoff' })])).toEqual([])
    expect(detectIncursions([view('b', { use: 'crossing' })])).toEqual([])
  })

  it('flags an aircraft on the runway with no clearance at all', () => {
    const found = detectIncursions([view('ghost', { use: 'unauthorized' })])
    expect(found).toHaveLength(1)
    expect(found[0]!.kind).toBe('unauthorized')
    expect(found[0]!.severity).toBe('alert')
    expect(found[0]!.occupantId).toBe('ghost')
    expect(found[0]!.conflictId).toBeNull()
    expect(found[0]!.message).toContain('GHOST')
  })

  it('escalates a crossing from advisory to alert as the landing traffic closes in', () => {
    const crossing = view('x', { use: 'crossing' })
    const far = view('inb', { airborne: true, clearedToLand: true, finalNm: 2.5 })
    const near = view('inb', { airborne: true, clearedToLand: true, finalNm: 1.0 })

    const advisory = detectIncursions([crossing, far])
    expect(advisory).toHaveLength(1)
    expect(advisory[0]!.kind).toBe('occupiedVsLanding')
    expect(advisory[0]!.severity).toBe('advisory')
    expect(advisory[0]!.occupantId).toBe('x')
    expect(advisory[0]!.conflictId).toBe('inb')

    const alert = detectIncursions([crossing, near])
    expect(alert[0]!.severity).toBe('alert')
    expect(alert[0]!.message).toContain('1.0 nm final')
  })

  it('ignores an arrival that is still a long way out, or has no landing clearance', () => {
    const crossing = view('x', { use: 'crossing' })
    expect(detectIncursions([crossing, view('far', { airborne: true, clearedToLand: true, finalNm: 6 })])).toEqual([])
    // No landing clearance means it is going around, not landing on top of the crossing.
    expect(detectIncursions([crossing, view('nc', { airborne: true, clearedToLand: false, finalNm: 0.5 })])).toEqual([])
  })

  it('does not accuse the landing aircraft itself once it is rolling out', () => {
    // The arrival that just touched down is on the runway *and* still holds its landing
    // clearance — it must not be reported as conflicting with itself.
    expect(detectIncursions([view('a', { use: 'rollout', clearedToLand: true })])).toEqual([])
  })

  it('flags a crossing under an aircraft rolling for takeoff, once, naming the intruder first', () => {
    const found = detectIncursions([view('x', { use: 'crossing' }), view('dep', { use: 'takeoff' })])
    expect(found).toHaveLength(1)
    expect(found[0]!.kind).toBe('sharedRunway')
    expect(found[0]!.severity).toBe('alert')
    expect(found[0]!.occupantId).toBe('x') // the intruder, not the cleared departure
    expect(found[0]!.conflictId).toBe('dep')
  })

  it('falls back to an id tiebreak when both aircraft hold a runway clearance', () => {
    const found = detectIncursions([view('zulu', { use: 'lineUp' }), view('alfa', { use: 'takeoff' })])
    expect(found).toHaveLength(1)
    expect(found[0]!.occupantId).toBe('alfa')
    expect(found[0]!.conflictId).toBe('zulu')
  })

  it('orders alerts ahead of advisories, and is stable within a severity', () => {
    const found = detectIncursions([
      view('x', { use: 'crossing' }),
      view('inb', { airborne: true, clearedToLand: true, finalNm: 2.5 }),
      view('ghost', { use: 'unauthorized' }),
    ])
    // ghost is on the runway uncleared (alert) *and* under the same inbound (advisory);
    // x is only under the inbound.
    expect(found.map((i) => `${i.severity}:${i.occupantId}:${i.kind}`)).toEqual([
      'alert:ghost:unauthorized',
      'advisory:ghost:occupiedVsLanding',
      'advisory:x:occupiedVsLanding',
    ])
  })
})

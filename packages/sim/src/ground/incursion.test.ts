import { describe, it, expect } from 'vitest'
import { detectIncursions, type IncursionView } from './incursion'

function view(id: string, over: Partial<IncursionView> = {}): IncursionView {
  return {
    id,
    callsign: id.toUpperCase(),
    use: null,
    movingAway: false,
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
    // The range lives in its own field, never in the sentence: `message` has to stay stable
    // while the aircraft closes, or a consumer cannot tell a new situation from a new tenth
    // of a mile. Advisory and alert say exactly the same words; only the severity differs.
    expect(alert[0]!.message).toBe(advisory[0]!.message)
    expect(alert[0]!.message).not.toMatch(/nm/)
    expect(alert[0]!.finalNm).toBeCloseTo(1.0, 9)
    expect(advisory[0]!.finalNm).toBeCloseTo(2.5, 9)
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

  it('reports an uncleared occupant once, not again for each aircraft beside it', () => {
    // Two aircraft on the pavement, neither holding a clearance for the runway itself. The
    // ghost already raises its own alert naming itself — the aircraft to move — so pairing it
    // with the crossing would repeat that in different words and cost a line of a HUD that
    // shows one sentence and a count.
    const found = detectIncursions([view('ghost', { use: 'unauthorized' }), view('x', { use: 'crossing' })])
    expect(found).toHaveLength(1)
    expect(found[0]!.kind).toBe('unauthorized')
    expect(found[0]!.occupantId).toBe('ghost')
  })

  it('still reports each uncleared occupant when there are several', () => {
    const found = detectIncursions([view('g1', { use: 'unauthorized' }), view('g2', { use: 'unauthorized' })])
    expect(found.map((i) => i.occupantId)).toEqual(['g1', 'g2'])
    expect(found.every((i) => i.kind === 'unauthorized')).toBe(true)
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

/**
 * Anticipated separation is not an incursion.
 *
 * "A departure actually rolling down the runway does not block a line-up behind it — that is
 * precisely what line up and wait is for." The sim says so and permits the clearance; this used
 * to fire an alert on the result, so the game issued a legal instruction and then shouted about
 * it. Two predicates disagreeing about the same instant.
 */
describe('a departure rolling with one lined up behind it', () => {
  const rolling = (over: Partial<IncursionView> = {}): IncursionView => ({
    id: 'a', callsign: 'DEV01', use: 'takeoff', movingAway: true,
    airborne: false, clearedToLand: false, finalNm: 0, ...over,
  })
  const inPosition = (over: Partial<IncursionView> = {}): IncursionView => ({
    id: 'b', callsign: 'DEV02', use: 'lineUp', movingAway: false,
    airborne: false, clearedToLand: false, finalNm: 0, ...over,
  })

  it('is not an incursion — it is the instruction working', () => {
    expect(detectIncursions([rolling(), inPosition()])).toEqual([])
  })

  it('is still an incursion when the one ahead has not started rolling', () => {
    // Cleared for takeoff but stationary — the aircraft behind is taxiing onto an occupied
    // spot, which is the thing that must never be quiet.
    const found = detectIncursions([rolling({ movingAway: false }), inPosition()])
    expect(found).toHaveLength(1)
    expect(found[0]!.severity).toBe('alert')
  })

  it('lets a landing roll out with a departure lining up behind it', () => {
    // The situation LUAW exists for (docs/atc-operations.md §6).
    expect(detectIncursions([rolling({ use: 'rollout' }), inPosition()])).toEqual([])
  })

  it('still flags a crossing under a rolling departure — that one is in the way, not behind', () => {
    const found = detectIncursions([rolling(), inPosition({ use: 'crossing' })])
    expect(found).toHaveLength(1)
    expect(found[0]!.severity).toBe('alert')
  })

  it('still flags an arrival landing on top of the pair', () => {
    const found = detectIncursions([
      rolling(),
      inPosition(),
      { id: 'c', callsign: 'ARR1', use: null, movingAway: false, airborne: true, clearedToLand: true, finalNm: 1 },
    ])
    expect(found.length).toBeGreaterThan(0)
    expect(found.every((f) => f.kind === 'occupiedVsLanding')).toBe(true)
  })
})

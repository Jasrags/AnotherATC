import { describe, it, expect } from 'vitest'
import { detectConverging, CONFLICT_NM, CONVERGE_HORIZON_SEC, type ConflictView } from './converging'
import type { Point } from '../world/types'

/** An aircraft at `at`, running `path` from there at `speedKt`. */
function view(id: string, at: Point, path: Point[], speedKt: number, over: Partial<ConflictView> = {}): ConflictView {
  return {
    id,
    callsign: id.toUpperCase(),
    at,
    path: [at, ...path],
    headingDeg: 0,
    speedKt,
    hotspot: null,
    yieldingTo: [],
    ...over,
  }
}

/** Heading (deg true) from a to b, for fixtures that need it to match their path. */
function heading(a: Point, b: Point): number {
  return (Math.atan2(b[0] - a[0], b[1] - a[1]) * 180) / Math.PI
}

/**
 * Two aircraft approaching one junction at [0,0] from the south and the west, `gapNm` out.
 *
 * The gap is a *time*: at 15 kt an aircraft covers 0.083 nm in the 20 s horizon, so 0.06 nm is
 * about 14 s away (inside it) and 0.12 nm about 29 s (outside it, but inside a hot spot's
 * doubled horizon). The fixtures below pick gaps deliberately on one side or the other.
 */
function crossingPair(gapNm: number, speedKt = 15) {
  const aFrom: Point = [0, -gapNm]
  const bFrom: Point = [-gapNm, 0]
  return [
    view('a', aFrom, [[0, 0], [0, gapNm]], speedKt, { headingDeg: heading(aFrom, [0, 0]) }),
    view('b', bFrom, [[0, 0], [gapNm, 0]], speedKt, { headingDeg: heading(bFrom, [0, 0]) }),
  ]
}

describe('converging traffic', () => {
  it('finds nothing in an empty or single-aircraft fleet', () => {
    expect(detectConverging([])).toEqual([])
    expect(detectConverging([view('a', [0, 0], [[0, 1]], 15)])).toEqual([])
  })

  it('sees two aircraft converging on a junction before they are anywhere near it', () => {
    // 365 ft apart — two dozen times the nose-to-nose distance — and closing on one junction.
    // Pure proximity says nothing whatever here, which is the whole reason this exists.
    const found = detectConverging(crossingPair(0.06))
    expect(found).toHaveLength(1)
    expect(found[0]!.aircraftIds).toEqual(['a', 'b'])
    expect(found[0]!.severity).toBe('advisory')
    expect(found[0]!.secondsToConflict).toBeGreaterThan(0)
    expect(found[0]!.secondsToConflict).toBeLessThanOrEqual(CONVERGE_HORIZON_SEC)
    // The message carries no number: it is what a consumer announces, and a countdown that
    // re-announces every second is a countdown nobody listens to.
    expect(found[0]!.message).toBe('A and B converging')
    expect(found[0]!.message).not.toMatch(/\d/)
  })

  it('calls it an alert once they are actually nose to nose', () => {
    const [a, b] = crossingPair(0.06)
    const found = detectConverging([
      { ...a!, at: [0, 0], path: [[0, 0], [0, 0.1]] },
      { ...b!, at: [CONFLICT_NM / 2, 0], path: [[CONFLICT_NM / 2, 0], [0.1, 0]] },
    ])
    expect(found[0]!.severity).toBe('alert')
    expect(found[0]!.secondsToConflict).toBe(0)
  })

  it('says nothing about two aircraft whose paths never meet', () => {
    // Parallel taxiways, both running north, well apart. They converge on nothing.
    const a = view('a', [0, 0], [[0, 1]], 15)
    const b = view('b', [0.5, 0], [[0.5, 1]], 15)
    expect(detectConverging([a, b])).toEqual([])
  })

  it('says nothing when the traffic ahead is simply traffic ahead', () => {
    // A queue on one taxiway: same direction, one behind the other. Following separation owns
    // this, and reporting it would mean reporting every taxi queue on the field.
    const a = view('a', [0, 0], [[0, 1]], 15)
    const b = view('b', [0, 0.05], [[0, 1]], 5)
    expect(detectConverging([a, b])).toEqual([])
  })

  it('still reports a following pair that has actually closed to nose-to-nose', () => {
    // The exclusion above is about *predicting*: if they are already on top of each other, the
    // separation floor has failed and that is exactly when it must be said.
    const a = view('a', [0, 0], [[0, 1]], 5)
    const b = view('b', [0, CONFLICT_NM / 2], [[0, 1]], 5)
    const found = detectConverging([a, b])
    expect(found).toHaveLength(1)
    expect(found[0]!.severity).toBe('alert')
  })

  it('says nothing about a conflict further out than the horizon', () => {
    // Two miles apart at taxi speed is four minutes away — a warning that far ahead is noise,
    // and everything about the situation will have changed by then.
    expect(detectConverging(crossingPair(2))).toEqual([])
  })

  it('does not warn about a pair the automatic hold has already resolved', () => {
    // One of them is being held short of the contested edge by the junction reservation. The
    // sim is already stopping it; saying so as well would fire at every junction meeting on
    // the field and train the controller to ignore the one that matters.
    const [a, b] = crossingPair(0.06) // close enough that it *would* be reported otherwise
    expect(detectConverging([a!, b!])).toHaveLength(1)
    expect(detectConverging([{ ...a!, yieldingTo: [b!.id] }, b!])).toEqual([])
  })

  it('warns earlier inside a charted hot spot', () => {
    // The same thing a hot spot already does to the proximity call: the field's own diagram
    // says watch harder here, and watching harder is all the sim can do with that.
    // 0.12 nm is ~29 s out: past the plain horizon, inside the hot spot's.
    const plain = detectConverging(crossingPair(0.12))
    const hot = detectConverging(crossingPair(0.12).map((v) => ({ ...v, hotspot: 'HS1' })))
    expect(plain).toEqual([])
    expect(hot).toHaveLength(1)
    expect(hot[0]!.hotspot).toBe('HS1')
    expect(hot[0]!.message).toBe('A and B converging at HS1')
  })

  it('sorts what is happening now ahead of what is developing, then by how soon', () => {
    const near = crossingPair(0.04).map((v) => ({ ...v, id: `n${v.id}`, callsign: `N${v.id}` }))
    const far = crossingPair(0.07).map((v) => ({ ...v, id: `f${v.id}`, callsign: `F${v.id}` }))
    const now = [
      view('x', [1, 1], [[1, 1.1]], 0),
      view('y', [1 + CONFLICT_NM / 2, 1], [[1, 1.1]], 0),
    ]
    const found = detectConverging([...far, ...near, ...now])
    expect(found[0]!.severity).toBe('alert')
    expect(found.map((f) => f.aircraftIds[0])).toEqual(['x', 'na', 'fa'])
  })

  it('is deterministic and order-independent — the same fleet in any order gives one answer', () => {
    const pair = crossingPair(0.06)
    const forward = detectConverging(pair)
    const reversed = detectConverging([...pair].reverse())
    expect(reversed).toEqual(forward)
    expect(forward[0]!.aircraftIds).toEqual(['a', 'b']) // named in a stable order, not fleet order
  })

  it('leaves a stopped aircraft directly ahead to the separation floor', () => {
    // Someone parked in a turnoff on your own track is a delay, not a conflict: the aircraft
    // behind will stop behind it, which is what following separation is for. The clock on the
    // parked one is what says it should not be there — see `awaitingSec`.
    const stopped = view('s', [0, 0], [[0, 1]], 0, { headingDeg: 0 })
    const behind = view('m', [0, -0.1], [[0, 1]], 15, { headingDeg: 0 })
    expect(detectConverging([stopped, behind])).toEqual([])
  })

  it('does warn about a stopped aircraft lying across the track, not along it', () => {
    // Stopped in a turnoff that meets the alley at an angle: nobody is queueing behind anybody,
    // one aircraft is simply taxiing into a place another is sitting.
    const stopped = view('s', [0, 0], [[0, 0]], 0, { headingDeg: 90 })
    const coming = view('m', [0, -0.06], [[0, 0.06]], 15, { headingDeg: 0 })
    const found = detectConverging([stopped, coming])
    expect(found).toHaveLength(1)
    expect(found[0]!.secondsToConflict).toBeGreaterThan(0)
  })
})

describe('the charted hot spot widens the call as well as lengthening it', () => {
  it('calls a pair in conflict at a distance that would be nothing anywhere else', () => {
    // The behaviour the plain proximity call has always had inside a hot spot (×3), kept here
    // so the two cannot drift: prediction and proximity are one event seen at two times.
    const apart = CONFLICT_NM * 2 // outside the plain limit, inside the hot spot's
    const a = view('a', [0, 0], [[0, 0]], 0)
    const b = view('b', [apart, 0], [[apart, 0]], 0)
    expect(detectConverging([a, b])).toEqual([])
    const hot = detectConverging([a, b].map((v) => ({ ...v, hotspot: 'HS1' })))
    expect(hot).toHaveLength(1)
    expect(hot[0]!.severity).toBe('alert')
  })
})

describe('the fast cases, where a fixed sample step would look straight past the conflict', () => {
  it('finds a rollout-speed crossing whose closest approach falls between whole seconds', () => {
    // 140 kt is 236 ft per second — sixteen times the conflict distance — so a one-second
    // sample can step clean over the moment the two are on top of each other. The start
    // position here is chosen so that it does exactly that: the samples land 118 ft either
    // side of the meeting point. A landing rollout is in this list precisely because what it
    // can run into is an aircraft sitting in its turnoff, so the fast case is the real case.
    const rolling = view('r', [0, -0.525], [[0, 0.5]], 140, { headingDeg: 0 })
    const sitting = view('s', [0, 0], [[0, 0]], 0, { headingDeg: 90 })
    const found = detectConverging([rolling, sitting])
    expect(found).toHaveLength(1)
    expect(found[0]!.severity).toBe('advisory')
    expect(found[0]!.secondsToConflict).toBeGreaterThan(12)
    expect(found[0]!.secondsToConflict).toBeLessThan(14)
  })
})

describe('a hold is a hold for the traffic it is for, not for everyone', () => {
  it('still warns about a held aircraft converging with somebody else', () => {
    // A is stopped short for C. That says nothing whatever about D, which A is also closing on
    // — and dropping the pair because A happens to be holding for someone would lose a real
    // developing conflict behind an unrelated resolution.
    const [a, b] = crossingPair(0.06)
    const held = { ...a!, yieldingTo: ['c'] }
    expect(detectConverging([held, b!])).toHaveLength(1)
  })

  it('stays quiet about the pair the hold is actually for', () => {
    const [a, b] = crossingPair(0.06)
    expect(detectConverging([{ ...a!, yieldingTo: [b!.id] }, b!])).toEqual([])
    // …and it does not matter which of the two is the one being held.
    expect(detectConverging([a!, { ...b!, yieldingTo: [a!.id] }])).toEqual([])
  })
})

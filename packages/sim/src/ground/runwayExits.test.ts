import { describe, it, expect } from 'vitest'
import {
  brakeRateFor,
  buildRunwayExits,
  chooseExit,
  MAX_BRAKE_KT_S,
  rolloutSeconds,
  type RunwayExit,
} from './runwayExits'
import { buildTaxiGraph } from './taxiGraph'
import { buildRunwayGuard } from './runwayGuard'
import { KSAN_SURFACE } from '../world/ksan'
import type { AirportSurface, Point } from '../world/types'

// Runway along y=0 (x 0→2). One acute turnoff ("R1") peeling forward-right at ~30°, one
// right-angle turnoff ("S1"), and one acute turnoff pointing *backwards* ("B1") — which is a
// rapid exit for the opposite landing direction and must not be offered to this one.
const surface: AirportSurface = {
  icao: 'TEST',
  name: 'Test',
  ref: { lat: 0, lon: 0, elevationFt: 0 },
  units: 'nm',
  source: 'synthetic',
  bounds: { minX: 0, minY: -0.4, maxX: 2, maxY: 0 },
  features: [
    { kind: 'runway', points: [[0, 0], [2, 0]] },
    { kind: 'taxiway', ref: 'R1', points: [[0.6, 0], [0.95, -0.2], [1.2, -0.3]] },
    { kind: 'taxiway', ref: 'S1', points: [[1.2, 0], [1.2, -0.3]] },
    { kind: 'taxiway', ref: 'B1', points: [[1.6, 0], [1.25, -0.2]] },
    { kind: 'taxiway', points: [[1.2, -0.3], [0.4, -0.3]] },
  ],
}
const guard = buildRunwayGuard(surface)
const topo = buildTaxiGraph(surface).topology()
const THRESHOLD: Point = [0, 0]
const FAR: Point = [2, 0]

describe('buildRunwayExits', () => {
  const exits = buildRunwayExits(topo, guard, THRESHOLD, FAR)
  const byRef = (r: string) => exits.find((e) => e.ref === r)

  it('classifies an acute turnoff as a rapid exit and a right-angle one as standard', () => {
    expect(byRef('R1')?.kind).toBe('rapid')
    expect(byRef('R1')!.angleDeg).toBeLessThan(60)
    expect(byRef('S1')?.kind).toBe('standard')
    expect(byRef('S1')!.angleDeg).toBeCloseTo(90, 0)
    expect(byRef('R1')!.speedKt).toBeGreaterThan(byRef('S1')!.speedKt)
  })

  it('excludes a turnoff that points back down the runway (it belongs to the other direction)', () => {
    expect(byRef('B1')).toBeUndefined()
    // …and landing the other way, that same taxiway *is* the rapid exit.
    const other = buildRunwayExits(topo, guard, FAR, THRESHOLD)
    expect(other.find((e) => e.ref === 'B1')?.kind).toBe('rapid')
    expect(other.find((e) => e.ref === 'R1')).toBeUndefined()
  })

  it('measures distance from the landing threshold and orders exits along the runway', () => {
    expect(byRef('R1')!.distanceNm).toBeCloseTo(0.6, 2)
    expect(byRef('S1')!.distanceNm).toBeCloseTo(1.2, 2)
    expect(exits.map((e) => e.ref)).toEqual(['R1', 'S1'])
  })

  it('records which way the aircraft turns and where it is clear of the runway', () => {
    expect(byRef('R1')!.turn).toBe('right') // turnoffs are south of a west→east landing
    expect(byRef('R1')!.vacatePoint[1]).toBeLessThan(0) // off the centerline
  })
})

describe('braking to a turnoff', () => {
  it('brakeRateFor matches the textbook stopping distance', () => {
    // 140 → 40 kt at 5 kt/s needs (140² − 40²) / (7200 × 5) nm.
    expect(brakeRateFor(140, 40, 0.5)).toBeCloseTo(5, 6)
    expect(brakeRateFor(140, 40, 1)).toBeCloseTo(2.5, 6)
  })

  it('an exit too close to slow down for is not offered', () => {
    const exits = buildRunwayExits(topo, guard, THRESHOLD, FAR)
    // From the threshold at 140 kt, R1 at 0.6 nm needs (140²−40²)/(7200×0.6) = 4.17 kt/s.
    expect(brakeRateFor(140, 40, 0.6)).toBeLessThan(MAX_BRAKE_KT_S)
    expect(chooseExit(exits, 140, 0)?.ref).toBe('R1')
    // Touching down long — now R1 is unreachable and S1 is the only option left.
    expect(chooseExit(exits, 140, 0.35)?.ref).toBe('S1')
    // Nothing left at all once past every turnoff.
    expect(chooseExit(exits, 140, 1.9)).toBeNull()
  })

  it('at the same distance, the turnoff that can be taken faster frees the runway sooner', () => {
    // The core claim of the whole model, isolated from distance: same place, different geometry.
    const at = 0.9
    const rapid: RunwayExit = {
      ref: 'R', point: [at, 0], geom: [[at, 0], [at + 0.05, -0.06]], vacatePoint: [at + 0.05, -0.06],
      angleDeg: 30, kind: 'rapid', turn: 'right', distanceNm: at, lengthNm: 0.078, speedKt: 38,
    }
    const standard: RunwayExit = { ...rapid, ref: 'S', angleDeg: 90, kind: 'standard', speedKt: 15 }
    const sec = (e: RunwayExit) =>
      rolloutSeconds(140, e, Math.max(brakeRateFor(140, e.speedKt, e.distanceNm), 1.5))
    expect(sec(rapid)).toBeLessThan(sec(standard))
  })

  it('prefers the rapid exit over a later right-angle one because it frees the runway sooner', () => {
    const exits = buildRunwayExits(topo, guard, THRESHOLD, FAR)
    const rapid = exits.find((e) => e.ref === 'R1')!
    const standard = exits.find((e) => e.ref === 'S1')!
    const secFor = (e: RunwayExit) =>
      rolloutSeconds(140, e, Math.max(brakeRateFor(140, e.speedKt, e.distanceNm), 1.5))
    expect(secFor(rapid)).toBeLessThan(secFor(standard))
    expect(chooseExit(exits, 140, 0)?.ref).toBe('R1')
  })
})

describe('KSAN exits (real ingested surface)', () => {
  const ksanGuard = buildRunwayGuard(KSAN_SURFACE)
  const ksanTopo = buildTaxiGraph(KSAN_SURFACE).topology()
  // RWY 9: land west → east.
  const west: Point = [-0.7405, 0.2115]
  const east: Point = [0.7431, -0.2161]
  const exits = buildRunwayExits(ksanTopo, ksanGuard, west, east)

  it('finds named turnoffs on both sides of the runway', () => {
    expect(exits.length).toBeGreaterThanOrEqual(8)
    expect(exits.every((e) => /^[A-Z]\d+$/.test(e.ref))).toBe(true)
    expect(exits.some((e) => e.turn === 'left')).toBe(true)
    expect(exits.some((e) => e.turn === 'right')).toBe(true)
  })

  it('identifies several rapid exits, none of them right at the landing threshold', () => {
    const rapid = exits.filter((e) => e.kind === 'rapid')
    expect(rapid.length).toBeGreaterThanOrEqual(3)
    // Nothing can slow from approach speed inside the first few thousand feet, so a "rapid
    // exit" that close to the threshold would mean the geometry classifier is wrong.
    for (const e of rapid) expect(e.distanceNm).toBeGreaterThan(0.2)
  })

  it('a 737 landing on 9 plans an early rapid exit, and the same one every time', () => {
    const chosen = chooseExit(exits, 140, 0)
    expect(chosen).not.toBeNull()
    expect(chosen!.kind).toBe('rapid') // among near-tied options, the one taken fastest
    expect(chosen!.distanceNm).toBeLessThan(0.85) // roughly the first half of a ~1.54 nm runway
    expect(chooseExit(exits, 140, 0)?.ref).toBe(chosen!.ref) // deterministic
  })

  it('does not send a jet to a much slower turnoff to save a second', () => {
    const chosen = chooseExit(exits, 140, 0)!
    const nearlyTied = exits.filter(
      (e) => Math.abs(e.distanceNm - chosen.distanceNm) < 0.15 && e.ref !== chosen.ref,
    )
    expect(nearlyTied.length).toBeGreaterThan(0)
    for (const e of nearlyTied) expect(chosen.speedKt).toBeGreaterThanOrEqual(e.speedKt)
  })

  it('every turnoff actually takes the aircraft clear of the runway', () => {
    // A contracted edge that ends at a fillet node a hundred feet off the centerline is not an
    // exit; counting it as one would release the runway while the aircraft is still on it.
    const ux = (east[0] - west[0]) / Math.hypot(east[0] - west[0], east[1] - west[1])
    const uy = (east[1] - west[1]) / Math.hypot(east[0] - west[0], east[1] - west[1])
    for (const e of exits) {
      const off = Math.abs(ux * (e.vacatePoint[1] - west[1]) - uy * (e.vacatePoint[0] - west[0]))
      expect(off).toBeGreaterThan(0.0399) // 0.04 nm, modulo float settling
    }
  })

  it('runway occupancy is what the turnoff choice actually trades', () => {
    const chosen = chooseExit(exits, 140, 0)!
    const last = exits[exits.length - 1]!
    const sec = (e: (typeof exits)[number]) =>
      rolloutSeconds(140, e, Math.max(brakeRateFor(140, e.speedKt, e.distanceNm), 1.5))
    // Being sent to the far end costs real occupancy time versus the planned rapid exit —
    // this difference is the whole point of modelling exits.
    expect(sec(last) - sec(chosen)).toBeGreaterThan(15)
  })

  it('landing the other way (RWY 27) re-derives the set from that direction', () => {
    const other = buildRunwayExits(ksanTopo, ksanGuard, east, west)
    expect(other.length).toBeGreaterThanOrEqual(8)
    // Distances are measured from the new threshold, so the order along the runway reverses.
    expect(other.map((e) => e.ref)).not.toEqual(exits.map((e) => e.ref))
    // A connector's angle — and therefore how fast it can be taken — depends on which way you
    // are landing: the same pavement is a shallow high-speed one way and a sharp turn the other.
    const bothWays = exits.filter((a) => other.some((b) => b.ref === a.ref))
    expect(bothWays.length).toBeGreaterThan(0)
    const flipped = bothWays.filter(
      (a) => Math.abs(a.angleDeg - other.find((b) => b.ref === a.ref)!.angleDeg) > 20,
    )
    expect(flipped.length).toBeGreaterThan(0)
    expect(chooseExit(other, 140, 0)).not.toBeNull()
  })
})

import { describe, it, expect } from 'vitest'
import { createGroundSim } from '../ground/sim'
import { buildTaxiGraph } from '../ground/taxiGraph'
import { buildRunwayGuard, runwayIdAt } from '../ground/runwayGuard'
import type { ActiveRunway } from '../ground/runway'
import type { AirportSurface } from './types'

/**
 * The multi-runway foundation, proven on a fictional *intersecting* field — invented here and
 * nowhere else. Design: docs/atc-multi-runway.md.
 *
 * lessons-from-ksan.md #17: a suite that only exercises the one real airport proves the real
 * airport still works, not that the code is general. This field crosses two runways so that
 * "which runway is this aircraft on" is a question with a wrong answer — which the single-runway
 * model, where occupancy is field-wide, gets wrong.
 *
 * Two runways crossing at (0.3, 0): 09/27 runs east–west along y=0; 18/36 runs north–south along
 * x=0.3. KSAN stays a single-runway field and must not move — world/airport.test.ts is the
 * no-regression anchor.
 *
 * Scope: this slice covers §1 (runwayIdAt) and §3 (per-runway occupancy). Wake separation is now
 * per-runway too (§4, `lastDepartureByRunway`), but a *cross-runway* wake assertion needs two
 * runways active at once to drive a takeoff on each — that arrives with config-as-a-set (§5), and
 * the end-to-end wake-independence + multi-runway-crossing scenarios are asserted there. Here the
 * full single-runway suite is the regression guard that neither change moved KSAN.
 */
const surface: AirportSurface = {
  icao: 'KXRW',
  name: 'Crossfield',
  ref: { lat: 34, lon: -118, elevationFt: 700 },
  units: 'nm',
  source: 'synthetic',
  bounds: { minX: -1.2, minY: -1.2, maxX: 1.2, maxY: 1.2 },
  features: [
    { kind: 'runway', ref: '09/27', points: [[-1, 0], [1, 0]] },
    { kind: 'runway', ref: '18/36', points: [[0.3, -1], [0.3, 1]] },
    // A taxiway so the graph isn't empty; irrelevant to the occupancy question below.
    { kind: 'taxiway', ref: 'T', points: [[-1, 0.4], [1, 0.4]] },
    { kind: 'gate', ref: '1', points: [[-0.8, 0.6]] },
  ],
}

const graph = buildTaxiGraph(surface)
const guard = buildRunwayGuard(surface)

/** 36 rolls north up the north–south runway; this is the active configuration in the scenarios. */
const RWY_36: ActiveRunway = {
  ident: '36',
  threshold: [0.3, -0.75], // displaced a touch from the south pavement end
  departureStart: [0.3, -1],
  farEnd: [0.3, 1],
  toraFt: 9000,
  ldaFt: 7500,
  glidePathDeg: 3,
  pattern: 'left',
}

describe('runwayIdAt: a point knows which runway it is on (docs/atc-multi-runway.md §1)', () => {
  it('names the runway a point lies on, and distinguishes the two', () => {
    // West half of the east–west runway, clear of the crossing.
    expect(runwayIdAt([-0.5, 0], guard)).toBe('09/27')
    // North half of the north–south runway, clear of the crossing.
    expect(runwayIdAt([0.3, 0.5], guard)).toBe('18/36')
    expect(runwayIdAt([-0.5, 0], guard)).not.toBe(runwayIdAt([0.3, 0.5], guard))
  })

  it('returns null off all pavement', () => {
    expect(runwayIdAt([0.9, 0.9], guard)).toBeNull()
  })
})

describe('occupancy is per-runway (docs/atc-multi-runway.md §3)', () => {
  it('a departure sitting on runway 09/27 does not block a line-up on runway 18/36', () => {
    const sim = createGroundSim(
      [
        // A departure stationary ON the east–west runway (09/27), well clear of the crossing.
        // It is on *a* runway, but not the one 36 traffic is using.
        {
          id: 'blocker',
          callsign: 'XRW900',
          type: 'B738',
          wake: 'M',
          path: [[-0.5, 0]],
          targetSpeed: 0,
          intent: 'departure',
          goalPoint: [1, 0],
        },
        // A departure holding short of runway 36's south end, on Tower's runway.
        {
          id: 'b',
          callsign: 'XRW200',
          type: 'B738',
          wake: 'M',
          path: [[0.5, -1], [0.3, -1], [0.1, -1]],
          targetSpeed: 15,
          intent: 'departure',
          goalPoint: [0.3, -1],
        },
      ],
      { graph, guard, runway: RWY_36 },
    )

    expect(sim.snapshot().aircraft.find((a) => a.id === 'b')!.holdingForTakeoff).toBe(true)
    expect(sim.dispatch({ type: 'contactTower', aircraftId: 'b' })).toEqual({ ok: true })

    // The blocker is on 09/27, not 18/36, so it has no bearing on lining up on 36. Today this is
    // refused because occupancy is field-wide (onRunwayNow sees any runway) — that is the bug.
    expect(sim.dispatch({ type: 'lineUpAndWait', aircraftId: 'b' })).toEqual({ ok: true })
  })
})

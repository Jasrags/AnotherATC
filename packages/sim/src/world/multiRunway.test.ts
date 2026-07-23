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
 * Scope: §1 (runwayIdAt), §3 (per-runway occupancy), §4 (per-runway wake) and §5 (config as a set
 * of active runways) are all covered here — including the two runways-active-at-once scenarios that
 * §4/§5 unlock (dual-runway takeoff, cross-runway wake independence). Still deferred to the
 * dependency-seam slice (§6): a crossing clearance for a route that crosses *two* runways, and the
 * inter-runway rules KBUR/KOAK plug in. The full single-runway suite remains the regression guard
 * that none of this moved KSAN.
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

/** 27 rolls west along the east–west runway — the second active direction in the two-runway
 *  scenarios. Its physical runway (09/27) is a different one from 36's (18/36). */
const RWY_27: ActiveRunway = {
  ident: '27',
  threshold: [0.8, 0], // displaced from the east pavement end
  departureStart: [1, 0],
  farEnd: [-1, 0],
  toraFt: 12000,
  ldaFt: 10000,
  glidePathDeg: 3,
  pattern: 'right',
}

/** A departure holding short of a runway end, off the pavement. */
const departureHoldingShort = (
  id: string,
  callsign: string,
  wake: 'L' | 'M' | 'H' | 'J',
  approach: [number, number],
  end: [number, number],
  past: [number, number],
) => ({
  id,
  callsign,
  type: 'B738',
  wake,
  path: [approach, end, past],
  targetSpeed: 15,
  intent: 'departure' as const,
  goalPoint: end,
})

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

describe('the dependency seam carries a rule (docs/atc-multi-runway.md §6)', () => {
  it('a field that couples two runways for occupancy blocks a line-up under an occupant', () => {
    // Same geometry as the per-runway independence test above, but this field declares that its
    // two runways interact for occupancy — the crossing case a real intersecting field states. Now
    // the occupant on 09/27 *does* bear on a line-up on 18/36: the seam is the only difference.
    const sim = createGroundSim(
      [
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
        departureHoldingShort('b', 'XRW200', 'M', [0.5, -1], [0.3, -1], [0.1, -1]),
      ],
      {
        graph,
        guard,
        runway: RWY_36,
        runwaysInteract: (_mine, _other, kind) => kind === 'occupancy',
      },
    )
    expect(sim.dispatch({ type: 'contactTower', aircraftId: 'b' })).toEqual({ ok: true })
    const res = sim.dispatch({ type: 'lineUpAndWait', aircraftId: 'b' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toMatch(/occupied/i)
  })
})

describe('two runways active at once (docs/atc-multi-runway.md §5)', () => {
  // Both directions active. A departure on each — 36 rolls north, 27 rolls west. With a single
  // active `runway` the sim refused a takeoff on whichever direction wasn't configured; the active
  // *set* lets each roll on its own runway.
  const twoRunwaySim = () =>
    createGroundSim(
      [
        departureHoldingShort('n', 'XRW360', 'H', [0.5, -1], [0.3, -1], [0.1, -1]), // holds short of 36
        departureHoldingShort('w', 'XRW270', 'L', [1, 0.2], [1, 0], [1, -0.2]), // holds short of 27
      ],
      { graph, guard, runways: [RWY_27, RWY_36] },
    )

  it('reports both active runways', () => {
    expect(
      twoRunwaySim()
        .runways()
        .map((r) => r.ident),
    ).toEqual(['27', '36'])
  })

  it('clears a departure on each runway and both get airborne', () => {
    const sim = twoRunwaySim()
    expect(sim.snapshot().aircraft.find((a) => a.id === 'n')!.holdingForTakeoff).toBe(true)
    expect(sim.snapshot().aircraft.find((a) => a.id === 'w')!.holdingForTakeoff).toBe(true)

    // Launch 36 first, let it clear the field, then 27 — sequenced so the two rolls don't meet at
    // the crossing (that conflict is the seam's job, §6, not this test's).
    // Budgets are generous: a departure holding 0.2 nm off the end lines up on a slow fillet
    // before it rolls, so the whole sequence is ~100 s per aircraft.
    expect(sim.dispatch({ type: 'contactTower', aircraftId: 'n' })).toEqual({ ok: true })
    expect(sim.dispatch({ type: 'clearedForTakeoff', aircraftId: 'n' })).toEqual({ ok: true })
    for (let i = 0; i < 2000 && sim.snapshot().departed < 1; i += 1) sim.step(0.1)
    expect(sim.snapshot().departed).toBe(1)

    expect(sim.dispatch({ type: 'contactTower', aircraftId: 'w' })).toEqual({ ok: true })
    expect(sim.dispatch({ type: 'clearedForTakeoff', aircraftId: 'w' })).toEqual({ ok: true })
    for (let i = 0; i < 2000 && sim.snapshot().departed < 2; i += 1) sim.step(0.1)
    expect(sim.snapshot().departed).toBe(2)
  })

  it('bringing a second runway online leaves the first runway’s traffic alone', () => {
    // Start with only 36 active; an arrival is cleared to land on it. Activating 27 (a *different*
    // physical runway) must not sweep the 36 arrival into a go-around — the change is scoped to the
    // runway coming online, not the whole field.
    const finalFix36: [number, number] = [0.3, -4.75] // 4 nm south of 36's threshold
    const sim = createGroundSim(
      [
        {
          id: 'a',
          callsign: 'XRW111',
          type: 'B738',
          wake: 'M',
          path: [finalFix36, RWY_36.threshold],
          targetSpeed: 140,
          airborne: true,
          intent: 'arrival',
          goalPoint: [-0.8, 0.6],
          gate: '1',
        },
      ],
      { graph, guard, runways: [RWY_36] },
    )
    expect(sim.dispatch({ type: 'clearedToLand', aircraftId: 'a' })).toEqual({ ok: true })

    expect(sim.setRunway(RWY_27)).toEqual({ ok: true })
    expect(sim.runways().map((r) => r.ident)).toEqual(['36', '27'])
    // Untouched: still landing on 36 — a go-around would void the clearance and drop it back to
    // 'onFinal', so 'landing' is proof it was not swept into 27's activation.
    expect(sim.snapshot().aircraft.find((x) => x.id === 'a')!.status).toBe('landing')
  })

  it('wake on one runway does not gate a departure on the other (§4)', () => {
    const sim = twoRunwaySim()
    // A Heavy rolls on 36 — its wake leader is recorded against runway 18/36.
    sim.dispatch({ type: 'contactTower', aircraftId: 'n' })
    expect(sim.dispatch({ type: 'clearedForTakeoff', aircraftId: 'n' })).toEqual({ ok: true })
    // Immediately, a Small on 27 is cleared. Same-runway this would be a wake hold behind the
    // Heavy; on a different runway it is not gated at all.
    sim.dispatch({ type: 'contactTower', aircraftId: 'w' })
    expect(sim.dispatch({ type: 'clearedForTakeoff', aircraftId: 'w' })).toEqual({ ok: true })
  })
})

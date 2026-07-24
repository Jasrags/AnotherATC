import { describe, it, expect } from 'vitest'
import { createAirportGame, compileRunwayDependencies, runwayCrossingsFrom } from './airport'
import { createGroundSim, type AircraftInit } from '../ground/sim'
import { buildTaxiGraph } from '../ground/taxiGraph'
import { buildRunwayGuard, runwayIdAt } from '../ground/runwayGuard'
import { displacedNm } from '../ground/runway'
import { KOAK, KOAK_RUNWAYS } from './koakAirport'
import { KSAN } from './ksanAirport'
import { KBUR } from './kburAirport'

/**
 * KOAK — the third airport, and the first with **parallel** runways. Where KBUR's two runways
 * cross, KOAK's two close parallels (10L/28R, 10R/28L) never touch: 1,001 ft apart, dependent.
 * world/airport.test.ts (the fictional field) is the generality anchor; this file proves the real
 * KOAK data plays, and that its declared dependent-parallel rule (docs/atc-multi-runway.md §6)
 * plugs into the same dependency seam KBUR's crossing does — but as a `wake`/`landing` coupling
 * with no crossing point, not an `occupancy` one.
 */

const graph = buildTaxiGraph(KOAK.surface)
const guard = buildRunwayGuard(KOAK.surface)

describe('KOAK configuration comes off the survey', () => {
  it('carries all four physical runways, and all four are drawn', () => {
    expect(KOAK.layouts.map((l) => l.ident)).toEqual(['10L/28R', '10R/28L', '12/30', '15/33'])
  })

  it('offers all eight directions as destinations, 30 the default (the terminal runway)', () => {
    const game = createAirportGame(KOAK)
    expect(game.destinations.map((d) => d.label)).toEqual(['RWY 30', 'RWY 12', 'RWY 28R', 'RWY 10L', 'RWY 28L', 'RWY 10R', 'RWY 15', 'RWY 33'])
    expect(game.runway.ident).toBe('30')
  })

  it('displaces only 30 (114 ft); every other end lands on the pavement end', () => {
    // docs/OAK/runways.md §3: 30 is the only displaced threshold at the field.
    const l1230 = KOAK.layouts.find((l) => l.ident === '12/30')!
    const end30 = l1230.ends.find((e) => e.ident === '30')!
    const end12 = l1230.ends.find((e) => e.ident === '12')!
    expect(displacedNm(end30)).toBeGreaterThan(0.01) // ~114 ft
    expect(displacedNm(end12)).toBeCloseTo(0, 5)
    for (const ident of ['10L/28R', '10R/28L', '15/33'] as const) {
      const layout = KOAK.layouts.find((l) => l.ident === ident)!
      for (const end of layout.ends) expect(displacedNm(end)).toBeCloseTo(0, 5)
    }
  })

  it('puts the one EMAS at the west (10R) end — DER 28L', () => {
    // docs/OAK/runways.md §2: EMAS 162×154 is at DER 28L = the departure end of 28L = the west end,
    // which sits at the 10R threshold side of 10R/28L.
    const l = KOAK.layouts.find((l) => l.ident === '10R/28L')!
    const west = l.ends.find((e) => e.ident === '10R')!
    const east = l.ends.find((e) => e.ident === '28L')!
    expect(west.emas).toEqual({ lengthFt: 162, widthFt: 154 })
    expect(east.emas).toBeNull()
    expect(west.pavementEnd[0]).toBeLessThan(east.pavementEnd[0]) // 10R end really is west
    // No EMAS anywhere else on the field.
    const others = KOAK.layouts.filter((l) => l.ident !== '10R/28L').flatMap((l) => l.ends)
    for (const end of others) expect(end.emas).toBeNull()
  })

  it('declares the shorter parallel LDA as a reduction, not a displacement', () => {
    // docs/OAK/runways.md §1: 10L LDA 5,336 with no displaced threshold; 28R full 5,457.
    expect(KOAK_RUNWAYS['10L'].ldaFt).toBe(5336)
    expect(KOAK_RUNWAYS['10L'].toraFt).toBe(5457)
    expect(KOAK_RUNWAYS['28R'].ldaFt).toBe(5457)
  })

  it('finds its terminal gates from its own surface', () => {
    // The passenger terminal (gates 1–32) on the South Field, beside 12/30.
    expect(KOAK.fleets[0]!.gates.length).toBeGreaterThanOrEqual(20)
  })
})

describe('the parallels are declared as a dependent-parallel coupling (docs/atc-multi-runway.md §6)', () => {
  const interact = compileRunwayDependencies(KOAK.runwayDependencies)

  it('couples 10L/28R and 10R/28L for wake, symmetrically — they share a wake corridor', () => {
    expect(interact('10L/28R', '10R/28L', 'wake')).toBe(true)
    expect(interact('10R/28L', '10L/28R', 'wake')).toBe(true)
  })

  it('couples them for landing too — the arrival-staggering rule (declared; enforcement pending)', () => {
    expect(interact('10L/28R', '10R/28L', 'landing')).toBe(true)
  })

  it('does NOT couple them for occupancy — nothing crosses, so neither ever occupies the other', () => {
    expect(interact('10L/28R', '10R/28L', 'occupancy')).toBe(false)
  })

  it('declares no crossing point — the coupling stays the coarse boolean', () => {
    expect(runwayCrossingsFrom(KOAK.runwayDependencies)).toEqual([])
  })

  it('leaves the South-Field runway independent of the parallels', () => {
    // 12/30 is a separate field, ~1 nm away — not coupled to either parallel for anything.
    expect(interact('12/30', '10L/28R', 'wake')).toBe(false)
    expect(interact('12/30', '10R/28L', 'landing')).toBe(false)
  })

  it('leaves an unrelated pair independent, and single-runway KSAN fully independent', () => {
    expect(interact('10L/28R', '99/99', 'wake')).toBe(false)
    expect(compileRunwayDependencies(KSAN.runwayDependencies)('09/27', '09/27', 'wake')).toBe(false)
  })
})

describe('runwayIdAt distinguishes all four runways on the real KOAK guard', () => {
  it('names a mid-runway point on each of the four', () => {
    expect(runwayIdAt([0.366, 0.383], guard)).toBe('10L/28R')
    expect(runwayIdAt([0.247, 0.254], guard)).toBe('10R/28L')
    expect(runwayIdAt([-0.334, -0.629], guard)).toBe('12/30')
    expect(runwayIdAt([-0.004, 0.874], guard)).toBe('15/33')
  })
})

/** A departure holding short of runway 30's departure end (the SE end), facing the NW takeoff roll. */
const departure30 = (): AircraftInit => ({
  id: 'd',
  callsign: 'SWA400',
  type: 'B738',
  wake: 'M',
  path: [
    [0.365, -1.218], // off-runway, SE of the 30 end
    KOAK_RUNWAYS['30'].departureStart,
    [0.289, -1.154], // past the end, onto the runway toward the NW
  ],
  targetSpeed: 15,
  intent: 'departure',
  goalPoint: KOAK_RUNWAYS['30'].departureStart,
})

describe('KOAK plays (the lessons-from-ksan #17 anchor)', () => {
  it('every terminal gate can taxi to the default departure runway (both fields are connected)', () => {
    // KOAK spans two physically separate movement areas; the terminal is on the South Field. This
    // guards that the taxi network actually joins them — no gate is islanded from runway 30.
    const game = createAirportGame(KOAK)
    const endNode = graph.nearestNode(game.runway.departureStart)
    expect(endNode).not.toBeNull()
    for (const g of KOAK.fleets[0]!.gates) {
      const from = graph.nearestNode(g.point)
      expect(from, `gate ${g.ref} has no graph node`).not.toBeNull()
      expect(graph.route(from!, endNode!).length, `gate ${g.ref} cannot route to RWY 30`).toBeGreaterThan(0)
    }
  })

  it('a lone departure takes off on 30', () => {
    const sim = createGroundSim([departure30()], {
      graph,
      guard,
      runway: KOAK_RUNWAYS['30'],
      runwaysInteract: compileRunwayDependencies(KOAK.runwayDependencies),
    })
    expect(sim.snapshot().aircraft[0]!.holdingForTakeoff).toBe(true)
    expect(sim.dispatch({ type: 'contactTower', aircraftId: 'd' })).toEqual({ ok: true })
    expect(sim.dispatch({ type: 'clearedForTakeoff', aircraftId: 'd' })).toEqual({ ok: true })
    for (let i = 0; i < 3000 && sim.snapshot().departed < 1; i += 1) sim.step(0.1)
    expect(sim.snapshot().departed).toBe(1)
  })

  it('an arrival flies 30’s final, lands, turns off and reaches its South-terminal gate', () => {
    const game = createAirportGame(KOAK, 3)
    const gate = KOAK.fleets[0]!.gates[0]!
    const sim = createGroundSim(
      [
        {
          id: 'a',
          callsign: 'SWA101',
          type: 'B738',
          wake: 'M',
          path: [game.spawn.approach.fix, game.spawn.approach.threshold],
          targetSpeed: 140,
          airborne: true,
          intent: 'arrival',
          goalPoint: gate.point,
          gate: gate.ref,
        },
      ],
      {
        graph,
        guard,
        spawn: game.spawn,
        servicing: game.servicing,
        runway: game.runway,
        runwaysInteract: game.runwaysInteract,
      },
    )
    expect(sim.dispatch({ type: 'clearedToLand', aircraftId: 'a' })).toEqual({ ok: true })

    const seen = new Set<string>()
    let taxiCleared = false
    for (let i = 0; i < 30000 && sim.snapshot().arrived < 1; i += 1) {
      sim.step(0.1)
      const a = sim.snapshot().aircraft.find((x) => x.id === 'a')
      if (!a) break
      seen.add(a.status)
      if (a.status === 'rollout') sim.dispatch({ type: 'contactGround', aircraftId: 'a' })
      if (a.controlledBy === 'ground' && !taxiCleared) {
        taxiCleared = true
        expect(sim.dispatch({ type: 'taxiToGoal', aircraftId: 'a' })).toEqual({ ok: true })
      }
    }
    expect(seen.has('landing')).toBe(true)
    expect(seen.has('rollout')).toBe(true)
    expect(sim.snapshot().arrived).toBe(1)
  })
})

describe('two runways active at once — a South runway and a North parallel (docs/atc-multi-runway.md §5)', () => {
  it('activates 30 and 28R together as different physical runways', () => {
    const game = createAirportGame(KOAK, 5)
    const sim = createGroundSim([], {
      graph,
      guard,
      spawn: game.spawn,
      servicing: game.servicing,
      runways: [KOAK_RUNWAYS['30'], KOAK_RUNWAYS['28R']],
      runwaysInteract: game.runwaysInteract,
    })
    expect(sim.runways().map((r) => r.ident)).toEqual(['30', '28R'])
    // Sanity that the two are on different physical runways (so per-runway occupancy is meaningful).
    expect(runwayIdAt([-0.334, -0.629], guard)).toBe('12/30')
    expect(runwayIdAt([0.366, 0.383], guard)).toBe('10L/28R')
  })

  it('is a different field from KBUR — parallels not crossers', () => {
    // A cheap guard that the two multi-runway fields stayed distinct: KBUR declares a crossing
    // point, KOAK declares none.
    expect(runwayCrossingsFrom(KBUR.runwayDependencies).length).toBeGreaterThan(0)
    expect(runwayCrossingsFrom(KOAK.runwayDependencies).length).toBe(0)
  })
})

import { describe, it, expect } from 'vitest'
import { createAirportGame, compileRunwayDependencies } from './airport'
import { createGroundSim, type AircraftInit } from '../ground/sim'
import { buildTaxiGraph } from '../ground/taxiGraph'
import { buildRunwayGuard, runwayIdAt } from '../ground/runwayGuard'
import { displacedNm, finalFix, FINAL_APPROACH_NM } from '../ground/runway'
import { KBUR, KBUR_RUNWAYS } from './kburAirport'
import { KSAN } from './ksanAirport'

/**
 * KBUR — the second airport, and the first that crosses two runways. lessons-from-ksan.md #17: a
 * suite that only exercises the one real airport proves the real airport still works, not that the
 * code is general. world/airport.test.ts (the fictional field) is the generality anchor; this file
 * proves the *real* KBUR data plays, and that its declared crossing rule (docs/atc-multi-runway.md
 * §6) plugs into the dependency seam.
 *
 * KBUR is single-active-runway in the game today (like KSAN): one direction in use, arrivals and
 * departures sharing it. What is new is the second physical runway — drawn, named by runwayIdAt,
 * and coupled to the first at the crossing.
 */

const graph = buildTaxiGraph(KBUR.surface)
const guard = buildRunwayGuard(KBUR.surface)

describe('KBUR configuration comes off the survey', () => {
  it('carries both physical runways, and both are drawn', () => {
    expect(KBUR.layouts.map((l) => l.ident)).toEqual(['08/26', '15/33'])
  })

  it('offers all four directions as destinations, 08 the default', () => {
    const game = createAirportGame(KBUR)
    expect(game.destinations.map((d) => d.label)).toEqual(['RWY 8', 'RWY 26', 'RWY 15', 'RWY 33'])
    expect(game.runway.ident).toBe('08')
  })

  it('08 has no displaced threshold; 15 and 33 both do', () => {
    // docs/BUR/runways.md §1–2: 08/26 landing threshold is the pavement end; 15/33 both displaced.
    const l0826 = KBUR.layouts.find((l) => l.ident === '08/26')!
    for (const end of l0826.ends) expect(displacedNm(end)).toBeCloseTo(0, 5)
    const l1533 = KBUR.layouts.find((l) => l.ident === '15/33')!
    for (const end of l1533.ends) expect(displacedNm(end)).toBeGreaterThan(0.05)
    // LDA reductions are exactly the displacements (6,885 − 909 / − 350).
    expect(KBUR_RUNWAYS['15'].ldaFt).toBe(5976)
    expect(KBUR_RUNWAYS['33'].ldaFt).toBe(6535)
  })

  it('puts the EMAS at the east (26) end — DER 08', () => {
    // docs/BUR/runways.md §3: DER 08 = the departure end of runway 08 = the east end.
    const l0826 = KBUR.layouts.find((l) => l.ident === '08/26')!
    const east = l0826.ends.find((e) => e.ident === '26')!
    const west = l0826.ends.find((e) => e.ident === '08')!
    expect(east.emas).toEqual({ lengthFt: 170, widthFt: 350 })
    expect(west.emas).toBeNull()
    // Sanity: the 26 end really is east of the 08 end.
    expect(east.pavementEnd[0]).toBeGreaterThan(west.pavementEnd[0])
  })

  it('finds its 14 terminal gates from its own surface', () => {
    expect(KBUR.fleets[0]!.gates.length).toBe(14)
    expect(KBUR.fleets[0]!.gates.every((g) => g.ref.startsWith('A') || g.ref.startsWith('B'))).toBe(true)
  })
})

describe('the crossing is declared as an occupancy coupling (docs/atc-multi-runway.md §6)', () => {
  const interact = compileRunwayDependencies(KBUR.runwayDependencies)

  it('couples 08/26 and 15/33 for occupancy, symmetrically', () => {
    expect(interact('08/26', '15/33', 'occupancy')).toBe(true)
    expect(interact('15/33', '08/26', 'occupancy')).toBe(true)
  })

  it('does not couple them for wake — crossing departures do not share a wake corridor', () => {
    expect(interact('08/26', '15/33', 'wake')).toBe(false)
  })

  it('leaves an unrelated pair independent', () => {
    expect(interact('08/26', '99/99', 'occupancy')).toBe(false)
    // KSAN has one runway and states no dependency: fully independent.
    expect(compileRunwayDependencies(KSAN.runwayDependencies)('09/27', '09/27', 'occupancy')).toBe(false)
  })
})

describe('runwayIdAt distinguishes the two runways on the real KBUR guard', () => {
  it('names a point on each runway, clear of the crossing', () => {
    // A point on 08/26 well west of the crossing, and one on 15/33 well north of it.
    expect(runwayIdAt([-0.35, -0.172], guard)).toBe('08/26')
    expect(runwayIdAt([0.036, 0.15], guard)).toBe('15/33')
  })
})

/** A departure holding short of runway 08's departure end (the west end), off the pavement,
 *  facing the takeoff roll. Mirrors the shape world/airport.test.ts uses. */
const departure08 = (): AircraftInit => ({
  id: 'd',
  callsign: 'SWA400',
  type: 'B738',
  wake: 'M',
  path: [
    [-0.62, -0.2], // approaching from off-runway, southwest of the 08 end
    KBUR_RUNWAYS['08'].departureStart,
    [-0.42, -0.155], // past the end, onto the runway
  ],
  targetSpeed: 15,
  intent: 'departure',
  goalPoint: KBUR_RUNWAYS['08'].departureStart,
})

describe('KBUR plays (the lessons-from-ksan #17 anchor)', () => {
  it('an arrival flies 08’s final, lands, turns off toward the terminal, crosses 15/33 and reaches its gate', () => {
    // The full loop on the intersecting field. Two things had to be true for this to work, and
    // both are guarded here: (a) the rollout turns off onto a real taxiway toward the gate side —
    // never up the crossing runway 15/33 (the runwayExits multi-runway fix + the gate-side turnoff
    // preference in chooseExit); (b) the SE terminal is actually connected to the taxi network (the
    // 34 ft bridge at the 26 end in the ingest — before it the terminal was a graph island and no
    // taxi route to a gate existed). The route to the gate crosses 15/33, so the controller clears
    // it across — modelled here by issuing the crossing when the aircraft holds short for it.
    const game = createAirportGame(KBUR, 3)
    const gate = KBUR.fleets[0]!.gates[0]!
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
    for (let i = 0; i < 20000 && sim.snapshot().arrived < 1; i += 1) {
      sim.step(0.1)
      const a = sim.snapshot().aircraft.find((x) => x.id === 'a')
      if (!a) break
      seen.add(a.status)
      if (a.status === 'rollout') sim.dispatch({ type: 'contactGround', aircraftId: 'a' })
      if (a.controlledBy === 'ground') {
        if (!taxiCleared) {
          taxiCleared = true
          // The turnoff never goes up 15/33 — the aircraft is on 08/26 pavement or a taxiway.
          expect(runwayIdAt([a.x, a.y], guard)).not.toBe('15/33')
          expect(sim.dispatch({ type: 'taxiToGoal', aircraftId: 'a' })).toEqual({ ok: true })
        }
        // Clear the 15/33 crossing when it holds short for it (a no-op otherwise).
        sim.dispatch({ type: 'crossRunway', aircraftId: 'a' })
      }
    }
    expect(seen.has('landing')).toBe(true)
    expect(seen.has('rollout')).toBe(true)
    expect(sim.snapshot().arrived).toBe(1)
  })

  it('every terminal gate can taxi to the departure runway (the terminal is not a graph island)', () => {
    // Regression guard for the ingest bridge (tools/ingest/build-kbur-surface.mjs): the SE terminal
    // reaches the taxi network only through a 34 ft weld at the 26 end. If an OSM re-fetch moves
    // that junction the bridge stops connecting, and every gate silently loses its route out — this
    // catches it. (The ingest also asserts the bridge endpoints land on real vertices.)
    const game = createAirportGame(KBUR, 3)
    const endNode = graph.nearestNode(game.runway.departureStart)
    expect(endNode).not.toBeNull()
    for (const g of KBUR.fleets[0]!.gates) {
      const from = graph.nearestNode(g.point)
      expect(from, `gate ${g.ref} has no graph node`).not.toBeNull()
      expect(graph.route(from!, endNode!).length, `gate ${g.ref} cannot route to RWY 08`).toBeGreaterThan(0)
    }
  })

  it('a lone departure takes off on 08, crossing the intersection on its roll', () => {
    const sim = createGroundSim([departure08()], {
      graph,
      guard,
      runway: KBUR_RUNWAYS['08'],
      runwaysInteract: compileRunwayDependencies(KBUR.runwayDependencies),
    })
    expect(sim.snapshot().aircraft[0]!.holdingForTakeoff).toBe(true)
    expect(sim.dispatch({ type: 'contactTower', aircraftId: 'd' })).toEqual({ ok: true })
    expect(sim.dispatch({ type: 'clearedForTakeoff', aircraftId: 'd' })).toEqual({ ok: true })
    for (let i = 0; i < 1500 && sim.snapshot().departed < 1; i += 1) sim.step(0.1)
    expect(sim.snapshot().departed).toBe(1)
  })
})

describe('the crossing rule has teeth: 15/33 traffic gates a takeoff on 08 (docs/atc-multi-runway.md §6)', () => {
  /** An aircraft stationary on runway 15/33, north of the crossing — physically occupying the
   *  intersection an 08 departure would roll through. */
  const occupant15 = (): AircraftInit => ({
    id: 'x',
    callsign: 'JBU900',
    type: 'B738',
    wake: 'M',
    path: [[0.036, 0.15]],
    targetSpeed: 0,
    intent: 'departure',
    goalPoint: KBUR_RUNWAYS['15'].departureStart,
  })

  const setup = (coupled: boolean) => {
    const sim = createGroundSim([departure08(), occupant15()], {
      graph,
      guard,
      runway: KBUR_RUNWAYS['08'],
      ...(coupled ? { runwaysInteract: compileRunwayDependencies(KBUR.runwayDependencies) } : {}),
    })
    // Precondition: the occupant really is on 15/33 (not 08/26).
    expect(runwayIdAt([0.036, 0.15], guard)).toBe('15/33')
    expect(sim.snapshot().aircraft.find((a) => a.id === 'd')!.holdingForTakeoff).toBe(true)
    expect(sim.dispatch({ type: 'contactTower', aircraftId: 'd' })).toEqual({ ok: true })
    return sim
  }

  it('refuses the takeoff while 15/33 is occupied, when the field couples the two', () => {
    const sim = setup(true)
    const res = sim.dispatch({ type: 'clearedForTakeoff', aircraftId: 'd' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toMatch(/occupied|busy|runway/i)
  })

  it('allows it when the runways are independent — the coupling is the only difference', () => {
    const sim = setup(false)
    expect(sim.dispatch({ type: 'clearedForTakeoff', aircraftId: 'd' })).toEqual({ ok: true })
  })
})

describe('two runways active at once (docs/atc-multi-runway.md §5)', () => {
  const near = (a: readonly [number, number], b: readonly [number, number]): boolean =>
    Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.05

  it('the spawner distributes arrivals across both active runways', () => {
    const game = createAirportGame(KBUR, 5)
    // Both 08 and 15 active at once — a different physical runway each.
    const sim = createGroundSim([], {
      graph,
      guard,
      spawn: game.spawn,
      servicing: game.servicing,
      runways: [KBUR_RUNWAYS['08'], KBUR_RUNWAYS['15']],
      runwaysInteract: game.runwaysInteract,
    })
    expect(sim.runways().map((r) => r.ident)).toEqual(['08', '15'])
    sim.setTrafficRate(4) // heavy, so both runways get traffic within the run

    const fix08 = finalFix(KBUR_RUNWAYS['08'], FINAL_APPROACH_NM)
    const fix15 = finalFix(KBUR_RUNWAYS['15'], FINAL_APPROACH_NM)
    const seen = new Set<string>()
    let on08 = 0
    let on15 = 0
    for (let i = 0; i < 8000 && (on08 === 0 || on15 === 0); i += 1) {
      sim.step(0.1)
      for (const a of sim.snapshot().aircraft) {
        if (a.status !== 'onFinal' || seen.has(a.id)) continue
        seen.add(a.id)
        if (near([a.x, a.y], fix08)) on08 += 1
        else if (near([a.x, a.y], fix15)) on15 += 1
      }
    }
    // Arrivals appeared established on *both* finals — the whole point of two active runways.
    expect(on08).toBeGreaterThan(0)
    expect(on15).toBeGreaterThan(0)
  })

  it('a runway can be taken back out of the set, but not the last one, nor one in use', () => {
    const sim = createGroundSim([], {
      graph,
      guard,
      runways: [KBUR_RUNWAYS['08'], KBUR_RUNWAYS['15']],
      runwaysInteract: game_runwaysInteract(),
    })
    // Cannot close the sole-remaining runway.
    expect(sim.deactivateRunway(KBUR_RUNWAYS['08']).ok).toBe(true)
    expect(sim.runways().map((r) => r.ident)).toEqual(['15'])
    expect(sim.deactivateRunway(KBUR_RUNWAYS['15'])).toEqual({ ok: false, reason: expect.stringMatching(/only active/i) })
  })

  const inboundTo = (id: string, atNm: number): AircraftInit => {
    // An arrival established `atNm` out on the given runway's final.
    const rwy = KBUR_RUNWAYS[id as '08' | '15']
    const fix = finalFix(rwy, atNm)
    return {
      id: 'a',
      callsign: 'SWA111',
      type: 'B738',
      wake: 'M',
      path: [fix, rwy.threshold],
      targetSpeed: 140,
      airborne: true,
      intent: 'arrival',
      goalPoint: KBUR.fleets[0]!.gates[0]!.point,
      gate: KBUR.fleets[0]!.gates[0]!.ref,
    }
  }

  it('drains an inbound onto a remaining runway when its runway is closed', () => {
    // An arrival well out (4 nm) on 08's final is not committed, so closing 08 does not refuse —
    // it sends the arrival around and re-establishes it on 15's approach.
    const sim = createGroundSim([inboundTo('08', FINAL_APPROACH_NM)], {
      graph,
      guard,
      runways: [KBUR_RUNWAYS['08'], KBUR_RUNWAYS['15']],
      runwaysInteract: game_runwaysInteract(),
    })
    expect(sim.deactivateRunway(KBUR_RUNWAYS['08']).ok).toBe(true)
    expect(sim.runways().map((r) => r.ident)).toEqual(['15'])
    // The arrival is now established on 15's final — its position moved to 15's approach fix.
    const a = sim.snapshot().aircraft.find((x) => x.id === 'a')!
    expect(near([a.x, a.y], finalFix(KBUR_RUNWAYS['15'], FINAL_APPROACH_NM))).toBe(true)
  })

  it('refuses to close a runway with an aircraft committed to it (short final)', () => {
    // Inside short final (≈1 nm) the arrival owns the runway, so it cannot be closed under it.
    const sim = createGroundSim([inboundTo('08', 1)], {
      graph,
      guard,
      runways: [KBUR_RUNWAYS['08'], KBUR_RUNWAYS['15']],
      runwaysInteract: game_runwaysInteract(),
    })
    const res = sim.deactivateRunway(KBUR_RUNWAYS['08'])
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toMatch(/committed|in use/i)
    // The idle runway can still be closed.
    expect(sim.deactivateRunway(KBUR_RUNWAYS['15']).ok).toBe(true)
  })
})

/** The compiled crossing coupling, reused across the two-runway tests. */
function game_runwaysInteract() {
  return createAirportGame(KBUR, 1).runwaysInteract
}

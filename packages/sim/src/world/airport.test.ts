import { describe, it, expect } from 'vitest'
import { createAirportGame, findRunway, gatesFromSurface, type Airport } from './airport'
import { createGroundSim } from '../ground/sim'
import { buildTaxiGraph } from '../ground/taxiGraph'
import { buildRunwayGuard } from '../ground/runwayGuard'
import { buildRunwayExits, buildRunwayIntersections, chooseExit } from '../ground/runwayExits'
import { KSAN } from './ksanAirport'
import type { AirportSurface } from './types'
import type { Rng } from '../random'

/**
 * A fictional field, invented here and nowhere else in the codebase.
 *
 * This is the actual test of whether the engine is airport-agnostic: if adding an airport is a
 * data exercise, a made-up one should play. It runs north–south rather than east–west, has a
 * displaced threshold at one end only, different gates, different traffic and different
 * airlines — every axis on which it could accidentally be KSAN.
 */
const surface: AirportSurface = {
  icao: 'KTST',
  name: 'Testfield',
  ref: { lat: 40, lon: -100, elevationFt: 500 },
  units: 'nm',
  source: 'synthetic',
  bounds: { minX: -0.6, minY: -0.2, maxX: 0.6, maxY: 2.2 },
  features: [
    // Runway 36/18, running due north, 2 nm long.
    { kind: 'runway', ref: '18/36', points: [[0, 0], [0, 2]] },
    // Parallel taxiway "A" to the east, with connectors at four points along the runway.
    { kind: 'taxiway', ref: 'A', points: [[0.3, 0], [0.3, 0.5], [0.3, 1], [0.3, 1.5], [0.3, 2]] },
    { kind: 'taxiway', ref: 'A1', points: [[0.3, 0], [0.15, 0], [0.02, 0]] },
    { kind: 'taxiway', ref: 'A2', points: [[0.3, 0.5], [0.16, 0.56], [0.02, 0.62]] },
    { kind: 'taxiway', ref: 'A3', points: [[0.3, 1.5], [0.16, 1.44], [0.02, 1.38]] },
    { kind: 'taxiway', ref: 'A4', points: [[0.3, 2], [0.15, 2], [0.02, 2]] },
    // A stand off the parallel.
    { kind: 'taxilane', ref: 'S', points: [[0.3, 1], [0.5, 1]] },
    { kind: 'gate', ref: '1', points: [[0.5, 1]] },
    { kind: 'gate', ref: '2', points: [[0.5, 1.05]] },
  ],
}

const identity = (rng: Rng) => ({
  callsign: `TST${rng.int(100, 999)}`,
  type: 'E75L',
  wake: 'M' as const,
})

const KTST: Airport = {
  icao: 'KTST',
  name: 'TESTFIELD',
  surface,
  runways: [
    {
      ident: '36',
      threshold: [0, 0.25], // displaced 1,500 ft
      departureStart: [0, 0],
      farEnd: [0, 2],
      toraFt: 12152,
      ldaFt: 10633,
      glidePathDeg: 3,
      pattern: 'left',
    },
    {
      ident: '18',
      threshold: [0, 2], // not displaced at this end
      departureStart: [0, 2],
      farEnd: [0, 0],
      toraFt: 12152,
      ldaFt: 12152,
      glidePathDeg: 3.1,
      pattern: 'right',
    },
  ],
  defaultRunway: '36',
  layout: {
    ident: '18/36',
    widthFt: 150,
    ends: [
      { ident: '36', pavementEnd: [0, 0], threshold: [0, 0.25], emas: null },
      { ident: '18', pavementEnd: [0, 2], threshold: [0, 2], emas: { lengthFt: 400, widthFt: 170 } },
    ],
  },
  // One fleet is enough to be an airport: a field with a single class of traffic states one.
  fleets: [{ kind: 'airline', weight: 1, gates: gatesFromSurface(surface), identity }],
  servicing: { services: [{ kind: 'fuel', sec: 20 }] },
  comms: { ground: '121.7', tower: '119.1', atis: '127.4' },
  traffic: { intervalSec: 15, maxAircraft: 4, initialDepartures: 2 },
}

const graph = buildTaxiGraph(surface)
const guard = buildRunwayGuard(surface)

describe('a misconfigured field fails loudly', () => {
  // A bundle is data, and data arrives wrong. Each of these used to produce a *silently dead
  // field* — no aircraft, no error, nothing to debug from — which is the worst of both.
  const broken = (fleets: Airport['fleets']): Airport => ({ ...KTST, fleets })

  it('refuses a field with no traffic at all', () => {
    expect(() => createAirportGame(broken([]), 1)).toThrow(/fleet/i)
  })

  it('refuses a fleet with nowhere to park', () => {
    expect(() => createAirportGame(broken([{ ...KTST.fleets[0]!, gates: [] }]), 1)).toThrow(/stand/i)
  })

  it('refuses a weight that is not a usable share', () => {
    // NaN was the dangerous one: it poisons the total, slips past a `<= 0` guard, and pins
    // every draw to the last fleet in the list without ever failing.
    for (const weight of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      expect(() => createAirportGame(broken([{ ...KTST.fleets[0]!, weight }]), 1)).toThrow(/weight/i)
    }
  })

  it('refuses a field whose fleets all have zero weight — nothing would ever spawn', () => {
    expect(() => createAirportGame(broken([{ ...KTST.fleets[0]!, weight: 0 }]), 1)).toThrow(/weight/i)
  })
})

describe('a second, made-up airport', () => {
  it('finds its own gates from its own surface', () => {
    expect(KTST.fleets[0]!.gates.map((g) => g.ref)).toEqual(['1', '2'])
    // …and nothing leaked from the one real airport.
    expect(KTST.fleets[0]!.gates.length).toBeLessThan(KSAN.fleets[0]!.gates.length)
  })

  it('builds a game with its own traffic, stands and runway', () => {
    const game = createAirportGame(KTST, 7)
    expect(game.runway.ident).toBe('36')
    expect(game.inits).toHaveLength(2) // its own initialDepartures, not KSAN's 3
    expect(game.inits.every((i) => i.callsign.startsWith('TST'))).toBe(true)
    expect(game.spawn.intervalSec).toBe(15)
    expect(game.spawn.maxAircraft).toBe(4)
    // Departures aim at the pavement end; the final lies beyond the threshold, off the approach
    // end — which for a north-facing runway is *south* of the field, not east or west.
    expect(game.spawn.departureTarget).toEqual([0, 0])
    expect(game.spawn.approach.threshold).toEqual([0, 0.25])
    expect(game.spawn.approach.fix[1]).toBeLessThan(0)
    expect(Math.abs(game.spawn.approach.fix[0])).toBeLessThan(1e-6)
  })

  it('offers both of its runway directions as destinations', () => {
    const game = createAirportGame(KTST)
    expect(game.destinations.map((d) => d.label)).toEqual(['RWY 36', 'RWY 18'])
  })

  it('derives turnoffs and intersections from its own geometry', () => {
    const r = findRunway(KTST, '36')!
    const intersections = buildRunwayIntersections(graph.topology(), guard, r.departureStart, r.farEnd)
    expect(intersections.map((i) => i.ref)).toEqual(['A1', 'A2', 'A3', 'A4'])
    // Landing exits are the far half only, so the near connectors drop out.
    const exits = buildRunwayExits(graph.topology(), guard, r.threshold, r.farEnd)
    expect(exits.length).toBeGreaterThan(0)
    expect(exits.map((e) => e.ref)).not.toContain('A1')
    expect(chooseExit(exits, 140, 0)).not.toBeNull()
  })

  it('plays: an arrival flies its final, lands, exits and reaches a gate', () => {
    const game = createAirportGame(KTST, 3)
    const gate = KTST.fleets[0]!.gates[0]!
    const sim = createGroundSim(
      [
        {
          id: 'a',
          callsign: 'TST101',
          type: 'E75L',
          wake: 'M',
          path: [game.spawn.approach.fix, game.spawn.approach.threshold],
          targetSpeed: 140,
          airborne: true,
          intent: 'arrival',
          goalPoint: gate.point,
          gate: gate.ref,
        },
      ],
      { graph, guard, spawn: game.spawn, servicing: game.servicing, runway: game.runway },
    )
    expect(sim.dispatch({ type: 'clearedToLand', aircraftId: 'a' })).toEqual({ ok: true })

    const seen = new Set<string>()
    let sentToGround = false
    let taxied = false
    for (let i = 0; i < 8000; i += 1) {
      sim.step(0.1)
      const a = sim.snapshot().aircraft.find((x) => x.id === 'a')
      if (!a) break
      seen.add(a.status)
      if (a.status === 'rollout' && !sentToGround) {
        sentToGround = true
        expect(sim.dispatch({ type: 'contactGround', aircraftId: 'a' })).toEqual({ ok: true })
      }
      // Ground taxis it in — the handoff was a frequency change, not a clearance to the gate.
      if (a.controlledBy === 'ground' && !taxied) {
        taxied = true
        expect(sim.dispatch({ type: 'taxiToGoal', aircraftId: 'a' })).toEqual({ ok: true })
      }
    }
    expect(seen.has('landing')).toBe(true)
    expect(seen.has('rollout')).toBe(true)
    expect(seen.has('taxi')).toBe(true)
    expect(sim.snapshot().arrived).toBe(1)
  })

  it('plays: a departure holds short, is handed to Tower and gets airborne', () => {
    const game = createAirportGame(KTST, 3)
    const r = game.runway
    const sim = createGroundSim(
      [
        {
          id: 'd',
          callsign: 'TST202',
          type: 'E75L',
          wake: 'M',
          // Holding short of the departure end, off the runway to the east.
          path: [[0.1, 0], [0, 0], [-0.1, 0]],
          targetSpeed: 15,
          intent: 'departure',
          goalPoint: [r.departureStart[0], r.departureStart[1]],
        },
      ],
      { graph, guard, runway: r },
    )
    expect(sim.snapshot().aircraft[0]!.holdingForTakeoff).toBe(true)
    expect(sim.dispatch({ type: 'contactTower', aircraftId: 'd' })).toEqual({ ok: true })
    expect(sim.dispatch({ type: 'lineUpAndWait', aircraftId: 'd' })).toEqual({ ok: true })
    for (let i = 0; i < 400; i += 1) sim.step(0.1)
    expect(sim.snapshot().aircraft[0]!.status).toBe('lineUpWait')
    expect(sim.dispatch({ type: 'clearedForTakeoff', aircraftId: 'd' })).toEqual({ ok: true })
    for (let i = 0; i < 900; i += 1) sim.step(0.1)
    expect(sim.snapshot().departed).toBe(1)
  })

  it('refuses a takeoff from the end that is not in use, naming its own runways', () => {
    const game = createAirportGame(KTST, 3, '36')
    const sim = createGroundSim(
      [
        {
          id: 'd', callsign: 'TST303', type: 'E75L', wake: 'M',
          // At the *north* end, while 36 (which rolls north) is in use.
          path: [[0.1, 2], [0, 2], [-0.1, 2]],
          targetSpeed: 15, intent: 'departure', goalPoint: [0, 2],
        },
      ],
      { graph, guard, runway: game.runway },
    )
    sim.dispatch({ type: 'contactTower', aircraftId: 'd' })
    expect(sim.dispatch({ type: 'clearedForTakeoff', aircraftId: 'd' })).toEqual({
      ok: false,
      reason: 'RWY 18 is not in use — RWY 36 is the active runway',
    })
  })

  it('switches configuration, and the final moves to the other end of its own runway', () => {
    const game = createAirportGame(KTST, 3, '36')
    const sim = createGroundSim([], { graph, guard, runway: game.runway })
    const on36 = sim.approach()!
    expect(sim.setRunway(findRunway(KTST, '18')!)).toEqual({ ok: true })
    const on18 = sim.approach()!
    expect(on36.fix[1]).toBeLessThan(on36.threshold[1]) // approach from the south for 36
    expect(on18.fix[1]).toBeGreaterThan(on18.threshold[1]) // from the north for 18
  })
})

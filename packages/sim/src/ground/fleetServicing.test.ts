import { describe, it, expect } from 'vitest'
import { createGroundSim } from './sim'
import type { AircraftInit, ServicingConfig, SpawnFleet } from './sim'
import { KSAN } from '../world/ksanAirport'
import { createAirportGame } from '../world/airport'
import { buildTaxiGraph } from './taxiGraph'
import { buildRunwayGuard } from './runwayGuard'
import type { Rng } from '../random'

const FIELD_DEFAULT: ServicingConfig = { services: [{ kind: 'fuel', sec: 40 }] }
const QUICK: ServicingConfig = { services: [{ kind: 'fuel', sec: 8 }] }

const identity = (rng: Rng) => ({ callsign: `X${rng.int(10, 99)}`, type: 'C172', wake: 'L' as const })

const fleet = (kind: string, servicing?: ServicingConfig): SpawnFleet => ({
  kind,
  weight: 1,
  gates: [{ ref: `${kind}1`, point: [0, 0] }],
  identity,
  ...(servicing ? { servicing } : {}),
})

const parked = (id: string, over: Partial<AircraftInit> = {}): AircraftInit => ({
  id,
  callsign: id,
  type: 'B738',
  wake: 'M',
  path: [[0, 0]],
  targetSpeed: 0,
  intent: 'departure',
  gate: '1',
  ...over,
})

/** Seconds until this aircraft may push back. */
const svc = (sim: ReturnType<typeof createGroundSim>, id: string) =>
  sim.snapshot().aircraft.find((a) => a.id === id)!.serviceSec

/**
 * Servicing per fleet.
 *
 * The fleet split decided who parks where and what wake category a strip shows. It did not
 * decide what happens to an aircraft once it is parked: one global profile meant a Cessna on
 * the GA ramp waited out catering and cabin service it will never receive, and a freighter
 * waited on fuel when what it is actually doing is loading freight. This is the last place
 * "what an aircraft is decides what happens to it" was not honoured.
 */
describe('a fleet brings its own turnaround', () => {
  const spawnWith = (fleets: readonly SpawnFleet[]) => ({
    fleets,
    departureTarget: [1, 0] as [number, number],
    approach: { fix: [-4, 0] as [number, number], threshold: [0, 0] as [number, number] },
    intervalSec: 10,
    maxAircraft: 4,
    seed: 1,
  })

  it('services an aircraft on its own fleet\'s profile', () => {
    const sim = createGroundSim([parked('a', { fleet: 'ga' })], {
      servicing: FIELD_DEFAULT,
      spawn: spawnWith([fleet('ga', QUICK)]),
    })
    expect(svc(sim, 'a')).toBe(8)
  })

  it('falls back to the field\'s profile for a fleet that states none', () => {
    // A field-wide default is still the sensible thing for traffic that is simply "airline".
    const sim = createGroundSim([parked('a', { fleet: 'airline' })], {
      servicing: FIELD_DEFAULT,
      spawn: spawnWith([fleet('airline')]),
    })
    expect(svc(sim, 'a')).toBe(40)
  })

  it('falls back for an aircraft that belongs to no fleet at all', () => {
    // Hand-authored scenarios and the dev sandbox place aircraft with no fleet behind them.
    const sim = createGroundSim([parked('a')], {
      servicing: FIELD_DEFAULT,
      spawn: spawnWith([fleet('ga', QUICK)]),
    })
    expect(svc(sim, 'a')).toBe(40)
  })

  it('gives a turned-round arrival its own fleet\'s profile, not the field\'s', () => {
    // The turnaround is where this matters most: the aircraft has been on the field for a whole
    // arrival, and what it needs before it can leave again is a fact about what it is.
    const gate: [number, number] = [0, 0.02]
    const sim = createGroundSim(
      [{
        id: 'r', callsign: 'r', type: 'C172', wake: 'L',
        path: [[0, 0], gate], targetSpeed: 15, intent: 'arrival', goalPoint: gate, gate: 'ga1',
        fleet: 'ga',
      }],
      { servicing: FIELD_DEFAULT, spawn: spawnWith([fleet('ga', QUICK)]), turnaround: true },
    )
    for (let i = 0; i < 600 && svc(sim, 'r') === 0; i += 1) sim.step(0.1)
    expect(svc(sim, 'r')).toBe(8) // its own, not the field's 40
  })

  it('carries the fleet through the spawner, so spawned traffic is serviced as what it is', () => {
    const sim = createGroundSim([], {
      servicing: FIELD_DEFAULT,
      spawn: spawnWith([fleet('ga', QUICK)]),
    })
    for (let i = 0; i < 400 && sim.snapshot().aircraft.length === 0; i += 1) sim.step(0.1)
    const spawned = sim.snapshot().aircraft.find((a) => a.intent === 'departure')
    if (spawned) expect(spawned.serviceSec).toBeLessThanOrEqual(8)
  })
})

describe('KSAN: three fleets, three tempos', () => {
  const graph = buildTaxiGraph(KSAN.surface)
  const guard = buildRunwayGuard(KSAN.surface)

  /** One parked departure from the named fleet, on that fleet's own first stand. */
  function departureFrom(kind: string) {
    const game = createAirportGame(KSAN, 1)
    const f = KSAN.fleets.find((x) => x.kind === kind)!
    const slot = f.gates[0]!
    const sim = createGroundSim(
      [{
        id: 'd', callsign: 'D', type: 'B738', wake: 'M',
        path: [slot.point], targetSpeed: 0, intent: 'departure',
        gate: slot.ref, goalPoint: game.runway.departureStart, fleet: kind,
      }],
      { graph, guard, runway: game.runway, stands: game.stands, servicing: game.servicing, spawn: game.spawn },
    )
    return sim.snapshot().aircraft[0]!.serviceSec
  }

  it('turns a light aircraft round far faster than an airliner', () => {
    // The whole point: GA is traffic that appears, pushes and goes, and the field should feel
    // that. Waiting out an airline catering truck is not what a Cessna does.
    expect(departureFrom('ga')).toBeLessThan(departureFrom('airline') / 2)
  })

  it('keeps a freighter on stand longest, and for loading rather than fuel', () => {
    // Freighters are the field's Heavies *and* they are across the runway, so every one of them
    // is a crossing. Making them sit longer is pressure on the crossing, not just on a clock.
    expect(departureFrom('cargo')).toBeGreaterThan(departureFrom('airline'))
    const cargo = KSAN.fleets.find((f) => f.kind === 'cargo')!.servicing!
    const longest = [...cargo.services].sort((a, b) => b.sec - a.sec)[0]!
    expect(longest.kind).toBe('freight')
  })

  it('still lets every fleet push eventually — no profile is a dead end', () => {
    for (const f of KSAN.fleets) {
      const services = f.servicing?.services ?? KSAN.servicing.services
      expect(services.length).toBeGreaterThan(0)
      expect(services.every((s) => s.sec > 0 && Number.isFinite(s.sec))).toBe(true)
    }
  })
})

describe('played on the real field, the fleets leave at different rates', () => {
  const graph = buildTaxiGraph(KSAN.surface)
  const guard = buildRunwayGuard(KSAN.surface)

  it('a GA aircraft is pushing while the freighter beside it is still loading', () => {
    // The claim is about tempo, not about constants: worked identically, from the same instant,
    // by a controller doing nothing but the ordinary sequence, these two leave at different
    // times because of what they are.
    const game = createAirportGame(KSAN, 1)
    const stand = (kind: string) => KSAN.fleets.find((f) => f.kind === kind)!.gates[0]!
    const mk = (id: string, kind: string) => {
      const slot = stand(kind)
      return {
        id, callsign: id.toUpperCase(), type: 'B738', wake: 'M' as const,
        path: [slot.point], targetSpeed: 0,
        ...(slot.headingDeg !== undefined ? { heading: slot.headingDeg } : {}),
        intent: 'departure' as const, gate: slot.ref,
        goalPoint: game.runway.departureStart, fleet: kind,
      }
    }
    const sim = createGroundSim([mk('lite', 'ga'), mk('freight', 'cargo')], {
      graph, guard, runway: game.runway, stands: game.stands,
      servicing: game.servicing, spawn: game.spawn,
    })
    for (const id of ['lite', 'freight']) sim.dispatch({ type: 'clearance', aircraftId: id })

    const pushedAt: Record<string, number> = {}
    for (let i = 0; i < 3000 && Object.keys(pushedAt).length < 2; i += 1) {
      sim.step(0.1)
      for (const id of ['lite', 'freight']) {
        if (pushedAt[id] !== undefined) continue
        if (sim.dispatch({ type: 'pushback', aircraftId: id }).ok) pushedAt[id] = sim.snapshot().time
      }
    }

    expect(pushedAt.lite).toBeDefined()
    expect(pushedAt.freight).toBeDefined()
    // Not marginally: the light aircraft is away and taxiing while the freighter is still on
    // stand, which is what makes the two fleets feel like different traffic to work.
    expect(pushedAt.freight!).toBeGreaterThan(pushedAt.lite! * 3)
  })
})

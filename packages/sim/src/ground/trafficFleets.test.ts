import { describe, it, expect } from 'vitest'
import { KSAN } from '../world/ksanAirport'
import { createAirportGame } from '../world/airport'
import { createGroundSim } from './sim'
import { buildTaxiGraph } from './taxiGraph'
import { buildRunwayGuard } from './runwayGuard'
import { buildStands } from './stands'
import { KSAN_SURFACE } from '../world/ksan'

const graph = buildTaxiGraph(KSAN_SURFACE)
const guard = buildRunwayGuard(KSAN_SURFACE)
const stands = buildStands(KSAN_SURFACE)

/** Which side of runway 09/27 a point is on. The terminals are all on one side and the North
 *  Ramp and GA apron on the other, which is the whole reason this field has crossings. */
function northOfRunway(p: readonly [number, number]): boolean {
  const a = KSAN.layout.ends[0]!.pavementEnd
  const b = KSAN.layout.ends[1]!.pavementEnd
  return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) > 0
}

const fleetOf = (kind: string) => KSAN.fleets.find((f) => f.kind === kind)!

describe('KSAN traffic fleets', () => {
  it('parks the airline fleet south of the runway and cargo/GA north of it', () => {
    // Not a styling choice — it is the geometry that makes a crossing an ordinary event.
    const side = (kind: string) => {
      const refs = new Set(fleetOf(kind).gates.map((g) => g.ref))
      return stands.filter((s) => refs.has(s.ref)).map((s) => northOfRunway(s.stop))
    }
    expect(side('airline').every((n) => !n)).toBe(true)
    expect(side('cargo').length).toBeGreaterThan(0)
    expect(side('cargo').every((n) => n)).toBe(true)
    expect(side('ga').length).toBeGreaterThan(0)
    expect(side('ga').every((n) => n)).toBe(true)
  })

  it('gives every fleet stands the taxi network can actually reach', () => {
    // A fleet whose apron is unreachable spawns traffic that can never be worked.
    const game = createAirportGame(KSAN, 1)
    const from = fleetOf('airline').gates[0]!
    for (const f of KSAN.fleets) {
      for (const slot of f.gates) {
        const sim = createGroundSim(
          [{
            id: 'a', callsign: 'A', type: 'B738', wake: 'M', path: [from.point],
            targetSpeed: 0, intent: 'arrival', goalPoint: slot.point, gate: slot.ref,
          }],
          { graph, guard, runway: game.runway },
        )
        expect(sim.dispatch({ type: 'taxiToGoal', aircraftId: 'a' }).ok).toBe(true)
      }
    }
  })

  it('never puts one fleet on another fleet\'s parking', () => {
    const seen = new Map<string, string>()
    for (const f of KSAN.fleets) {
      for (const g of f.gates) {
        expect(seen.has(g.ref)).toBe(false)
        seen.set(g.ref, f.kind)
      }
    }
  })
})

describe('the spawner mixes the fleets', () => {
  /** Run the real spawner long enough to see the mix, and report callsign prefixes. */
  function spawnedOver(seconds: number, seed = 7): string[] {
    const game = createAirportGame(KSAN, seed)
    const sim = createGroundSim([], { graph, guard, spawn: game.spawn, runway: game.runway })
    const seen = new Set<string>()
    for (let i = 0; i < seconds * 10; i += 1) {
      sim.step(0.1)
      for (const a of sim.snapshot().aircraft) seen.add(a.callsign)
    }
    return [...seen]
  }

  it('produces airline, cargo and GA traffic from one seeded stream', () => {
    const callsigns = spawnedOver(3000)
    const cargo = callsigns.filter((c) => /^(FDX|UPS|GTI|CLX)/.test(c))
    const ga = callsigns.filter((c) => /^N\d/.test(c))
    const airline = callsigns.filter((c) => /^(AAL|UAL|DAL|SWA|ASA|NKS|JBU|SKW)/.test(c))
    expect(airline.length).toBeGreaterThan(0)
    expect(cargo.length).toBeGreaterThan(0)
    expect(ga.length).toBeGreaterThan(0)
    // Weighted by movements, not by stand count: the airline fleet is most of the day.
    expect(airline.length).toBeGreaterThan(cargo.length + ga.length)
  })

  it('is deterministic — the same seed gives the same traffic', () => {
    expect(spawnedOver(1200, 42)).toEqual(spawnedOver(1200, 42))
  })

  it('starts the field with its gates full, not its freight apron', () => {
    const game = createAirportGame(KSAN, 1)
    const cargoRefs = new Set(fleetOf('cargo').gates.map((g) => g.ref))
    const gaRefs = new Set(fleetOf('ga').gates.map((g) => g.ref))
    for (const init of game.inits) {
      expect(cargoRefs.has(init.gate ?? '')).toBe(false)
      expect(gaRefs.has(init.gate ?? '')).toBe(false)
    }
  })
})

describe('the crossing is now an ordinary event', () => {
  it('sends a cargo arrival to a stand it can only reach across the runway', () => {
    // The point of the whole fleet split: an arrival for the North Ramp taxis to the runway,
    // holds short, and waits for a crossing clearance — the exchange in
    // docs/atc-runway-crossing.md, reached by playing rather than by contriving.
    const game = createAirportGame(KSAN, 1)
    const stand = fleetOf('cargo').gates[0]!
    const sim = createGroundSim(
      [{
        id: 'fdx', callsign: 'FDX1', type: 'B763', wake: 'H',
        path: [game.spawn.approach.fix, game.spawn.approach.threshold],
        targetSpeed: 140, airborne: true, intent: 'arrival',
        goalPoint: stand.point, gate: stand.ref,
      }],
      { graph, guard, runway: game.runway },
    )
    expect(sim.dispatch({ type: 'clearedToLand', aircraftId: 'fdx' }).ok).toBe(true)

    const A = () => sim.snapshot().aircraft.find((a) => a.id === 'fdx')
    // Land, roll out, get handed to Ground, taxi — and stop at the runway it has to cross.
    let heldShort = false
    for (let i = 0; i < 40000 && !heldShort; i += 1) {
      sim.step(0.1)
      const a = A()
      if (!a) break
      if (a.status === 'rollout' && !a.handoffPending) sim.dispatch({ type: 'contactGround', aircraftId: 'fdx' })
      heldShort = a.holdShort
    }
    expect(heldShort).toBe(true)
    expect(A()!.holdingForTakeoff).toBe(false) // holding to cross, not to depart
    expect(A()!.canHoldShort).toBe(true)

    // And the crossing clearance releases it to its stand.
    expect(sim.dispatch({ type: 'crossRunway', aircraftId: 'fdx' }).ok).toBe(true)
    let parked = false
    for (let i = 0; i < 40000 && !parked; i += 1) {
      sim.step(0.1)
      const a = A()
      if (!a) { parked = true; break } // reached the stand, dwelled, and cleared
      parked = a.status === 'parked'
    }
    expect(parked).toBe(true)
  })
})

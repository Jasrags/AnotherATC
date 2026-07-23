import { describe, it, expect } from 'vitest'
import { KSAN } from '../world/ksanAirport'
import { createAirportGame } from '../world/airport'
import { createGroundSim, type AircraftInit } from './sim'
import { buildTaxiGraph } from './taxiGraph'
import { buildRunwayGuard } from './runwayGuard'
import { KSAN_SURFACE } from '../world/ksan'
import { lookupAircraftType } from './aircraftTypes'

const graph = buildTaxiGraph(KSAN_SURFACE)
const guard = buildRunwayGuard(KSAN_SURFACE)

/**
 * An aircraft's type decides how it flies — proven through the real spawn/land path, not by
 * reading the catalog back to itself.
 *
 * The one capability the sim consumes today is approach speed: a Light crosses the landing
 * threshold far slower than a Heavy. It takes an earlier turnoff, but crawls to it — so it holds
 * the runway *longer*, not shorter, which is the real reason slow traffic among jets costs
 * throughput. That whole behaviour rides on the exit geometry already in runwayExits.ts — the
 * catalog only supplies the speed the model brakes down from.
 */
describe('an aircraft flies to its type, not a flat default', () => {
  it('spawns each arrival at its own type approach speed, not one constant for all', () => {
    // Drive the real internal spawner (the live game path, not a hand-authored fixture) and read
    // back the approach speed it gave each arrival. Before the catalog, every arrival got a flat
    // 140 kt; now a C172 must appear slower than a B763.
    const game = createAirportGame(KSAN, 7)
    const sim = createGroundSim([], { graph, guard, spawn: game.spawn, runway: game.runway })

    const seen = new Map<string, number>()
    for (let i = 0; i < 40000 && seen.size < 3; i += 1) {
      sim.step(0.1)
      for (const a of sim.snapshot().aircraft) {
        if (a.status === 'onFinal' && !seen.has(a.type)) seen.set(a.type, a.groundspeed)
      }
    }

    expect(seen.size).toBeGreaterThan(0)
    for (const [type, speed] of seen) {
      expect(speed, `${type} spawned off its catalog approach speed`).toBe(
        lookupAircraftType(type).approachKt,
      )
    }
  })

  it('makes a slow Light hold the runway longer than a fast Heavy', () => {
    const game = createAirportGame(KSAN, 1)
    const gate = KSAN.fleets[0]!.gates[0]!

    const occupancySec = (type: string): number => {
      const spec = lookupAircraftType(type)
      const init: AircraftInit = {
        id: type,
        callsign: type,
        type,
        wake: spec.wake,
        path: [game.spawn.approach.fix, game.spawn.approach.threshold],
        targetSpeed: spec.approachKt, // the real threshold-crossing speed for this type
        airborne: true,
        intent: 'arrival',
        goalPoint: gate.point,
        gate: gate.ref,
      }
      const sim = createGroundSim([init], { graph, guard, runway: game.runway, stands: game.stands })
      const A = () => sim.snapshot().aircraft.find((x) => x.id === type)!
      sim.dispatch({ type: 'clearedToLand', aircraftId: type })

      // Runway occupancy is a physical fact — from touchdown (first tick on the runway surface,
      // rolling out) to the tick it turns off onto its exit. No handoff involved; measuring by the
      // ground handoff would just time how fast the test presses the button.
      let touchdown = -1
      for (let i = 0; i < 12000; i += 1) {
        sim.step(0.1)
        const a = A()
        if (touchdown < 0 && a.status === 'rollout' && a.onRunway) touchdown = i
        if (touchdown >= 0 && !a.onRunway) return (i - touchdown) * 0.1
      }
      throw new Error(`${type} never cleared the runway`)
    }

    // Runway occupancy is distance-to-turnoff over average speed, and speed dominates: the fast
    // Heavy covers more pavement but quickly, while the slow Light crawls to its early turnoff and
    // holds the runway far longer — the "Cessna among jets" throughput problem, real and worth the
    // controller's attention. Same runway, same rollout code; the only difference is the approach
    // speed the type carries.
    expect(occupancySec('C172')).toBeGreaterThan(occupancySec('B763'))
  })
})

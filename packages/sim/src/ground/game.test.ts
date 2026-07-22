import { describe, it, expect } from 'vitest'
import { createGroundSim } from './sim'
import type { AircraftInit, SpawnConfig } from './sim'
import { buildTaxiGraph } from './taxiGraph'
import { buildRunwayGuard } from './runwayGuard'
import type { AirportSurface } from '../world/types'

// A minimal airport: one runway along x=0..2 (y=0) and one taxiway alongside it
// with a gate spur, so departures can reach the runway and arrivals a gate.
const surface: AirportSurface = {
  icao: 'TEST',
  name: 'Test',
  ref: { lat: 0, lon: 0, elevationFt: 0 },
  units: 'nm',
  source: 'synthetic',
  bounds: { minX: 0, minY: -0.2, maxX: 2, maxY: 0 },
  features: [
    { kind: 'runway', points: [[0, 0], [2, 0]] },
    // taxiway parallel to the runway (south of it), with connectors up to it
    {
      kind: 'taxiway',
      points: [
        [0.2, -0.2],
        [1, -0.2],
        [1.8, -0.2],
      ],
    },
    { kind: 'taxiway', points: [[1.8, -0.2], [1.8, -0.02]] }, // connector to runway at east
  ],
}

const graph = buildTaxiGraph(surface)
const guard = buildRunwayGuard(surface)

const spawn: SpawnConfig = {
  fleets: [
    {
      kind: 'airline',
      weight: 1,
      gates: [{ ref: 'A1', point: [0.2, -0.2] }],
      identity: () => ({ callsign: 'TST1', type: 'B738', wake: 'M' }),
    },
  ],
  departureTarget: [1.8, -0.02],
  approach: { fix: [-4, 0], threshold: [0, 0] },
  intervalSec: 5,
  maxAircraft: 3,
  seed: 1,
}

describe('traffic flow', () => {
  it('spawns traffic over time up to the cap', () => {
    const sim = createGroundSim([], { graph, guard, spawn })
    expect(sim.snapshot().aircraft.length).toBe(0)
    for (let i = 0; i < 400; i += 1) sim.step(0.1) // 40s → several spawn windows
    expect(sim.snapshot().aircraft.length).toBeGreaterThan(0)
    expect(sim.snapshot().aircraft.length).toBeLessThanOrEqual(spawn.maxAircraft)
  })

  it('is deterministic for a given seed', () => {
    const run = () => {
      const sim = createGroundSim([], { graph, guard, spawn })
      for (let i = 0; i < 300; i += 1) sim.step(0.1)
      return sim.snapshot().aircraft.map((a) => `${a.intent}:${a.gate}`)
    }
    expect(run()).toEqual(run())
  })

  it('a departure that reaches the runway is counted and removed', () => {
    const dep: AircraftInit = {
      id: 'd',
      callsign: 'TST1',
      type: 'B738',
      wake: 'M',
      path: [[0.2, -0.2]],
      targetSpeed: 0,
      intent: 'departure',
      goalPoint: [1.8, -0.02],
      gate: 'A1',
    }
    const sim = createGroundSim([dep], { graph, guard })
    sim.dispatch({ type: 'taxiToGoal', aircraftId: 'd' })
    // drive ~1.6 nm to hold short, then contact tower to take off (long taxi → many steps)
    for (let i = 0; i < 6000; i += 1) {
      sim.step(0.1)
      const ac = sim.snapshot().aircraft[0]
      if (ac?.holdShort) {
        sim.dispatch({ type: 'contactTower', aircraftId: 'd' }) // Ground → Tower handoff
        sim.dispatch({ type: 'clearedForTakeoff', aircraftId: 'd' }) // then release the takeoff
      }
      if (sim.snapshot().departed > 0) break
    }
    const snap = sim.snapshot()
    expect(snap.departed).toBe(1)
    expect(snap.aircraft.find((a) => a.id === 'd')).toBeUndefined()
  })
})

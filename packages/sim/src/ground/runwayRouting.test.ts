import { describe, it, expect } from 'vitest'
import { createGroundSim } from './sim'
import type { AircraftInit } from './sim'
import { buildTaxiGraph } from './taxiGraph'
import { buildRunwayGuard } from './runwayGuard'
import type { AirportSurface } from '../world/types'

// Runway along y=0. A south taxiway and a north taxiway both reach the east end, plus a
// connector that crosses the runway. The node nearest the east threshold is on the NORTH
// side, so a naive nearestNode() would route a south aircraft across the runway.
const surface: AirportSurface = {
  icao: 'T',
  name: 'T',
  ref: { lat: 0, lon: 0, elevationFt: 0 },
  units: 'nm',
  source: 'x',
  bounds: { minX: -1, minY: -0.2, maxX: 1, maxY: 0.2 },
  features: [
    { kind: 'runway', points: [[-1, 0], [1, 0]] },
    { kind: 'taxiway', points: [[-0.5, -0.1], [0, -0.1], [0.9, -0.06]] }, // south, reaches (0.9,-0.06)
    { kind: 'taxiway', points: [[0, 0.1], [0.95, 0.03]] }, // north, reaches (0.95,0.03) — nearer to (1,0)
    { kind: 'taxiway', points: [[0, -0.1], [0, 0.1]] }, // crosses the runway
  ],
}

describe('runway routing', () => {
  it('routes a departure to its own-side hold short at the threshold, not across the runway', () => {
    const graph = buildTaxiGraph(surface)
    const guard = buildRunwayGuard(surface)
    const dep: AircraftInit = {
      id: 'd',
      callsign: 'D',
      type: 'B738',
      wake: 'M',
      path: [[-0.5, -0.1]], // south of the runway
      targetSpeed: 0,
      intent: 'departure',
      goalPoint: [1, 0],
    }
    const sim = createGroundSim([dep], { graph, guard })
    sim.dispatch({ type: 'taxiTo', aircraftId: 'd', dest: [1, 0], exact: true }) // east threshold

    for (let i = 0; i < 4000; i += 1) sim.step(0.1)
    const a = sim.snapshot().aircraft.find((x) => x.id === 'd')!
    expect(a.holdShort).toBe(true)
    expect(a.x).toBeGreaterThan(0.8) // reached the east end (not stopped mid-field at the crossing)
    expect(a.y).toBeLessThan(0) // stayed on the south side — never crossed the runway
  })
})

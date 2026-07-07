import { describe, it, expect } from 'vitest'
import { createGroundSim } from './sim'
import type { AircraftInit } from './sim'
import { buildTaxiGraph } from './taxiGraph'
import { buildRunwayGuard, onRunway } from './runwayGuard'
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

  // Runway along y=0. A taxiway runs from a node ON the centerline (0,0) out to an
  // off-runway node (1,-0.05) beside the east threshold, then a short connector touches
  // the threshold node (1,0) — which sits ON the runway and is therefore the nearest
  // graph node to the destination (1,0).
  const centerlineSurface: AirportSurface = {
    icao: 'T',
    name: 'T',
    ref: { lat: 0, lon: 0, elevationFt: 0 },
    units: 'nm',
    source: 'x',
    bounds: { minX: -1, minY: -0.2, maxX: 1, maxY: 0.2 },
    features: [
      { kind: 'runway', points: [[-1, 0], [1, 0]] },
      { kind: 'taxiway', points: [[0, 0], [1, -0.05]] }, // centerline node → off-runway node
      { kind: 'taxiway', points: [[1, -0.05], [1, 0]] }, // connector to the on-runway threshold node
    ],
  }

  it('routes to an off-runway hold-short node even when starting exactly on the centerline', () => {
    // When `from` is exactly on the runway centerline the own-side test (ccw sign) is 0,
    // which used to make the own-side filter vacuous and fall through to nearestNode() —
    // returning the ON-runway threshold node and planning a spurious runway crossing to
    // reach a point the adjacent off-runway node already serves.
    const graph = buildTaxiGraph(centerlineSurface)
    const guard = buildRunwayGuard(centerlineSurface)
    const dep: AircraftInit = {
      id: 'd',
      callsign: 'D',
      type: 'B738',
      wake: 'M',
      path: [[0, 0]], // parked exactly on the runway centerline
      targetSpeed: 0,
    }
    const sim = createGroundSim([dep], { graph, guard })
    sim.dispatch({ type: 'taxiTo', aircraftId: 'd', dest: [1, 0] }) // east threshold, on the runway

    for (let i = 0; i < 4000; i += 1) sim.step(0.1)
    const a = sim.snapshot().aircraft.find((x) => x.id === 'd')!

    // It comes to rest off the runway...
    expect(onRunway([a.x, a.y], guard)).toBe(false)
    // ...and does not plan a spurious crossing onto the runway to "finish" the route.
    const remaining = sim.routeOf('d')
    expect(remaining.some((p) => onRunway(p, guard))).toBe(false)
  })
})

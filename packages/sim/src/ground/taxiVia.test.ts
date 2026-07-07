import { describe, it, expect } from 'vitest'
import { createGroundSim } from './sim'
import { buildTaxiGraph } from './taxiGraph'
import type { AirportSurface } from '../world/types'

// Two named routes from S(0,0) to G(0.4,0): 'A' over the top, 'B' underneath.
const diamond: AirportSurface = {
  icao: 'TEST',
  name: 'Test',
  ref: { lat: 0, lon: 0, elevationFt: 0 },
  units: 'nm',
  source: 'synthetic',
  bounds: { minX: -0.1, minY: -0.1, maxX: 0.4, maxY: 0.1 },
  features: [
    { kind: 'taxiway', points: [[0, 0], [0.2, 0.1], [0.4, 0]], ref: 'A' },
    { kind: 'taxiway', points: [[0, 0], [0.2, -0.1], [0.4, 0]], ref: 'B' },
  ],
}

describe('taxiVia', () => {
  it('routes an aircraft along the assigned taxiway and reports it via taxiwaysOf', () => {
    const graph = buildTaxiGraph(diamond)
    const sim = createGroundSim(
      [{ id: 'a', callsign: 'AAL1', type: 'B738', wake: 'M', path: [[0, 0]], targetSpeed: 0 }],
      { graph },
    )

    sim.dispatch({ type: 'taxiVia', aircraftId: 'a', taxiways: ['B'], dest: [0.4, 0] })
    expect(sim.taxiwaysOf('a')).toEqual(['B'])

    // It should physically dip south (through the 'B' apex) rather than north.
    let minY = 0
    for (let i = 0; i < 2000; i += 1) {
      sim.step(0.1)
      minY = Math.min(minY, sim.snapshot().aircraft[0]!.y)
    }
    expect(minY).toBeLessThan(-0.05) // went via the southern 'B' route
    const done = sim.snapshot().aircraft[0]!
    expect(Math.hypot(done.x - 0.4, done.y)).toBeLessThan(0.02) // reached G
  })

  it('falls back to shortest path when the taxiway sequence cannot reach the goal', () => {
    const graph = buildTaxiGraph(diamond)
    const sim = createGroundSim(
      [{ id: 'a', callsign: 'AAL1', type: 'B738', wake: 'M', path: [[0, 0]], targetSpeed: 0 }],
      { graph },
    )
    // 'Z' is not a taxiway here → routeVia yields nothing → fall back to a shortest path.
    sim.dispatch({ type: 'taxiVia', aircraftId: 'a', taxiways: ['Z'], dest: [0.4, 0] })
    expect(sim.routeOf('a').length).toBeGreaterThanOrEqual(2)
    for (let i = 0; i < 2000; i += 1) sim.step(0.1)
    expect(Math.hypot(sim.snapshot().aircraft[0]!.x - 0.4, sim.snapshot().aircraft[0]!.y)).toBeLessThan(0.02)
  })
})

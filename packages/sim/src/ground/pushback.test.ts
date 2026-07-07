import { describe, it, expect } from 'vitest'
import { createGroundSim } from './sim'
import { buildTaxiGraph } from './taxiGraph'
import type { AirportSurface } from '../world/types'

// A gate stand set back from an L-shaped taxiway; the nearest taxi node is the alley.
const surface: AirportSurface = {
  icao: 'TEST',
  name: 'Test',
  ref: { lat: 0, lon: 0, elevationFt: 0 },
  units: 'nm',
  source: 'synthetic',
  bounds: { minX: -0.2, minY: -0.2, maxX: 0.6, maxY: 0.2 },
  features: [{ kind: 'taxiway', points: [[0, 0], [0.5, 0]] }],
}

describe('pushback', () => {
  it('backs a gate departure onto the taxilane, then it is ready to taxi', () => {
    const graph = buildTaxiGraph(surface)
    // Departure parked at a stand 0.05 nm south of the taxiway node at (0,0).
    const sim = createGroundSim(
      [{ id: 'a', callsign: 'AAL1', type: 'B738', wake: 'M', path: [[0, -0.05]], targetSpeed: 0, intent: 'departure', gate: '1' }],
      { graph },
    )
    expect(sim.snapshot().aircraft[0]!.status).toBe('parked')

    sim.dispatch({ type: 'pushback', aircraftId: 'a' })
    expect(sim.snapshot().aircraft[0]!.status).toBe('pushback')

    // Let the pushback run to completion.
    for (let i = 0; i < 600; i += 1) sim.step(0.1)
    const a = sim.snapshot().aircraft[0]!
    expect(a.status).toBe('holding') // finished pushing, stopped on the taxilane, ready to taxi
    expect(a.groundspeed).toBe(0)
    expect(Math.hypot(a.x - 0, a.y - 0)).toBeLessThan(0.01) // reached the alley node (0,0)

    // And it can now taxi normally.
    sim.dispatch({ type: 'taxiTo', aircraftId: 'a', dest: [0.5, 0] })
    for (let i = 0; i < 700; i += 1) sim.step(0.1)
    expect(sim.snapshot().aircraft[0]!.x).toBeGreaterThan(0.2)
  })

  it('ignores pushback for an aircraft that is already moving', () => {
    const graph = buildTaxiGraph(surface)
    const sim = createGroundSim(
      [{ id: 'a', callsign: 'AAL1', type: 'B738', wake: 'M', path: [[0, -0.05]], targetSpeed: 0, intent: 'departure', gate: '1' }],
      { graph },
    )
    sim.dispatch({ type: 'taxiTo', aircraftId: 'a', dest: [0.5, 0] })
    for (let i = 0; i < 50; i += 1) sim.step(0.1)
    expect(sim.snapshot().aircraft[0]!.status).toBe('taxi')
    sim.dispatch({ type: 'pushback', aircraftId: 'a' }) // no-op while taxiing
    expect(sim.snapshot().aircraft[0]!.status).toBe('taxi')
  })
})

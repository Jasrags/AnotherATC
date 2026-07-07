import { describe, it, expect } from 'vitest'
import { createGroundSim } from './sim'
import { buildTaxiGraph } from './taxiGraph'
import type { AirportSurface } from '../world/types'

const line: AirportSurface = {
  icao: 'TEST',
  name: 'Test',
  ref: { lat: 0, lon: 0, elevationFt: 0 },
  units: 'nm',
  source: 'synthetic',
  bounds: { minX: 0, minY: 0, maxX: 1, maxY: 0 },
  features: [{ kind: 'taxiway', points: [[0, 0], [0.5, 0], [1, 0]] }],
}

describe('GroundSim dispatch', () => {
  it('taxiTo routes a parked aircraft toward the destination', () => {
    const graph = buildTaxiGraph(line)
    const sim = createGroundSim(
      [{ id: 'a', callsign: 'AAL1', type: 'B738', wake: 'M', path: [[0, 0]], targetSpeed: 0 }],
      { graph },
    )
    expect(sim.snapshot().aircraft[0]!.holding).toBe(true)

    sim.dispatch({ type: 'taxiTo', aircraftId: 'a', dest: [1, 0] })
    expect(sim.routeOf('a').length).toBeGreaterThanOrEqual(2)

    for (let i = 0; i < 100; i += 1) sim.step(0.1) // 10s
    const ac = sim.snapshot().aircraft[0]!
    expect(ac.x).toBeGreaterThan(0) // it moved east toward [1,0]
    expect(ac.groundspeed).toBeGreaterThan(0)
  })

  it('hold stops a taxiing aircraft, resume restarts it', () => {
    const graph = buildTaxiGraph(line)
    const sim = createGroundSim(
      [{ id: 'a', callsign: 'AAL1', type: 'B738', wake: 'M', path: [[0, 0]], targetSpeed: 0 }],
      { graph },
    )
    sim.dispatch({ type: 'taxiTo', aircraftId: 'a', dest: [1, 0] })
    for (let i = 0; i < 30; i += 1) sim.step(0.1)
    expect(sim.snapshot().aircraft[0]!.groundspeed).toBeGreaterThan(0)

    sim.dispatch({ type: 'hold', aircraftId: 'a' })
    for (let i = 0; i < 60; i += 1) sim.step(0.1)
    const held = sim.snapshot().aircraft[0]!
    expect(held.groundspeed).toBe(0)
    expect(held.holding).toBe(true)

    sim.dispatch({ type: 'resume', aircraftId: 'a' })
    for (let i = 0; i < 30; i += 1) sim.step(0.1)
    expect(sim.snapshot().aircraft[0]!.groundspeed).toBeGreaterThan(0)
  })

  it('ignores taxiTo with no graph and unknown aircraft', () => {
    const sim = createGroundSim([
      { id: 'a', callsign: 'AAL1', type: 'B738', wake: 'M', path: [[0, 0]], targetSpeed: 0 },
    ])
    expect(() => sim.dispatch({ type: 'taxiTo', aircraftId: 'a', dest: [1, 0] })).not.toThrow()
    expect(() => sim.dispatch({ type: 'hold', aircraftId: 'ghost' })).not.toThrow()
    expect(sim.routeOf('ghost')).toEqual([])
  })
})

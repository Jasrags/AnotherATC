import { describe, it, expect } from 'vitest'
import { createGroundSim } from './sim'
import { buildRunwayGuard } from './runwayGuard'
import type { AirportSurface } from '../world/types'

const surface: AirportSurface = {
  icao: 'TEST',
  name: 'Test',
  ref: { lat: 0, lon: 0, elevationFt: 0 },
  units: 'nm',
  source: 'synthetic',
  bounds: { minX: -1, minY: -1, maxX: 1, maxY: 1 },
  features: [{ kind: 'runway', points: [[-1, 0], [1, 0]] }],
}
const guard = buildRunwayGuard(surface)

// A route from south of the runway to north of it, crossing at x=0.
const crossing = {
  id: 'a',
  callsign: 'AAL1',
  type: 'B738',
  wake: 'M' as const,
  path: [
    [0, -0.5],
    [0, -0.1],
    [0, 0.1],
    [0, 0.5],
  ] as const,
  targetSpeed: 15,
}

describe('hold-short of runway', () => {
  it('stops at the hold-short line and awaits a crossing clearance', () => {
    const sim = createGroundSim([crossing], undefined, guard)
    for (let i = 0; i < 1500; i += 1) sim.step(0.1) // 150s — reaches the hold line
    const ac = sim.snapshot().aircraft[0]!
    expect(ac.holdShort).toBe(true)
    expect(ac.groundspeed).toBe(0)
    expect(ac.y).toBeCloseTo(-0.1, 2) // stopped short of the runway (y=0)
    // the pending route across the runway is still exposed for display
    expect(sim.routeOf('a').length).toBeGreaterThanOrEqual(2)
  })

  it('crosses and continues once cleared', () => {
    const sim = createGroundSim([crossing], undefined, guard)
    for (let i = 0; i < 1500; i += 1) sim.step(0.1)
    expect(sim.snapshot().aircraft[0]!.holdShort).toBe(true)

    sim.dispatch({ type: 'crossRunway', aircraftId: 'a' })
    for (let i = 0; i < 2000; i += 1) sim.step(0.1) // cross + continue to the end
    const ac = sim.snapshot().aircraft[0]!
    expect(ac.holdShort).toBe(false)
    expect(ac.y).toBeCloseTo(0.5, 2) // reached the far end
  })

  it('crossRunway is a no-op when not holding short', () => {
    const sim = createGroundSim([crossing], undefined, guard)
    expect(() => sim.dispatch({ type: 'crossRunway', aircraftId: 'a' })).not.toThrow()
  })
})

import { describe, it, expect } from 'vitest'
import { createGroundSim } from './sim'
import type { AircraftInit } from './sim'

const straight: AircraftInit = {
  id: 'a',
  callsign: 'AAL1',
  type: 'B738',
  wake: 'M',
  path: [
    [0, 0],
    [0, 1], // 1 nm due north
  ],
  targetSpeed: 18,
}

describe('createGroundSim', () => {
  it('moves an aircraft along its route and heads toward the next waypoint', () => {
    const sim = createGroundSim([straight])
    sim.step(1)
    const ac = sim.snapshot().aircraft[0]!
    expect(ac.y).toBeGreaterThan(0) // moved north
    expect(ac.x).toBeCloseTo(0, 5)
    expect(ac.heading).toBeCloseTo(0, 3) // due north
    expect(ac.groundspeed).toBeGreaterThan(0)
  })

  it('stops and holds at the end of the route', () => {
    const sim = createGroundSim([straight])
    for (let i = 0; i < 3000; i += 1) sim.step(0.1) // 300s — plenty to cover 1 nm at 18 kt
    const ac = sim.snapshot().aircraft[0]!
    expect(ac.holding).toBe(true)
    expect(ac.groundspeed).toBe(0)
    expect(ac.y).toBeCloseTo(1, 3)
  })

  it('marks a single-point (parked) aircraft as holding immediately', () => {
    const sim = createGroundSim([{ ...straight, path: [[0.5, 0.5]], targetSpeed: 0 }])
    const ac = sim.snapshot().aircraft[0]!
    expect(ac.holding).toBe(true)
    expect(ac.x).toBe(0.5)
  })

  it('is deterministic: identical inputs produce identical snapshots', () => {
    const run = () => {
      const sim = createGroundSim([straight])
      for (let i = 0; i < 100; i += 1) sim.step(0.1)
      return sim.snapshot()
    }
    expect(run()).toEqual(run())
  })
})

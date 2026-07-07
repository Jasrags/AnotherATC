import { describe, it, expect } from 'vitest'
import { buildKsanGroundScenario } from './ksanScenario'
import { createGroundSim } from './sim'

describe('buildKsanGroundScenario', () => {
  it('produces a non-trivial fleet on real taxi routes', () => {
    const fleet = buildKsanGroundScenario(1)
    expect(fleet.length).toBeGreaterThanOrEqual(5)
    const taxiing = fleet.filter((a) => a.targetSpeed > 0)
    expect(taxiing.length).toBeGreaterThan(0)
    // Every taxiing aircraft has a multi-point stitched route.
    for (const a of taxiing) expect(a.path.length).toBeGreaterThanOrEqual(2)
  })

  it('is deterministic for a given seed', () => {
    expect(buildKsanGroundScenario(7)).toEqual(buildKsanGroundScenario(7))
  })

  it('drives movement when stepped', () => {
    const sim = createGroundSim(buildKsanGroundScenario(1))
    for (let i = 0; i < 300; i += 1) sim.step(0.1) // 30s
    const moving = sim.snapshot().aircraft.filter((a) => a.groundspeed > 0)
    expect(moving.length).toBeGreaterThan(0)
  })
})

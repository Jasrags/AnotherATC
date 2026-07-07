import { describe, it, expect } from 'vitest'
import { buildKsanGroundGame } from './ksanGame'
import { buildTaxiGraph } from './taxiGraph'
import { buildRunwayGuard } from './runwayGuard'
import { createGroundSim } from './sim'
import { KSAN_SURFACE } from '../world/ksan'

describe('KSAN ground game', () => {
  it('provides the terminal gates and runway destinations', () => {
    const { spawn, destinations } = buildKsanGroundGame(1)
    // 32 (T2) + 19 (T1) passenger gates
    expect(spawn.gates.length).toBeGreaterThanOrEqual(50)
    expect(destinations.map((d) => d.id)).toContain('rwy27')
  })

  it('a seeded departure can taxi off its gate toward the runway', () => {
    const graph = buildTaxiGraph(KSAN_SURFACE)
    const guard = buildRunwayGuard(KSAN_SURFACE)
    const { inits } = buildKsanGroundGame(1)
    const sim = createGroundSim(inits, { graph, guard })
    const id = inits[0]!.id
    const start = sim.snapshot().aircraft.find((a) => a.id === id)!

    sim.dispatch({ type: 'taxiToGoal', aircraftId: id })
    let moved = false
    for (let i = 0; i < 4000; i += 1) {
      sim.step(0.1)
      const a = sim.snapshot().aircraft.find((x) => x.id === id)
      if (a && Math.hypot(a.x - start.x, a.y - start.y) > 0.05) {
        moved = true
        break
      }
    }
    expect(moved).toBe(true)
  })
})

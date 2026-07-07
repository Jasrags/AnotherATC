import { describe, it, expect } from 'vitest'
import { createGroundSim } from './sim'
import type { AircraftInit } from './sim'

function taxiing(id: string, from: readonly [number, number], to: readonly [number, number]): AircraftInit {
  return { id, callsign: id, type: 'B738', wake: 'M', path: [from, to], targetSpeed: 15 }
}

describe('give way', () => {
  it('holds for the named traffic ahead, then continues once it has cleared', () => {
    const a = taxiing('a', [0, 0], [0, 0.5]) // northbound
    const b = taxiing('b', [0, 0.08], [0.6, 0.08]) // 0.08 nm ahead, crossing east and away
    const sim = createGroundSim([a, b])

    sim.dispatch({ type: 'giveWay', aircraftId: 'a', toId: 'b' })

    // While 'b' is near and ahead, 'a' holds in place.
    for (let i = 0; i < 30; i += 1) sim.step(0.1)
    let av = sim.snapshot().aircraft.find((x) => x.id === 'a')!
    expect(av.groundspeed).toBeLessThan(1)
    expect(av.y).toBeLessThan(0.01)
    expect(av.giveWayTo).toBe('b')

    // Once 'b' has crossed clear, 'a' resumes on its own and reaches its destination.
    for (let i = 0; i < 2000; i += 1) sim.step(0.1)
    av = sim.snapshot().aircraft.find((x) => x.id === 'a')!
    expect(av.y).toBeGreaterThan(0.3)
    expect(av.giveWayTo).toBeNull()
  })

  it('is a no-op when the named traffic is already behind', () => {
    const a = taxiing('a', [0, 0], [0, 0.5]) // northbound
    const b = taxiing('b', [0, -0.05], [0.5, -0.05]) // behind 'a'
    const sim = createGroundSim([a, b])
    sim.dispatch({ type: 'giveWay', aircraftId: 'a', toId: 'b' })
    for (let i = 0; i < 100; i += 1) sim.step(0.1)
    const av = sim.snapshot().aircraft.find((x) => x.id === 'a')!
    expect(av.y).toBeGreaterThan(0.02) // never held — traffic was behind
    expect(av.giveWayTo).toBeNull()
  })
})

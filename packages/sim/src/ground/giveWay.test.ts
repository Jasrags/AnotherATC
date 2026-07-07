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

  it('forgets the give-way when the traffic wanders far off without ever passing behind', () => {
    // 'a' holds position (targetSpeed 0) at the origin so it never moves; 'b' sits just
    // ahead of it, then drives far east. 'b' is always ahead (north), so `forward` stays
    // positive and the passed-behind branch never fires — the only way the give-way clears
    // is the distance branch (d > GIVEWAY_FORGET_NM ≈ 0.35 nm).
    const a: AircraftInit = { id: 'a', callsign: 'a', type: 'B738', wake: 'M', path: [[0, 0]], targetSpeed: 0 }
    const b = taxiing('b', [0, 0.08], [0.6, 0.08]) // 0.08 nm ahead, drives far east
    const sim = createGroundSim([a, b])
    sim.dispatch({ type: 'giveWay', aircraftId: 'a', toId: 'b' })

    let heldWhileNear = false
    let releasedByDistance = false
    for (let i = 0; i < 1200; i += 1) {
      sim.step(0.1)
      const snap = sim.snapshot()
      const av = snap.aircraft.find((x) => x.id === 'a')!
      const bv = snap.aircraft.find((x) => x.id === 'b')!
      if (av.giveWayTo === 'b' && Math.hypot(bv.x - av.x, bv.y - av.y) < 0.1) heldWhileNear = true
      // 'a' never moved and 'b' stayed north of it, so a release here is purely by distance.
      if (av.giveWayTo === null && bv.x > 0.34 && bv.y > av.y) releasedByDistance = true
    }

    const av = sim.snapshot().aircraft.find((x) => x.id === 'a')!
    expect(av.x).toBe(0) // 'a' held position the whole time
    expect(av.y).toBe(0)
    expect(heldWhileNear).toBe(true) // it was giving way while 'b' was near
    expect(av.giveWayTo).toBeNull() // then released
    expect(releasedByDistance).toBe(true) // …by distance, never having 'b' pass behind
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

import { describe, it, expect } from 'vitest'
import { createGroundSim } from './sim'
import type { AircraftInit } from './sim'

function taxiing(id: string, from: readonly [number, number], to: readonly [number, number]): AircraftInit {
  return { id, callsign: id, type: 'B738', wake: 'M', path: [from, to], targetSpeed: 15 }
}

describe('ground status ↔ holding consistency', () => {
  it("reports status 'holding' (not 'taxi') for an aircraft held mid-route by traffic", () => {
    // 'a' wants to taxi north but is told to give way to 'b' crossing just ahead, so it
    // hard-stops (cap 0) at the start of its route — stopped, but NOT at the end of it.
    // This is the exact case where the old statusOf() heuristic (keyed off the nominal
    // targetSpeed) diverged from the authoritative `holding` flag and mislabeled the
    // hold as 'taxi', silently breaking the flight-strip state machine.
    const a = taxiing('a', [0, 0], [0, 0.5])
    const b = taxiing('b', [0, 0.08], [0.6, 0.08]) // 0.08 nm ahead, crossing east
    const sim = createGroundSim([a, b])
    sim.dispatch({ type: 'giveWay', aircraftId: 'a', toId: 'b' })

    for (let i = 0; i < 20; i += 1) sim.step(0.1) // 'a' holds while 'b' is near and ahead

    const av = sim.snapshot().aircraft.find((x) => x.id === 'a')!
    expect(av.giveWayTo).toBe('b') // still giving way
    expect(av.groundspeed).toBe(0) // hard-stopped mid-route (leg 0 of a 2-leg path)
    expect(av.holding).toBe(true)
    expect(av.status).toBe('holding') // ...and the strip reflects the hold, not 'taxi'
  })

  it("reports status 'taxi' while an aircraft is actually rolling", () => {
    const a = taxiing('a', [0, 0], [0, 0.6])
    const sim = createGroundSim([a])
    for (let i = 0; i < 50; i += 1) sim.step(0.1) // spun up, moving

    const s = sim.snapshot().aircraft.find((x) => x.id === 'a')!
    expect(s.groundspeed).toBeGreaterThan(0)
    expect(s.holding).toBe(false)
    expect(s.status).toBe('taxi')
  })

  it("reports status 'parked' for an aircraft with no route yet (not 'holding')", () => {
    // Single-point path, never cleared to move: stopped, but parked — not holding.
    const parked: AircraftInit = { id: 'p', callsign: 'P', type: 'B738', wake: 'M', path: [[0, 0]], targetSpeed: 0 }
    const sim = createGroundSim([parked])
    for (let i = 0; i < 20; i += 1) sim.step(0.1)

    const s = sim.snapshot().aircraft.find((x) => x.id === 'p')!
    expect(s.holding).toBe(true) // physically stopped
    expect(s.status).toBe('parked') // but has no route → parked, not holding
  })
})

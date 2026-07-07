import { describe, it, expect } from 'vitest'
import { createGroundSim } from './sim'
import type { AircraftInit } from './sim'

function gateDeparture(id: string): AircraftInit {
  return { id, callsign: id, type: 'B738', wake: 'M', path: [[0, 0]], targetSpeed: 0, intent: 'departure', gate: '1' }
}

describe('clearance delivery', () => {
  it('assigns a squawk to a departure when clearance is delivered', () => {
    const sim = createGroundSim([gateDeparture('a')])
    expect(sim.snapshot().aircraft[0]!.squawk).toBeNull()

    sim.dispatch({ type: 'clearance', aircraftId: 'a' })
    const sq = sim.snapshot().aircraft[0]!.squawk
    expect(sq).toMatch(/^[0-7]{4}$/) // 4-digit octal beacon code

    // Re-delivering doesn't change the assigned code.
    sim.dispatch({ type: 'clearance', aircraftId: 'a' })
    expect(sim.snapshot().aircraft[0]!.squawk).toBe(sq)
  })

  it('gives different aircraft distinct, deterministic squawks', () => {
    const sim = createGroundSim([gateDeparture('a'), gateDeparture('b')])
    sim.dispatch({ type: 'clearance', aircraftId: 'a' })
    sim.dispatch({ type: 'clearance', aircraftId: 'b' })
    const [a, b] = sim.snapshot().aircraft
    expect(a!.squawk).not.toBe(b!.squawk)

    // Same seed/order → same codes.
    const sim2 = createGroundSim([gateDeparture('a'), gateDeparture('b')])
    sim2.dispatch({ type: 'clearance', aircraftId: 'a' })
    expect(sim2.snapshot().aircraft[0]!.squawk).toBe(a!.squawk)
  })
})

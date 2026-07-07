import { describe, it, expect } from 'vitest'
import { createGroundSim } from './sim'
import type { AircraftInit } from './sim'

/** An arrival taxiing from a runway exit toward its assigned gate. */
function arrival(id: string, from: readonly [number, number], gate: readonly [number, number]): AircraftInit {
  return {
    id,
    callsign: id,
    type: 'B738',
    wake: 'M',
    path: [from, gate],
    targetSpeed: 15,
    intent: 'arrival',
    goalPoint: gate,
    gate: 'G1',
  }
}

describe('arrival → gate completion', () => {
  it('parks at the gate, dwells, then clears the stand and counts as arrived', () => {
    const gate: [number, number] = [0, 0.1]
    const sim = createGroundSim([arrival('r', [0, 0], gate)])

    let sawParkedAtGate = false
    let removedAtTime = -1
    for (let i = 0; i < 600; i += 1) {
      sim.step(0.1)
      const snap = sim.snapshot()
      const r = snap.aircraft.find((a) => a.id === 'r')
      if (r && r.status === 'parked' && Math.hypot(r.x - gate[0], r.y - gate[1]) < 0.02) {
        sawParkedAtGate = true // reached the stand and is dwelling (status 'parked')
      }
      if (!r && removedAtTime < 0) removedAtTime = snap.time // despawned after the dwell
    }

    const final = sim.snapshot()
    expect(sawParkedAtGate).toBe(true) // it actually parked at the gate and dwelled
    expect(final.aircraft.find((a) => a.id === 'r')).toBeUndefined() // cleared the stand
    expect(final.arrived).toBe(1) // and was counted
    expect(final.departed).toBe(0)
    expect(removedAtTime).toBeGreaterThan(0)
  })

  it('does not count as arrived until the full gate dwell has elapsed', () => {
    const gate: [number, number] = [0, 0.1]
    const sim = createGroundSim([arrival('r', [0, 0], gate)])

    // Step just up to (but not through) the dwell: reach the gate, confirm it is parked
    // and still present with arrived === 0.
    let firstParkedStep = -1
    for (let i = 0; i < 600; i += 1) {
      sim.step(0.1)
      const r = sim.snapshot().aircraft.find((a) => a.id === 'r')
      if (r && r.status === 'parked') {
        firstParkedStep = i
        break
      }
    }
    expect(firstParkedStep).toBeGreaterThanOrEqual(0)

    // One extra second of dwell — the 8s dwell is not yet spent, so it is still on stand.
    for (let i = 0; i < 10; i += 1) sim.step(0.1)
    const mid = sim.snapshot()
    expect(mid.aircraft.find((a) => a.id === 'r')).toBeDefined()
    expect(mid.arrived).toBe(0)
  })
})

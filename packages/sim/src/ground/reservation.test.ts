import { describe, it, expect } from 'vitest'
import { createGroundSim } from './sim'
import { buildTaxiGraph } from './taxiGraph'
import type { AircraftInit } from './sim'
import type { AirportSurface } from '../world/types'

// An "H": a single one-lane corridor J1(0,0)—J2(0,0.3) with a stub at each corner,
// so the two aircraft enter and leave the corridor via different branches (their
// approach/exit edges are NOT the shared corridor).
//
//   Lstart(-0.1,0.3) ── J2(0,0.3) ── Wgoal(0.1,0.3)
//                        │  corridor
//   Wstart(-0.1,0) ──── J1(0,0)  ── Lgoal(0.1,0)
const H: AirportSurface = {
  icao: 'TEST',
  name: 'Test',
  ref: { lat: 0, lon: 0, elevationFt: 0 },
  units: 'nm',
  source: 'synthetic',
  bounds: { minX: -0.1, minY: 0, maxX: 0.1, maxY: 0.3 },
  features: [
    { kind: 'taxiway', points: [[0, 0], [0, 0.3]] }, // corridor J1–J2
    { kind: 'taxiway', points: [[-0.1, 0], [0, 0]] }, // Wstart–J1
    { kind: 'taxiway', points: [[0, 0.3], [0.1, 0.3]] }, // J2–Wgoal
    { kind: 'taxiway', points: [[-0.1, 0.3], [0, 0.3]] }, // Lstart–J2
    { kind: 'taxiway', points: [[0, 0], [0.1, 0]] }, // J1–Lgoal
  ],
}

function parked(id: string, at: readonly [number, number]): AircraftInit {
  return { id, callsign: id, type: 'B738', wake: 'M', path: [at], targetSpeed: 0 }
}

describe('segment reservation (hold at junction)', () => {
  it('holds the lower-priority aircraft short of a one-lane corridor until it clears', () => {
    const graph = buildTaxiGraph(H)
    // 'w' northbound through the corridor, 'l' southbound — nose-to-nose on J1–J2.
    const sim = createGroundSim([parked('w', [-0.1, 0]), parked('l', [-0.1, 0.3])], { graph })
    sim.dispatch({ type: 'taxiTo', aircraftId: 'w', dest: [0.1, 0.3] }) // Wstart→J1→J2→Wgoal
    sim.dispatch({ type: 'taxiTo', aircraftId: 'l', dest: [0.1, 0] }) // Lstart→J2→J1→Lgoal

    let minSep = Infinity
    let wWaitedShort = false // 'w' stopped before entering the corridor while 'l' used it
    for (let i = 0; i < 3000; i += 1) {
      sim.step(0.1)
      const snap = sim.snapshot()
      const w = snap.aircraft.find((a) => a.id === 'w')!
      const l = snap.aircraft.find((a) => a.id === 'l')!
      minSep = Math.min(minSep, Math.hypot(w.x - l.x, w.y - l.y))
      // short of the corridor = still west of J1 (x < 0), stopped, after the initial roll
      if (snap.time > 2 && w.groundspeed < 0.5 && w.x < -0.005) wWaitedShort = true
    }

    // 'l' outranks 'w' (id tiebreak) → 'w' gave way at the junction; they never overlapped.
    expect(wWaitedShort).toBe(true)
    expect(minSep).toBeGreaterThan(0.012)

    // The standoff clears: both reach their goals rather than freezing.
    const done = sim.snapshot().aircraft
    const w = done.find((a) => a.id === 'w')!
    const l = done.find((a) => a.id === 'l')!
    expect(Math.hypot(w.x - 0.1, w.y - 0.3)).toBeLessThan(0.02)
    expect(Math.hypot(l.x - 0.1, l.y - 0)).toBeLessThan(0.02)
  })

  it('lets a single aircraft cross the corridor unhindered (no false hold)', () => {
    const graph = buildTaxiGraph(H)
    const sim = createGroundSim([parked('w', [-0.1, 0])], { graph })
    sim.dispatch({ type: 'taxiTo', aircraftId: 'w', dest: [0.1, 0.3] })
    for (let i = 0; i < 2000; i += 1) sim.step(0.1)
    const w = sim.snapshot().aircraft.find((a) => a.id === 'w')!
    expect(Math.hypot(w.x - 0.1, w.y - 0.3)).toBeLessThan(0.02)
  })
})

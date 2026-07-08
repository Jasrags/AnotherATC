import { describe, it, expect } from 'vitest'
import { createGroundSim } from './sim'
import { buildTaxiGraph } from './taxiGraph'
import type { AircraftInit } from './sim'
import type { AirportSurface } from '../world/types'

// A "theta": the one-lane corridor J1(0,0)—J2(0,0.3) plus a parallel bypass arc
// J1—apex—J2 offset to the east. Two aircraft go nose-to-nose on the corridor; the
// lower-priority one can reroute onto the bypass instead of waiting the corridor out.
//
//   Lstart(-0.1,0.3) ── J2(0,0.3) ── Wgoal(0.1,0.3)
//                        │ \
//              corridor  │  apex   (bypass)
//                        │ /
//   Wstart(-0.1,0) ──── J1(0,0)  ── Lgoal(0.1,0)
function theta(apex: readonly [number, number]): AirportSurface {
  return {
    icao: 'TEST',
    name: 'Test',
    ref: { lat: 0, lon: 0, elevationFt: 0 },
    units: 'nm',
    source: 'synthetic',
    bounds: { minX: -0.1, minY: 0, maxX: Math.max(0.1, apex[0]), maxY: 0.3 },
    features: [
      { kind: 'taxiway', points: [[0, 0], [0, 0.3]], ref: 'COR' }, // corridor J1–J2
      { kind: 'taxiway', points: [[0, 0], [apex[0], apex[1]], [0, 0.3]], ref: 'BY' }, // bypass J1–apex–J2
      { kind: 'taxiway', points: [[-0.1, 0], [0, 0]] }, // Wstart–J1
      { kind: 'taxiway', points: [[0, 0.3], [0.1, 0.3]] }, // J2–Wgoal
      { kind: 'taxiway', points: [[-0.1, 0.3], [0, 0.3]] }, // Lstart–J2
      { kind: 'taxiway', points: [[0, 0], [0.1, 0]] }, // J1–Lgoal
    ],
  }
}

function parked(id: string, at: readonly [number, number]): AircraftInit {
  return { id, callsign: id, type: 'B738', wake: 'M', path: [at], targetSpeed: 0 }
}

/** Runs the nose-to-nose standoff; returns the max eastward reach of 'w' while it is
 *  between the two junction levels (≈0 if it took the corridor, ≈apex.x if it diverted)
 *  and whether both aircraft reached their goals. */
function runStandoff(apex: readonly [number, number]) {
  const graph = buildTaxiGraph(theta(apex))
  const sim = createGroundSim([parked('w', [-0.1, 0]), parked('l', [-0.1, 0.3])], { graph })
  sim.dispatch({ type: 'taxiTo', aircraftId: 'w', dest: [0.1, 0.3] }) // Wstart→…→Wgoal
  sim.dispatch({ type: 'taxiTo', aircraftId: 'l', dest: [0.1, 0] }) // Lstart→…→Lgoal

  let maxBandX = 0 // furthest east 'w' got while crossing between the junctions
  let minSep = Infinity
  for (let i = 0; i < 5000; i += 1) {
    sim.step(0.1)
    const snap = sim.snapshot()
    const w = snap.aircraft.find((a) => a.id === 'w')!
    const l = snap.aircraft.find((a) => a.id === 'l')!
    minSep = Math.min(minSep, Math.hypot(w.x - l.x, w.y - l.y))
    if (w.y > 0.05 && w.y < 0.25) maxBandX = Math.max(maxBandX, w.x)
  }
  const done = sim.snapshot().aircraft
  const w = done.find((a) => a.id === 'w')!
  const l = done.find((a) => a.id === 'l')!
  const bothReached =
    Math.hypot(w.x - 0.1, w.y - 0.3) < 0.02 && Math.hypot(l.x - 0.1, l.y - 0) < 0.02
  return { maxBandX, minSep, bothReached }
}

describe('parallel-taxiway diversion', () => {
  it('reroutes the yielder onto a nearby parallel taxiway instead of waiting', () => {
    // Bypass is only marginally longer than the corridor → within the cost cap.
    const { maxBandX, minSep, bothReached } = runStandoff([0.05, 0.15])
    expect(maxBandX).toBeGreaterThan(0.03) // 'w' swung east onto the bypass
    expect(minSep).toBeGreaterThan(0.012) // never overlapped
    expect(bothReached).toBe(true)
  })

  it('keeps waiting when the only alternative is a costly detour (cost cap)', () => {
    // Bypass apex far east → alt route > cost cap × direct → no diversion, just wait.
    const { maxBandX, minSep, bothReached } = runStandoff([0.6, 0.15])
    expect(maxBandX).toBeLessThan(0.03) // 'w' stayed on the corridor
    expect(minSep).toBeGreaterThan(0.012)
    expect(bothReached).toBe(true)
  })
})

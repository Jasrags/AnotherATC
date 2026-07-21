import { describe, it, expect } from 'vitest'
import { createGroundSim } from './sim'
import type { AircraftInit } from './sim'
import { buildRunwayGuard } from './runwayGuard'
import { buildTaxiGraph } from './taxiGraph'
import type { AirportSurface } from '../world/types'

// Runway along y=0. The departure holds short at y=-0.05, i.e. beside the runway, not on it.
const surface: AirportSurface = {
  icao: 'T',
  name: 'T',
  ref: { lat: 0, lon: 0, elevationFt: 0 },
  units: 'nm',
  source: 'x',
  bounds: { minX: -1, minY: -1, maxX: 1, maxY: 1 },
  features: [{ kind: 'runway', points: [[-1, 0], [1, 0]] }],
}
const guard = buildRunwayGuard(surface)

const departure = (id: string): AircraftInit => ({
  id,
  callsign: id,
  type: 'B738',
  wake: 'M',
  path: [[0, -0.5], [0, -0.1], [0, 0.1], [0, 0.5]],
  targetSpeed: 15,
  intent: 'departure',
  goalPoint: [0, 0],
})

const at = (sim: ReturnType<typeof createGroundSim>, id = 'd') =>
  sim.snapshot().aircraft.find((a) => a.id === id)!

/** Taxi out to the hold-short line and hand off to Tower. */
function holdingShort() {
  const sim = createGroundSim([departure('d')], { guard })
  for (let i = 0; i < 1500; i += 1) sim.step(0.1)
  sim.dispatch({ type: 'contactTower', aircraftId: 'd' })
  return sim
}

describe('taxi into position and roll', () => {
  it('a takeoff clearance from hold short lines up first — it never rolls from the taxiway', () => {
    const sim = holdingShort()
    const start = at(sim)
    expect(start.holdShort).toBe(true)
    expect(Math.abs(start.y)).toBeGreaterThan(0.01) // holding beside the runway, not on it

    expect(sim.dispatch({ type: 'clearedForTakeoff', aircraftId: 'd' })).toEqual({ ok: true })

    // Sample the whole run: it must be established on the centerline before it is ever fast.
    let offCenterlineWhileFast = 0
    for (let i = 0; i < 900; i += 1) {
      sim.step(0.1)
      const a = sim.snapshot().aircraft.find((x) => x.id === 'd')
      if (!a) break // lifted off
      if (a.groundspeed > 30 && Math.abs(a.y) > 0.01) offCenterlineWhileFast += 1
    }
    expect(offCenterlineWhileFast).toBe(0)
    expect(sim.snapshot().departed).toBe(1)
  })

  it('still rolls straight away when it is already lined up', () => {
    const sim = holdingShort()
    sim.dispatch({ type: 'lineUpAndWait', aircraftId: 'd' })
    for (let i = 0; i < 400; i += 1) sim.step(0.1)
    expect(at(sim).status).toBe('lineUpWait')

    sim.dispatch({ type: 'clearedForTakeoff', aircraftId: 'd' })
    for (let i = 0; i < 30; i += 1) sim.step(0.1)
    // Already on the centerline, so takeoff power applies immediately.
    expect(at(sim).status).toBe('departing')
    expect(at(sim).groundspeed).toBeGreaterThan(20)
  })
})

// The entry is charted where the graph has a node on the centerline — but a field may have none
// near where an aircraft is holding. Routing to the nearest one it *does* have then drives the
// aircraft away from the runway to get onto it, which is worse than simply pulling forward.
describe('lining up where the graph has no charted entry', () => {
  // Runway y=0; a parallel taxiway south of it; the ONLY node on the centerline is a mid-field
  // turnoff at x=1.1 — nowhere near the east-end hold-short spot at x=1.8.
  const field: AirportSurface = {
    icao: 'T2',
    name: 'T2',
    ref: { lat: 0, lon: 0, elevationFt: 0 },
    units: 'nm',
    source: 'x',
    bounds: { minX: 0, minY: -0.3, maxX: 2, maxY: 0 },
    features: [
      { kind: 'runway', points: [[0, 0], [2, 0]] },
      { kind: 'taxiway', ref: 'A', points: [[0.2, -0.2], [1.5, -0.2], [1.8, -0.2]] },
      { kind: 'taxiway', ref: 'E5', points: [[1.1, 0], [1.35, -0.12], [1.5, -0.2]] },
      { kind: 'taxiway', ref: 'E9', points: [[1.8, -0.2], [1.8, -0.02]] },
    ],
  }
  const east: AircraftInit = {
    id: 'd',
    callsign: 'd',
    type: 'B738',
    wake: 'M',
    path: [[1.8, -0.5], [1.8, -0.1], [1.8, 0.1], [1.8, 0.5]],
    targetSpeed: 15,
    intent: 'departure',
    goalPoint: [1.8, 0],
  }

  it('pulls straight forward onto the stripe instead of taxiing back to the only charted entry', () => {
    const sim = createGroundSim([east], {
      guard: buildRunwayGuard(field),
      graph: buildTaxiGraph(field),
    })
    for (let i = 0; i < 1500; i += 1) sim.step(0.1)
    sim.dispatch({ type: 'contactTower', aircraftId: 'd' })
    const held = at(sim)
    expect(held.holdShort).toBe(true)

    sim.dispatch({ type: 'lineUpAndWait', aircraftId: 'd' })
    // The route must go forward onto the runway, never back down the parallel to the turnoff.
    const route = sim.routeOf('d')
    expect(route.every((p) => p[0] > 1.5)).toBe(true)

    for (let i = 0; i < 600; i += 1) sim.step(0.1)
    const up = at(sim)
    expect(up.status).toBe('lineUpWait')
    expect(Math.abs(up.y)).toBeLessThan(0.01) // on the centerline
    expect(up.x).toBeGreaterThan(1.5) // at the end it was holding at, not mid-field
  })
})

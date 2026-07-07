import { describe, it, expect } from 'vitest'
import { createGroundSim } from './sim'
import type { AircraftInit } from './sim'
import { buildRunwayGuard } from './runwayGuard'
import type { AirportSurface } from '../world/types'

function taxiing(id: string, from: readonly [number, number], to: readonly [number, number]): AircraftInit {
  return { id, callsign: id, type: 'B738', wake: 'M', path: [from, to], targetSpeed: 15 }
}

describe('separation', () => {
  it('a follower stops behind a stopped leader instead of overrunning it', () => {
    // Leader stopped on the line at (0, 0.3) (a multi-point route it never rolls on);
    // follower taxis north up the same line toward it.
    const leader: AircraftInit = { id: 'lead', callsign: 'L', type: 'B738', wake: 'M', path: [[0, 0.3], [0, 0.35]], targetSpeed: 0 }
    const follower = taxiing('foll', [0, 0], [0, 0.6])
    const sim = createGroundSim([leader, follower])
    for (let i = 0; i < 3000; i += 1) sim.step(0.1)
    const l = sim.snapshot().aircraft.find((a) => a.id === 'lead')!
    const f = sim.snapshot().aircraft.find((a) => a.id === 'foll')!
    expect(f.y).toBeLessThan(l.y) // stayed behind the leader
    expect(l.y - f.y).toBeGreaterThan(0.015) // kept a gap (didn't overlap)
    expect(f.conflict).toBe(false)
  })

  it('does not slow for traffic on a parallel path (out of corridor)', () => {
    const a = taxiing('a', [0, 0], [0, 0.6])
    const b = taxiing('b', [0.1, 0.1], [0.1, 0.7]) // parallel, ~0.1 nm to the side
    const sim = createGroundSim([a, b])
    for (let i = 0; i < 200; i += 1) sim.step(0.1)
    const av = sim.snapshot().aircraft.find((x) => x.id === 'a')!
    expect(av.groundspeed).toBeGreaterThan(10) // unaffected, near full speed
  })

  it('refuses to clear an aircraft across an occupied runway', () => {
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
    // one aircraft sitting ON the runway; another holding short with a route across
    const onRwy: AircraftInit = { id: 'occ', callsign: 'O', type: 'B738', wake: 'M', path: [[0.3, 0]], targetSpeed: 0 }
    const crossing: AircraftInit = {
      id: 'x',
      callsign: 'X',
      type: 'B738',
      wake: 'M',
      path: [[0, -0.5], [0, -0.1], [0, 0.1], [0, 0.5]],
      targetSpeed: 15,
    }
    const sim = createGroundSim([onRwy, crossing], { guard })
    for (let i = 0; i < 1500; i += 1) sim.step(0.1) // reaches hold short
    expect(sim.snapshot().aircraft.find((a) => a.id === 'x')!.holdShort).toBe(true)
    sim.dispatch({ type: 'crossRunway', aircraftId: 'x' }) // runway occupied → refused
    for (let i = 0; i < 300; i += 1) sim.step(0.1)
    expect(sim.snapshot().aircraft.find((a) => a.id === 'x')!.holdShort).toBe(true) // still holding
  })
})

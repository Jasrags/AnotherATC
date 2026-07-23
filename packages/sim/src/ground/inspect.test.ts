import { describe, it, expect } from 'vitest'
import { createGroundSim, type AircraftInit } from './sim'
import { buildRunwayGuard } from './runwayGuard'
import type { AirportSurface } from '../world/types'

// One runway along y=0. A departure holds short beside it (y<0), with a route that either stops
// on the runway (a takeoff) or continues across it (a crossing) — the two cases inspect() exists
// to tell apart.
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

const toRunway = (id: string): AircraftInit => ({
  id,
  callsign: id,
  type: 'B738',
  wake: 'M',
  path: [[0, -0.5], [0, -0.1], [0, 0]], // ends on the runway centerline: a takeoff hold
  targetSpeed: 15,
  intent: 'departure',
  goalPoint: [0, 0],
})

const acrossRunway = (id: string): AircraftInit => ({
  id,
  callsign: id,
  type: 'B738',
  wake: 'M',
  path: [[0, -0.5], [0, -0.1], [0, 0.1], [0, 0.5]], // continues past the runway: a crossing hold
  targetSpeed: 15,
  intent: 'departure',
  goalPoint: [0, 0.5],
})

describe('inspect() surfaces internal routing state', () => {
  it('returns null for an unknown id', () => {
    const sim = createGroundSim([toRunway('d')], { guard })
    expect(sim.inspect('nobody')).toBeNull()
  })

  it('classifies a hold whose route ends on the runway as a takeoff hold', () => {
    const sim = createGroundSim([toRunway('d')], { guard })
    for (let i = 0; i < 1500; i += 1) sim.step(0.1)
    const d = sim.inspect('d')!
    expect(d.holdShort).toBe(true)
    expect(d.holdingForTakeoff).toBe(true)
    expect(d.heldRouteCrosses).toBe(false)
  })

  it('classifies a hold whose route continues past the runway as a crossing', () => {
    const sim = createGroundSim([acrossRunway('d')], { guard })
    for (let i = 0; i < 1500; i += 1) sim.step(0.1)
    const d = sim.inspect('d')!
    expect(d.holdShort).toBe(true)
    // Route ends on the far side, so this is a crossing, not a takeoff — the distinction the
    // real bug turns on. Here the goal is off the runway, so the sim gets it right; the field
    // case that fooled it is a departure whose goal is the *far departure start*, which sits on
    // the runway even though the aircraft must cross to reach it.
    expect(d.heldRouteCrosses).toBe(true)
    expect(d.holdingForTakeoff).toBe(false)
    expect(d.held).not.toBeNull()
  })
})

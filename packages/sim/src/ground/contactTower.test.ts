import { describe, it, expect } from 'vitest'
import { createGroundSim } from './sim'
import type { AircraftInit } from './sim'
import { buildRunwayGuard } from './runwayGuard'
import type { AirportSurface } from '../world/types'

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

// A departure taxiing north up to (and onto) the runway at y=0; its goal is the runway.
function departure(id: string): AircraftInit {
  return {
    id,
    callsign: id,
    type: 'B738',
    wake: 'M',
    path: [[0, -0.5], [0, -0.1], [0, 0.1], [0, 0.5]],
    targetSpeed: 15,
    intent: 'departure',
    goalPoint: [0, 0],
  }
}

describe('contact tower', () => {
  it('hands off a departure holding short — released onto the runway, counted as departed', () => {
    const sim = createGroundSim([departure('d')], { guard })
    for (let i = 0; i < 1500; i += 1) sim.step(0.1) // taxi up to the hold short
    expect(sim.snapshot().aircraft.find((a) => a.id === 'd')!.holdShort).toBe(true)

    sim.dispatch({ type: 'contactTower', aircraftId: 'd' }) // handoff → takeoff roll
    expect(sim.snapshot().aircraft.find((a) => a.id === 'd')!.status).toBe('departing')
    // Rolling: it accelerates well past taxi speed down the runway.
    for (let i = 0; i < 100; i += 1) sim.step(0.1)
    const rolling = sim.snapshot().aircraft.find((a) => a.id === 'd')
    expect(rolling && rolling.groundspeed).toBeGreaterThan(40)
    // Lifts off the far end and leaves the ground scope, counted as departed.
    for (let i = 0; i < 1000; i += 1) sim.step(0.1)
    expect(sim.snapshot().aircraft.find((a) => a.id === 'd')).toBeUndefined()
    expect(sim.snapshot().departed).toBe(1)
  })

  it('refuses a takeoff when the aircraft is only crossing the runway (no goal on it)', () => {
    // A departure whose route continues past the runway to the far side — a crossing, not a
    // takeoff. It holds short like any runway-crossing; contactTower must not launch it.
    const crossing: AircraftInit = {
      id: 'x',
      callsign: 'X',
      type: 'B738',
      wake: 'M',
      path: [[0, -0.5], [0, -0.1], [0, 0.1], [0, 0.5]], // crosses y=0, ends beyond it
      targetSpeed: 15,
      intent: 'departure',
      // no goalPoint → the runway is transit, not the destination
    }
    const sim = createGroundSim([crossing], { guard })
    for (let i = 0; i < 1500; i += 1) sim.step(0.1)
    expect(sim.snapshot().aircraft.find((a) => a.id === 'x')!.holdShort).toBe(true)

    const res = sim.dispatch({ type: 'contactTower', aircraftId: 'x' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toMatch(/cross/i)

    for (let i = 0; i < 300; i += 1) sim.step(0.1)
    const x = sim.snapshot().aircraft.find((a) => a.id === 'x')!
    expect(x.status).not.toBe('departing') // did not start a takeoff roll
    expect(x.holdShort).toBe(true) // still holding short, awaiting a crossing clearance
    expect(sim.snapshot().departed).toBe(0)

    // The correct clearance — cross runway — releases it across to the far side.
    expect(sim.dispatch({ type: 'crossRunway', aircraftId: 'x' }).ok).toBe(true)
    for (let i = 0; i < 1600; i += 1) sim.step(0.1) // ~0.5 nm across at 15 kt
    const done = sim.snapshot().aircraft.find((a) => a.id === 'x')!
    expect(done.y).toBeGreaterThan(0.4) // taxied across to the far side
    expect(sim.snapshot().departed).toBe(0) // never counted as a departure
  })

  it('refuses the handoff while the runway is occupied', () => {
    const onRwy: AircraftInit = { id: 'occ', callsign: 'O', type: 'B738', wake: 'M', path: [[0.3, 0]], targetSpeed: 0 }
    const sim = createGroundSim([onRwy, departure('d')], { guard })
    for (let i = 0; i < 1500; i += 1) sim.step(0.1)
    expect(sim.snapshot().aircraft.find((a) => a.id === 'd')!.holdShort).toBe(true)

    sim.dispatch({ type: 'contactTower', aircraftId: 'd' }) // runway occupied → refused
    for (let i = 0; i < 300; i += 1) sim.step(0.1)
    expect(sim.snapshot().aircraft.find((a) => a.id === 'd')!.holdShort).toBe(true) // still holding
    expect(sim.snapshot().departed).toBe(0)
  })
})

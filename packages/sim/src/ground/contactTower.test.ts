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

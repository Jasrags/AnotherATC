import { describe, it, expect } from 'vitest'
import { createGroundSim } from './sim'
import type { AircraftInit } from './sim'
import { buildRunwayGuard } from './runwayGuard'
import type { AirportSurface } from '../world/types'
import type { WakeCategory } from './types'

// Runway along y=0. Departures taxi north across it and hold short on the south side.
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

// A departure taxiing north to the runway at column x. Leader sits east of the follower so
// its eastbound takeoff roll moves away from the follower (isolating the wake gate from the
// runway-occupied gate once the leader has lifted off).
function departure(id: string, x: number, wake: WakeCategory): AircraftInit {
  return {
    id,
    callsign: id,
    type: wake === 'H' ? 'B763' : 'B738',
    wake,
    path: [[x, -0.5], [x, -0.1], [x, 0.1], [x, 0.5]],
    targetSpeed: 15,
    intent: 'departure',
    goalPoint: [x, 0],
  }
}

function runUntilDeparted(sim: ReturnType<typeof createGroundSim>, want: number): void {
  for (let i = 0; i < 3000 && sim.snapshot().departed < want; i += 1) sim.step(0.1)
}

describe('wake-turbulence departure gate', () => {
  it('holds a follower behind a Heavy departure until the wake interval elapses', () => {
    const lead = departure('lead', -0.3, 'H') // Heavy, departs east
    const foll = departure('foll', -0.6, 'M') // Medium, further west, holds short
    const sim = createGroundSim([lead, foll], { guard })
    for (let i = 0; i < 1500; i += 1) sim.step(0.1) // both taxi up to hold short
    expect(sim.snapshot().aircraft.find((a) => a.id === 'lead')!.holdShort).toBe(true)
    expect(sim.snapshot().aircraft.find((a) => a.id === 'foll')!.holdShort).toBe(true)

    expect(sim.dispatch({ type: 'contactTower', aircraftId: 'lead' })).toEqual({ ok: true })
    const t0 = sim.snapshot().time // wake clock starts at the leader's roll
    runUntilDeparted(sim, 1) // leader lifts off and clears the runway
    expect(sim.snapshot().departed).toBe(1)

    // Runway is clear, but the Heavy's wake still holds the Medium (needs 120s).
    expect(sim.snapshot().time - t0).toBeLessThan(120)
    const early = sim.dispatch({ type: 'contactTower', aircraftId: 'foll' })
    expect(early.ok).toBe(false)
    if (!early.ok) expect(early.reason).toMatch(/wake.*heavy/i)
    expect(sim.snapshot().aircraft.find((a) => a.id === 'foll')!.status).not.toBe('departing')

    // Once 120s have passed since the leader's roll, the release is accepted.
    for (let i = 0; i < 3000 && sim.snapshot().time - t0 < 120; i += 1) sim.step(0.1)
    expect(sim.dispatch({ type: 'contactTower', aircraftId: 'foll' })).toEqual({ ok: true })
    expect(sim.snapshot().aircraft.find((a) => a.id === 'foll')!.status).toBe('departing')
  })

  it('imposes no wake gate behind a Medium departure', () => {
    const lead = departure('lead', -0.3, 'M')
    const foll = departure('foll', -0.6, 'M')
    const sim = createGroundSim([lead, foll], { guard })
    for (let i = 0; i < 1500; i += 1) sim.step(0.1)

    expect(sim.dispatch({ type: 'contactTower', aircraftId: 'lead' })).toEqual({ ok: true })
    runUntilDeparted(sim, 1)
    // No wake wait behind a Medium — the follower may roll as soon as the runway is clear.
    expect(sim.snapshot().aircraft.find((a) => a.id === 'foll')!.wakeHoldSec).toBe(0)
    expect(sim.dispatch({ type: 'contactTower', aircraftId: 'foll' })).toEqual({ ok: true })
    expect(sim.snapshot().aircraft.find((a) => a.id === 'foll')!.status).toBe('departing')
  })

  it('reports a wake countdown on the holding-short follower that ticks down to zero', () => {
    const lead = departure('lead', -0.3, 'H')
    const foll = departure('foll', -0.6, 'M')
    const sim = createGroundSim([lead, foll], { guard })
    for (let i = 0; i < 1500; i += 1) sim.step(0.1)
    expect(sim.snapshot().aircraft.find((a) => a.id === 'foll')!.wakeHoldSec).toBe(0) // nothing departed yet

    sim.dispatch({ type: 'contactTower', aircraftId: 'lead' })
    const t0 = sim.snapshot().time
    runUntilDeparted(sim, 1)

    const foll1 = sim.snapshot().aircraft.find((a) => a.id === 'foll')!
    expect(foll1.wakeHoldSec).toBeGreaterThan(0)
    expect(foll1.wakeHoldSec).toBeLessThanOrEqual(120)

    for (let i = 0; i < 200; i += 1) sim.step(0.1) // +20s — countdown falls
    const foll2 = sim.snapshot().aircraft.find((a) => a.id === 'foll')!
    expect(foll2.wakeHoldSec).toBeLessThan(foll1.wakeHoldSec)

    for (let i = 0; i < 3000 && sim.snapshot().time - t0 < 120; i += 1) sim.step(0.1)
    expect(sim.snapshot().aircraft.find((a) => a.id === 'foll')!.wakeHoldSec).toBe(0) // interval elapsed
  })
})

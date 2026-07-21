import { describe, it, expect } from 'vitest'
import { createGroundSim } from './sim'
import type { AircraftInit } from './sim'
import { buildRunwayGuard } from './runwayGuard'
import { buildTaxiGraph } from './taxiGraph'
import type { AirportSurface } from '../world/types'

// Runway along y=0; a departure taxis north up to (and onto) it with its goal on the runway.
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

function departure(id: string, x = 0): AircraftInit {
  return {
    id,
    callsign: id,
    type: 'B738',
    wake: 'M',
    path: [[x, -0.5], [x, -0.1], [x, 0.1], [x, 0.5]],
    targetSpeed: 15,
    intent: 'departure',
    goalPoint: [x, 0],
  }
}

const A = (sim: ReturnType<typeof createGroundSim>, id: string) =>
  sim.snapshot().aircraft.find((a) => a.id === id)!
const taxiToHoldShort = (sim: ReturnType<typeof createGroundSim>) => {
  for (let i = 0; i < 1500; i += 1) sim.step(0.1)
}

describe('tower — departures', () => {
  it('contactTower transfers a departure to Tower without launching it', () => {
    const sim = createGroundSim([departure('d')], { guard })
    taxiToHoldShort(sim)
    expect(A(sim, 'd').holdShort).toBe(true)
    expect(A(sim, 'd').controlledBy).toBe('ground')

    expect(sim.dispatch({ type: 'contactTower', aircraftId: 'd' })).toEqual({ ok: true })
    const d = A(sim, 'd')
    expect(d.controlledBy).toBe('tower')
    expect(d.status).toBe('holdShort') // still holding short — a frequency change, not a takeoff

    for (let i = 0; i < 300; i += 1) sim.step(0.1)
    expect(A(sim, 'd').status).not.toBe('departing')
    expect(sim.snapshot().departed).toBe(0)
  })

  it('line up and wait moves onto the runway centerline and holds there', () => {
    const sim = createGroundSim([departure('d')], { guard })
    taxiToHoldShort(sim)
    sim.dispatch({ type: 'contactTower', aircraftId: 'd' })

    expect(sim.dispatch({ type: 'lineUpAndWait', aircraftId: 'd' })).toEqual({ ok: true })
    for (let i = 0; i < 400; i += 1) sim.step(0.1) // taxi onto the runway and settle
    const d = A(sim, 'd')
    expect(d.status).toBe('lineUpWait')
    expect(Math.abs(d.y)).toBeLessThan(0.02) // lined up on the runway centerline (y ≈ 0)
    expect(d.groundspeed).toBeLessThanOrEqual(1) // stopped, waiting for clearance
    expect(sim.snapshot().departed).toBe(0)
  })

  it('lines up onto the runway where it holds, not at a far departure-runway goal', () => {
    // A dev-spawned departure holds short mid-runway (x≈0) but its goal is the far east
    // threshold ([0.9,0]). Line-up must move it onto the runway in front of it (x≈0), not
    // teleport it toward the goal end.
    const dep: AircraftInit = {
      id: 'd', callsign: 'd', type: 'B738', wake: 'M',
      path: [[0, -0.5], [0, -0.1], [0, 0.1], [0, 0.5]],
      targetSpeed: 15, intent: 'departure', goalPoint: [0.9, 0],
    }
    const sim = createGroundSim([dep], { guard })
    taxiToHoldShort(sim)
    expect(A(sim, 'd').holdShort).toBe(true)
    expect(sim.dispatch({ type: 'contactTower', aircraftId: 'd' })).toEqual({ ok: true }) // goal on runway → a takeoff hold
    expect(sim.dispatch({ type: 'lineUpAndWait', aircraftId: 'd' })).toEqual({ ok: true })
    for (let i = 0; i < 400; i += 1) sim.step(0.1)
    const d = A(sim, 'd')
    expect(d.status).toBe('lineUpWait')
    expect(Math.abs(d.x)).toBeLessThan(0.1) // lined up where it held (x≈0), NOT near the goal x=0.9
    expect(Math.abs(d.y)).toBeLessThan(0.02) // on the centerline
  })

  it('cleared for takeoff from line-up-and-wait rolls and departs', () => {
    const sim = createGroundSim([departure('d')], { guard })
    taxiToHoldShort(sim)
    sim.dispatch({ type: 'contactTower', aircraftId: 'd' })
    sim.dispatch({ type: 'lineUpAndWait', aircraftId: 'd' })
    for (let i = 0; i < 200; i += 1) sim.step(0.1)

    expect(sim.dispatch({ type: 'clearedForTakeoff', aircraftId: 'd' })).toEqual({ ok: true })
    expect(A(sim, 'd').status).toBe('departing')
    for (let i = 0; i < 100; i += 1) sim.step(0.1)
    expect(A(sim, 'd').groundspeed).toBeGreaterThan(40)
    for (let i = 0; i < 1000; i += 1) sim.step(0.1)
    expect(sim.snapshot().aircraft.find((a) => a.id === 'd')).toBeUndefined()
    expect(sim.snapshot().departed).toBe(1)
  })

  it('cleared for takeoff directly from holding short (the fast path) also launches', () => {
    const sim = createGroundSim([departure('d')], { guard })
    taxiToHoldShort(sim)
    sim.dispatch({ type: 'contactTower', aircraftId: 'd' })
    expect(A(sim, 'd').status).toBe('holdShort')

    expect(sim.dispatch({ type: 'clearedForTakeoff', aircraftId: 'd' })).toEqual({ ok: true })
    expect(A(sim, 'd').status).toBe('departing')
    for (let i = 0; i < 1100; i += 1) sim.step(0.1)
    expect(sim.snapshot().departed).toBe(1)
  })

  it('refuses line-up / takeoff until the aircraft has been handed off to Tower', () => {
    const sim = createGroundSim([departure('d')], { guard })
    taxiToHoldShort(sim)

    const luaw = sim.dispatch({ type: 'lineUpAndWait', aircraftId: 'd' })
    expect(luaw.ok).toBe(false)
    if (!luaw.ok) expect(luaw.reason).toMatch(/tower/i)
    const cto = sim.dispatch({ type: 'clearedForTakeoff', aircraftId: 'd' })
    expect(cto.ok).toBe(false)
    if (!cto.ok) expect(cto.reason).toMatch(/tower/i)
    expect(A(sim, 'd').status).toBe('holdShort')
  })

  it('refuses line-up and takeoff while another aircraft occupies the runway', () => {
    const onRwy: AircraftInit = { id: 'occ', callsign: 'O', type: 'B738', wake: 'M', path: [[0.3, 0]], targetSpeed: 0 }
    const sim = createGroundSim([onRwy, departure('d')], { guard })
    taxiToHoldShort(sim)
    sim.dispatch({ type: 'contactTower', aircraftId: 'd' })

    const luaw = sim.dispatch({ type: 'lineUpAndWait', aircraftId: 'd' })
    expect(luaw.ok).toBe(false)
    if (!luaw.ok) expect(luaw.reason).toMatch(/occupied/i)
    const cto = sim.dispatch({ type: 'clearedForTakeoff', aircraftId: 'd' })
    expect(cto.ok).toBe(false)
    if (!cto.ok) expect(cto.reason).toMatch(/occupied/i)
    expect(sim.snapshot().departed).toBe(0)
  })

  it('a taxi clearance to a lined-up aircraft aborts the line-up (status is not stuck on lineUpWait)', () => {
    // Regression: applyRoute must clear lineUpWait/departing, else re-routing a lined-up
    // (or rolling) aircraft leaves the flag stuck and statusOf reports lineUpWait forever.
    // A scope click-to-taxi (GroundScope) can hit a Tower-owned aircraft, so this is reachable.
    // Needs a taxi graph: a taxiway running south up to the runway.
    const gSurface: AirportSurface = {
      ...surface,
      features: [
        { kind: 'runway', points: [[-1, 0], [1, 0]] },
        { kind: 'taxiway', ref: 'A', points: [[0, -0.5], [0, -0.3], [0, -0.1]] },
      ],
    }
    const gGuard = buildRunwayGuard(gSurface)
    const gGraph = buildTaxiGraph(gSurface)
    const dep: AircraftInit = {
      id: 'd', callsign: 'd', type: 'B738', wake: 'M',
      path: [[0, -0.5]], targetSpeed: 0, intent: 'departure', goalPoint: [0, 0],
    }
    const sim = createGroundSim([dep], { graph: gGraph, guard: gGuard })
    sim.dispatch({ type: 'taxiToGoal', aircraftId: 'd' })
    for (let i = 0; i < 2000 && !A(sim, 'd').holdShort; i += 1) sim.step(0.1)
    expect(A(sim, 'd').holdShort).toBe(true)
    sim.dispatch({ type: 'contactTower', aircraftId: 'd' })
    sim.dispatch({ type: 'lineUpAndWait', aircraftId: 'd' })
    for (let i = 0; i < 400; i += 1) sim.step(0.1)
    expect(A(sim, 'd').status).toBe('lineUpWait')

    // Re-route it (e.g. a scope click-to-taxi) back down the taxiway. It must resume taxiing,
    // not stay stuck on 'lineUpWait', and must never be spuriously counted as departed.
    expect(sim.dispatch({ type: 'taxiTo', aircraftId: 'd', dest: [0, -0.3] }).ok).toBe(true)
    for (let i = 0; i < 50; i += 1) sim.step(0.1)
    expect(A(sim, 'd').status).toBe('taxi')
    for (let i = 0; i < 600; i += 1) sim.step(0.1)
    expect(A(sim, 'd').status).not.toBe('lineUpWait')
    expect(sim.snapshot().departed).toBe(0)
  })

  it('enforces the wake interval through the line-up-and-wait path, not just the fast path', () => {
    const lead: AircraftInit = {
      id: 'lead',
      callsign: 'lead',
      type: 'B763',
      wake: 'H', // Heavy leader
      path: [[-0.3, -0.5], [-0.3, -0.1], [-0.3, 0.1], [-0.3, 0.5]],
      targetSpeed: 15,
      intent: 'departure',
      goalPoint: [-0.3, 0],
    }
    const foll = departure('foll', -0.6) // Medium follower, further west
    const sim = createGroundSim([lead, foll], { guard })
    taxiToHoldShort(sim)
    sim.dispatch({ type: 'contactTower', aircraftId: 'lead' })
    sim.dispatch({ type: 'clearedForTakeoff', aircraftId: 'lead' })
    const t0 = sim.snapshot().time
    for (let i = 0; i < 3000 && sim.snapshot().departed < 1; i += 1) sim.step(0.1)

    // Follower lines up while the Heavy's wake still holds it — the takeoff clearance is refused.
    sim.dispatch({ type: 'contactTower', aircraftId: 'foll' })
    expect(sim.dispatch({ type: 'lineUpAndWait', aircraftId: 'foll' }).ok).toBe(true)
    for (let i = 0; i < 200; i += 1) sim.step(0.1)
    expect(A(sim, 'foll').status).toBe('lineUpWait')
    const early = sim.dispatch({ type: 'clearedForTakeoff', aircraftId: 'foll' })
    expect(early.ok).toBe(false) // gated by wake even from LUAW
    if (!early.ok) expect(early.reason).toMatch(/wake.*heavy/i)
    expect(A(sim, 'foll').wakeHoldSec).toBeGreaterThan(0) // countdown reported while lined up

    // Once the interval elapses, the clearance is accepted from the line-up.
    for (let i = 0; i < 3000 && sim.snapshot().time - t0 < 120; i += 1) sim.step(0.1)
    expect(sim.dispatch({ type: 'clearedForTakeoff', aircraftId: 'foll' })).toEqual({ ok: true })
    expect(A(sim, 'foll').status).toBe('departing')
  })

  it('refuses to hand off a crossing aircraft, and cross-runway still releases it', () => {
    // A departure whose route continues past the runway to the far side — a crossing, not a
    // takeoff. contactTower must not take it; the controller clears it across instead.
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
    taxiToHoldShort(sim)
    expect(A(sim, 'x').holdShort).toBe(true)

    const res = sim.dispatch({ type: 'contactTower', aircraftId: 'x' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toMatch(/cross/i)
    expect(A(sim, 'x').controlledBy).toBe('ground') // never handed off

    expect(sim.dispatch({ type: 'crossRunway', aircraftId: 'x' }).ok).toBe(true)
    for (let i = 0; i < 1600; i += 1) sim.step(0.1) // ~0.5 nm across at 15 kt
    expect(A(sim, 'x').y).toBeGreaterThan(0.4) // taxied across to the far side
    expect(sim.snapshot().departed).toBe(0) // never counted as a departure
  })
})

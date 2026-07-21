import { describe, it, expect } from 'vitest'
import { createGroundSim } from './sim'
import type { AircraftInit } from './sim'
import { buildRunwayGuard } from './runwayGuard'
import { buildTaxiGraph } from './taxiGraph'
import type { AirportSurface, Point } from '../world/types'

// One runway (y=0, x 0→2), a parallel taxiway south of it, and two connectors up to the
// runway ends — enough for an arrival to land on 09, exit west, and taxi to the gate.
const surface: AirportSurface = {
  icao: 'TEST',
  name: 'Test',
  ref: { lat: 0, lon: 0, elevationFt: 0 },
  units: 'nm',
  source: 'synthetic',
  bounds: { minX: 0, minY: -0.3, maxX: 2, maxY: 0 },
  features: [
    { kind: 'runway', points: [[0, 0], [2, 0]] },
    { kind: 'taxiway', points: [[0.2, -0.2], [1, -0.2], [1.8, -0.2]] },
    { kind: 'taxiway', points: [[0.2, -0.2], [0.2, -0.02]] }, // west connector (RWY 9 exit)
    { kind: 'taxiway', points: [[1.8, -0.2], [1.8, -0.02]] }, // east connector
  ],
}
const guard = buildRunwayGuard(surface)
const graph = buildTaxiGraph(surface)

const GATE: Point = [0.2, -0.2]
const THRESHOLD: Point = [0, 0] // RWY 9, landing to the east
const FIX: Point = [-4, 0] // 4 nm final, on the extended centerline

/** An arrival established on final: airborne from the fix to the landing threshold. */
function arrivalOnFinal(id: string): AircraftInit {
  return {
    id,
    callsign: id,
    type: 'B738',
    wake: 'M',
    path: [FIX, THRESHOLD],
    targetSpeed: 140,
    airborne: true,
    intent: 'arrival',
    goalPoint: GATE,
    gate: 'A1',
  }
}

/** A departure taxiing north to hold short of the runway at x, with its goal on it. */
function departure(id: string, x = 1.8): AircraftInit {
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
  sim.snapshot().aircraft.find((a) => a.id === id)
const run = (sim: ReturnType<typeof createGroundSim>, steps: number) => {
  for (let i = 0; i < steps; i += 1) sim.step(0.1)
}

describe('arrivals on final', () => {
  it('spawns airborne on the extended centerline, owned by Tower', () => {
    const sim = createGroundSim([arrivalOnFinal('a')], { guard })
    const a = A(sim, 'a')!
    expect(a.status).toBe('onFinal')
    expect(a.controlledBy).toBe('tower')
    expect(a.altitude).toBeGreaterThan(1000)
    expect(a.finalNm).toBeCloseTo(4, 1)
    expect(a.onRunway).toBe(false) // airborne — not a surface occupant
  })

  it('descends toward the threshold deterministically', () => {
    const sim = createGroundSim([arrivalOnFinal('a')], { guard })
    const start = A(sim, 'a')!
    run(sim, 300) // 30 s of final
    const mid = A(sim, 'a')!
    expect(mid.x).toBeGreaterThan(start.x) // tracking inbound
    expect(mid.altitude).toBeLessThan(start.altitude) // and descending
    expect(mid.finalNm).toBeLessThan(start.finalNm)
    expect(mid.altitude).toBeGreaterThan(0) // still airborne 3 nm out

    const again = createGroundSim([arrivalOnFinal('a')], { guard })
    run(again, 300)
    expect(A(again, 'a')).toEqual(mid) // deterministic
  })

  it('goes around when it reaches the threshold without a landing clearance', () => {
    const sim = createGroundSim([arrivalOnFinal('a')], { guard })
    run(sim, 1100) // the full ~103 s final, never cleared
    const a = A(sim, 'a')!
    expect(a.status).toBe('onFinal') // re-established on a fresh final, not landed
    expect(a.altitude).toBeGreaterThan(1000)
    expect(a.finalNm).toBeGreaterThan(3)
    expect(sim.snapshot().arrived).toBe(0)
  })
})

describe('landing clearance', () => {
  it('cleared to land → touchdown at the threshold, then rollout on the runway', () => {
    const sim = createGroundSim([arrivalOnFinal('a')], { guard })
    run(sim, 200)
    expect(sim.dispatch({ type: 'clearedToLand', aircraftId: 'a' })).toEqual({ ok: true })
    expect(A(sim, 'a')!.status).toBe('landing')

    let sawRollout = false
    let touchdownX = -1
    for (let i = 0; i < 1000; i += 1) {
      sim.step(0.1)
      const a = A(sim, 'a')
      if (a?.status === 'rollout' && !sawRollout) {
        sawRollout = true
        touchdownX = a.x
      }
    }
    expect(sawRollout).toBe(true)
    expect(touchdownX).toBeCloseTo(THRESHOLD[0], 1) // touched down at the threshold
    const a = A(sim, 'a')!
    expect(a.altitude).toBe(0)
    expect(Math.abs(a.y)).toBeLessThan(0.02) // rolled out along the centerline
    expect(a.groundspeed).toBeLessThan(140) // and slowed down
  })

  it('refuses a landing clearance while a departure occupies the runway', () => {
    const sim = createGroundSim([arrivalOnFinal('a'), departure('d')], { guard })
    run(sim, 1500) // d taxis up and holds short
    expect(A(sim, 'd')!.holdShort).toBe(true)
    sim.dispatch({ type: 'contactTower', aircraftId: 'd' })
    sim.dispatch({ type: 'lineUpAndWait', aircraftId: 'd' })
    run(sim, 400) // d is now lined up on the runway
    expect(A(sim, 'd')!.status).toBe('lineUpWait')

    // The arrival went around meanwhile; clear it to land onto the occupied runway.
    const res = sim.dispatch({ type: 'clearedToLand', aircraftId: 'a' })
    expect(res).toEqual({ ok: false, reason: 'runway occupied' })
  })

  it('refuses a takeoff clearance and a line-up while an arrival is on short final', () => {
    const sim = createGroundSim([arrivalOnFinal('a'), departure('d')], { guard })
    run(sim, 1500)
    sim.dispatch({ type: 'contactTower', aircraftId: 'd' })
    sim.dispatch({ type: 'clearedToLand', aircraftId: 'a' })
    // Fly in to short final (< 1.5 nm from the threshold).
    for (let i = 0; i < 1200 && (A(sim, 'a')?.finalNm ?? 0) > 1; i += 1) sim.step(0.1)
    expect(A(sim, 'a')!.finalNm).toBeLessThan(1.5)

    expect(sim.dispatch({ type: 'lineUpAndWait', aircraftId: 'd' })).toEqual({
      ok: false,
      reason: 'runway occupied',
    })
    expect(sim.dispatch({ type: 'clearedForTakeoff', aircraftId: 'd' })).toEqual({
      ok: false,
      reason: 'runway occupied',
    })
  })

  it('refuses a landing clearance to anything but a Tower arrival on final', () => {
    const sim = createGroundSim([arrivalOnFinal('a'), departure('d')], { guard })
    expect(sim.dispatch({ type: 'clearedToLand', aircraftId: 'd' })).toEqual({
      ok: false,
      reason: 'only arrivals are cleared to land',
    })
    sim.dispatch({ type: 'clearedToLand', aircraftId: 'a' })
    expect(sim.dispatch({ type: 'clearedToLand', aircraftId: 'a' })).toEqual({
      ok: false,
      reason: 'already cleared to land',
    })
  })
})

describe('arrival end-to-end: final → land → exit → Ground → gate', () => {
  it('lands, is handed to Ground on rollout, taxis to its gate and counts as arrived', () => {
    const sim = createGroundSim([arrivalOnFinal('a')], { guard, graph })
    expect(sim.dispatch({ type: 'clearedToLand', aircraftId: 'a' })).toEqual({ ok: true })

    const seen = new Set<string>()
    let handedToGroundAt = -1
    for (let i = 0; i < 4000; i += 1) {
      sim.step(0.1)
      const a = A(sim, 'a')
      if (!a) break
      seen.add(a.status)
      if (a.controlledBy === 'ground' && handedToGroundAt < 0) handedToGroundAt = sim.snapshot().time
    }

    expect(seen.has('landing')).toBe(true)
    expect(seen.has('rollout')).toBe(true)
    expect(seen.has('taxi')).toBe(true) // handed to Ground and taxiing off the runway
    expect(handedToGroundAt).toBeGreaterThan(0)
    expect(A(sim, 'a')).toBeUndefined() // parked, dwelled, cleared the stand
    expect(sim.snapshot().arrived).toBe(1)
  })

  it('lets a waiting departure go once the arrival has cleared the runway', () => {
    const sim = createGroundSim([arrivalOnFinal('a'), departure('d')], { guard, graph })
    sim.dispatch({ type: 'clearedToLand', aircraftId: 'a' })
    run(sim, 1500)
    sim.dispatch({ type: 'contactTower', aircraftId: 'd' })

    // While the arrival is on the runway, the departure cannot be released.
    for (let i = 0; i < 2000; i += 1) {
      sim.step(0.1)
      const a = A(sim, 'a')
      if (!a || !a.onRunway) break
      expect(sim.dispatch({ type: 'clearedForTakeoff', aircraftId: 'd' })).toEqual({
        ok: false,
        reason: 'runway occupied',
      })
    }

    // Once it has exited, the runway is available again.
    expect(sim.dispatch({ type: 'clearedForTakeoff', aircraftId: 'd' })).toEqual({ ok: true })
    run(sim, 600)
    expect(sim.snapshot().departed).toBe(1)
  })
})

import { describe, it, expect } from 'vitest'
import { createGroundSim } from './sim'
import type { AircraftInit } from './sim'
import { buildRunwayGuard } from './runwayGuard'
import { buildTaxiGraph } from './taxiGraph'
import type { AirportSurface, Point } from '../world/types'

// A single runway with a connector crossing it mid-field — the minimum geometry for the
// situation this feature exists for: a crossing cleared while the inbound was still far out.
const surface: AirportSurface = {
  icao: 'TEST',
  name: 'Test',
  ref: { lat: 0, lon: 0, elevationFt: 0 },
  units: 'nm',
  source: 'synthetic',
  bounds: { minX: -0.5, minY: -0.5, maxX: 2, maxY: 0.5 },
  features: [
    { kind: 'runway', points: [[0, 0], [2, 0]] },
    // A connector crossing the runway at mid-field, with a parallel either side, so a taxi
    // clearance can actually be re-issued to an aircraft standing on the pavement.
    { kind: 'taxiway', ref: 'C1', points: [[1, -0.3], [1, -0.05], [1, 0.05], [1, 0.3]] },
    { kind: 'taxiway', ref: 'A', points: [[0.4, -0.3], [1, -0.3], [1.6, -0.3]] },
    { kind: 'taxiway', ref: 'B', points: [[0.4, 0.3], [1, 0.3], [1.6, 0.3]] },
  ],
}
const guard = buildRunwayGuard(surface)
const graph = buildTaxiGraph(surface)

const THRESHOLD: Point = [0, 0] // RWY 9, landing east
const FIX: Point = [-4, 0] // 4 nm final on the extended centerline

/** An aircraft taxiing north across the runway at mid-field. Its route is split at the
 *  hold-short line by the guard, exactly as a real taxi clearance would be. */
function crosser(id: string): AircraftInit {
  return {
    id,
    callsign: id,
    type: 'B738',
    wake: 'M',
    // Starts close to the line: at taxi speed a longer approach to it would burn most of the
    // inbound's four-mile final before the crossing clearance could even be issued.
    path: [[1, -0.15], [1, -0.1], [1, 0.1], [1, 0.4]],
    targetSpeed: 15,
    intent: 'departure',
  }
}

function arrival(id: string): AircraftInit {
  return {
    id,
    callsign: id,
    type: 'B738',
    wake: 'M',
    path: [FIX, THRESHOLD],
    targetSpeed: 140,
    airborne: true,
    intent: 'arrival',
    goalPoint: [1, -0.4],
  }
}

const A = (sim: ReturnType<typeof createGroundSim>, id: string) =>
  sim.snapshot().aircraft.find((a) => a.id === id)!
const run = (sim: ReturnType<typeof createGroundSim>, steps: number) => {
  for (let i = 0; i < steps; i += 1) sim.step(0.1)
}
/** Step until the predicate holds, or give up. Returns whether it ever held. */
function until(sim: ReturnType<typeof createGroundSim>, pred: () => boolean, steps = 4000): boolean {
  for (let i = 0; i < steps; i += 1) {
    sim.step(0.1)
    if (pred()) return true
  }
  return false
}

describe('runway incursion — end to end', () => {
  it('escalates a stopped crossing under an inbound, and clears once it is off the runway', () => {
    const sim = createGroundSim([crosser('x'), arrival('inb')], { guard })

    // Taxi up to the hold-short line. Nothing is wrong yet: it is short of the pavement.
    expect(until(sim, () => A(sim, 'x').holdShort)).toBe(true)
    expect(sim.snapshot().incursions).toEqual([])

    // The inbound is cleared to land while still well out — a normal clearance.
    expect(sim.dispatch({ type: 'clearedToLand', aircraftId: 'inb' }).ok).toBe(true)

    // …and so is the crossing, issued at 2.5 nm: outside short final, so the sim accepts it.
    expect(until(sim, () => A(sim, 'inb').finalNm <= 2.5)).toBe(true)
    expect(sim.dispatch({ type: 'crossRunway', aircraftId: 'x' }).ok).toBe(true)

    // Then the crossing stops on the runway — the thing that turns a good clearance bad.
    expect(until(sim, () => A(sim, 'x').onRunway)).toBe(true)
    expect(sim.dispatch({ type: 'hold', aircraftId: 'x' }).ok).toBe(true)
    run(sim, 30)

    // Advisory first, while the inbound still has room to be sent around.
    const alerts = sim.snapshot().incursions
    expect(alerts).toHaveLength(1)
    expect(alerts[0]!.kind).toBe('occupiedVsLanding')
    expect(alerts[0]!.severity).toBe('advisory')
    expect(alerts[0]!.occupantId).toBe('x')
    expect(alerts[0]!.conflictId).toBe('inb')
    expect(A(sim, 'x').incursion).toBe(true)
    expect(A(sim, 'inb').incursion).toBe(true)

    // It escalates to an alert as the inbound reaches short final.
    expect(until(sim, () => sim.snapshot().incursions[0]?.severity === 'alert')).toBe(true)
    expect(A(sim, 'inb').finalNm).toBeLessThanOrEqual(1.5)

    // Releasing the crossing resolves it: once it is off the pavement there is no conflict,
    // and neither aircraft is still ringed.
    expect(sim.dispatch({ type: 'resume', aircraftId: 'x' }).ok).toBe(true)
    expect(until(sim, () => !A(sim, 'x').onRunway)).toBe(true)
    run(sim, 1)
    expect(sim.snapshot().incursions).toEqual([])
    expect(A(sim, 'x').incursion).toBe(false)
    expect(A(sim, 'inb').incursion).toBe(false)
  })

  it('does not strip a crossing aircraft of its authority when it is rerouted mid-crossing', () => {
    // A reroute issued while the aircraft is on the pavement is still the crossing — it was
    // put there by us, and taking its permission away would ring it red for obeying.
    const sim = createGroundSim([crosser('x')], { guard, graph })
    expect(until(sim, () => A(sim, 'x').holdShort)).toBe(true)
    expect(sim.dispatch({ type: 'crossRunway', aircraftId: 'x' }).ok).toBe(true)
    expect(until(sim, () => A(sim, 'x').onRunway)).toBe(true)

    expect(sim.dispatch({ type: 'taxiTo', aircraftId: 'x', dest: [1.6, 0.3] }).ok).toBe(true)
    run(sim, 1)
    expect(A(sim, 'x').onRunway).toBe(true) // still on it, so the question is live
    expect(sim.snapshot().incursions).toEqual([])
    expect(A(sim, 'x').incursion).toBe(false)

    // …and it is spent once it is off, exactly as if it had never been rerouted.
    expect(until(sim, () => !A(sim, 'x').onRunway)).toBe(true)
    run(sim, 1)
    expect(sim.snapshot().incursions).toEqual([])
  })

  it('flags an aircraft sitting on the runway that was never cleared onto it', () => {
    const sim = createGroundSim([], { guard })
    sim.add({ id: 'ghost', callsign: 'GHOST', type: 'B738', wake: 'M', path: [[1, 0]], targetSpeed: 0 })
    run(sim, 5)

    const alerts = sim.snapshot().incursions
    expect(alerts).toHaveLength(1)
    expect(alerts[0]!.kind).toBe('unauthorized')
    expect(alerts[0]!.severity).toBe('alert')
    expect(A(sim, 'ghost').incursion).toBe(true)
  })

  it('does not flag an arrival taxiing off the runway after a normal landing', () => {
    // The landing itself, the rollout, and the taxi clear of the pavement are one movement:
    // the permission granted by the landing clearance has to survive the Tower→Ground handoff,
    // or every arrival would ring red on its way off the runway.
    const sim = createGroundSim([arrival('inb')], { guard })
    expect(sim.dispatch({ type: 'clearedToLand', aircraftId: 'inb' }).ok).toBe(true)
    expect(until(sim, () => A(sim, 'inb').status === 'rollout')).toBe(true)

    let flaggedOnce = false
    for (let i = 0; i < 3000; i += 1) {
      sim.step(0.1)
      if (sim.snapshot().incursions.length > 0) flaggedOnce = true
    }
    expect(flaggedOnce).toBe(false)
  })
})

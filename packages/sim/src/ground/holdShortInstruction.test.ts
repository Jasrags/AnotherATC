import { describe, it, expect } from 'vitest'
import { createGroundSim } from './sim'
import type { AircraftInit } from './sim'
import { buildRunwayGuard } from './runwayGuard'
import { buildTaxiGraph } from './taxiGraph'
import type { AirportSurface } from '../world/types'
import { KSAN_RUNWAYS } from './ksanGame'

const surface: AirportSurface = {
  icao: 'TEST',
  name: 'Test',
  ref: { lat: 0, lon: 0, elevationFt: 0 },
  units: 'nm',
  source: 'synthetic',
  bounds: { minX: -0.5, minY: -0.5, maxX: 2, maxY: 0.5 },
  features: [
    { kind: 'runway', points: [[0, 0], [2, 0]] },
    // A connector across the runway with a parallel either side, so a real taxi clearance can
    // be routed and the hold-short clause it produces can be read off the transcript.
    { kind: 'taxiway', ref: 'C1', points: [[1, -0.3], [1, -0.05], [1, 0.05], [1, 0.3]] },
    { kind: 'taxiway', ref: 'A', points: [[0.4, -0.3], [1, -0.3], [1.6, -0.3]] },
    { kind: 'taxiway', ref: 'B', points: [[0.4, 0.3], [1, 0.3], [1.6, 0.3]] },
  ],
}
const guard = buildRunwayGuard(surface)
const graph = buildTaxiGraph(surface)

/** A transit approaching the runway from well back, so it spends time taxiing toward the line. */
function transit(id: string): AircraftInit {
  return {
    id,
    callsign: id,
    type: 'B738',
    wake: 'M',
    path: [[1, -0.4], [1, -0.1], [1, 0.1], [1, 0.4]],
    targetSpeed: 15,
    intent: 'departure',
    goalPoint: [1, 0.4],
  }
}

const A = (sim: ReturnType<typeof createGroundSim>, id: string) =>
  sim.snapshot().aircraft.find((a) => a.id === id)!
const run = (sim: ReturnType<typeof createGroundSim>, steps: number) => {
  for (let i = 0; i < steps; i += 1) sim.step(0.1)
}
function until(sim: ReturnType<typeof createGroundSim>, pred: () => boolean, steps = 4000): boolean {
  for (let i = 0; i < steps; i += 1) {
    sim.step(0.1)
    if (pred()) return true
  }
  return false
}

describe('hold short of runway N — as an instruction', () => {
  it('is accepted while taxiing toward the runway, confirming what the route already does', () => {
    const sim = createGroundSim([transit('x')], { guard })
    run(sim, 20)
    expect(A(sim, 'x').holdShort).toBe(false) // still taxiing toward the line
    expect(A(sim, 'x').canHoldShort).toBe(true)
    expect(sim.dispatch({ type: 'holdShort', aircraftId: 'x' }).ok).toBe(true)
    // …and it still stops at the line, as it always would have.
    expect(until(sim, () => A(sim, 'x').holdShort)).toBe(true)
    expect(A(sim, 'x').onRunway).toBe(false)
  })

  it('is accepted at the line, where it is a re-affirmation — the answer to a crossing request', () => {
    const sim = createGroundSim([transit('x')], { guard })
    expect(until(sim, () => A(sim, 'x').holdShort)).toBe(true)
    expect(sim.dispatch({ type: 'holdShort', aircraftId: 'x' }).ok).toBe(true)
    run(sim, 50)
    expect(A(sim, 'x').holdShort).toBe(true)
    expect(A(sim, 'x').onRunway).toBe(false)
  })

  it('cancels a crossing clearance that has not been acted on yet', () => {
    // The lever the incursion alert most wants: an arrival appears on final in the seconds
    // between clearing a crossing and the aircraft moving. This takes the clearance back.
    const sim = createGroundSim([transit('x')], { guard })
    expect(until(sim, () => A(sim, 'x').holdShort)).toBe(true)
    expect(sim.dispatch({ type: 'crossRunway', aircraftId: 'x' }).ok).toBe(true)
    expect(A(sim, 'x').holdShort).toBe(false) // released

    expect(sim.dispatch({ type: 'holdShort', aircraftId: 'x' }).ok).toBe(true)
    expect(until(sim, () => A(sim, 'x').holdShort)).toBe(true) // back at the line
    run(sim, 400)
    expect(A(sim, 'x').onRunway).toBe(false) // and it never went
    // The crossing authority is withdrawn with it, so it is not silently still permitted.
    expect(sim.snapshot().incursions).toEqual([])
  })

  it('can be cleared across again afterwards', () => {
    const sim = createGroundSim([transit('x')], { guard })
    expect(until(sim, () => A(sim, 'x').holdShort)).toBe(true)
    sim.dispatch({ type: 'crossRunway', aircraftId: 'x' })
    sim.dispatch({ type: 'holdShort', aircraftId: 'x' })
    expect(until(sim, () => A(sim, 'x').holdShort)).toBe(true)

    expect(sim.dispatch({ type: 'crossRunway', aircraftId: 'x' }).ok).toBe(true)
    expect(until(sim, () => A(sim, 'x').y > 0.39)).toBe(true)
  })

  it('refuses once the aircraft is on the runway — too late, and "no delay" means keep going', () => {
    const sim = createGroundSim([transit('x')], { guard })
    expect(until(sim, () => A(sim, 'x').holdShort)).toBe(true)
    sim.dispatch({ type: 'crossRunway', aircraftId: 'x' })
    expect(until(sim, () => A(sim, 'x').onRunway)).toBe(true)

    const r = sim.dispatch({ type: 'holdShort', aircraftId: 'x' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/already on the runway/i)
    expect(A(sim, 'x').canHoldShort).toBe(false)
  })

  it('refuses an aircraft with no runway on its route at all', () => {
    const noRunway: AircraftInit = {
      id: 'g', callsign: 'g', type: 'B738', wake: 'M',
      path: [[0.5, -0.4], [1.5, -0.4]], targetSpeed: 15, intent: 'arrival',
    }
    const sim = createGroundSim([noRunway], { guard })
    run(sim, 10)
    expect(A(sim, 'g').canHoldShort).toBe(false)
    expect(sim.dispatch({ type: 'holdShort', aircraftId: 'g' }).ok).toBe(false)
  })

  it('refuses an aircraft on final — a hold-short is a surface instruction', () => {
    const arr: AircraftInit = {
      id: 'a', callsign: 'a', type: 'B738', wake: 'M',
      path: [[-4, 0], [0, 0]], targetSpeed: 140, airborne: true, intent: 'arrival', goalPoint: [1, -0.4],
    }
    const sim = createGroundSim([arr], { guard })
    expect(sim.dispatch({ type: 'holdShort', aircraftId: 'a' }).ok).toBe(false)
  })
})

describe('hold short — on the air', () => {
  const withRunway = (): ReturnType<typeof createGroundSim> =>
    createGroundSim([transit('x')], { guard, runway: KSAN_RUNWAYS['27'] })

  it('names the runway, and the pilot reads it back', () => {
    const sim = withRunway()
    expect(until(sim, () => A(sim, 'x').holdShort)).toBe(true)
    const before = sim.snapshot().comms.length
    sim.dispatch({ type: 'holdShort', aircraftId: 'x' })
    const said = sim.snapshot().comms.slice(before)
    expect(said).toHaveLength(2)
    expect(said[0]!.text).toMatch(/hold short of runway \d/i)
    // Mandatory read-back: the runway has to come back with it, not just "roger".
    expect(said[1]!.from).toBe('pilot')
    expect(said[1]!.text).toMatch(/hold short of runway \d/i)
  })

  it('puts the hold-short clause in the taxi clearance that creates it', () => {
    // "Taxi to runway 27 via Charlie, hold short of runway 27" — the clause the procedure
    // makes mandatory to read back, and which the clearance never used to mention at all.
    const sim = createGroundSim([transit('x')], { guard, graph, runway: KSAN_RUNWAYS['27'] })
    const before = sim.snapshot().comms.length
    expect(sim.dispatch({ type: 'taxiTo', aircraftId: 'x', dest: [1.6, 0.3] }).ok).toBe(true)
    const said = sim.snapshot().comms.slice(before)
    expect(said[0]!.text).toMatch(/hold short of runway \d/i)
    expect(said[1]!.text).toMatch(/hold short of runway \d/i)
  })

  it('states the reason when there is one — the traffic the hold is for', () => {
    // "[Callsign], hold short runway 15, traffic on a 3 mile final" — the instruction the
    // procedure quotes (docs/atc-runway-crossing.md §6). Holding an aircraft without saying
    // why is half a transmission.
    const inbound: AircraftInit = {
      id: 'inb', callsign: 'inb', type: 'B738', wake: 'M',
      path: [[-4, 0], [0, 0]], targetSpeed: 140, airborne: true, intent: 'arrival', goalPoint: [1, -0.4],
    }
    const sim = createGroundSim([transit('x'), inbound], { guard, runway: KSAN_RUNWAYS['27'] })
    expect(until(sim, () => A(sim, 'x').holdShort && A(sim, 'inb').finalNm <= 3)).toBe(true)

    const before = sim.snapshot().comms.length
    sim.dispatch({ type: 'holdShort', aircraftId: 'x' })
    const said = sim.snapshot().comms.slice(before)
    expect(said[0]!.text).toMatch(/hold short of runway \d+, traffic on a \d+ mile final/i)
    // The pilot reads back the instruction, not the reason: a cause is not a clearance.
    expect(said[1]!.text).toMatch(/hold short of runway \d+/i)
    expect(said[1]!.text).not.toMatch(/traffic/i)
  })

  it('names traffic on the runway when that is what the hold is for', () => {
    const sim = createGroundSim([transit('x'), transit('y')], { guard, runway: KSAN_RUNWAYS['27'] })
    expect(until(sim, () => A(sim, 'x').holdShort && A(sim, 'y').holdShort)).toBe(true)
    sim.dispatch({ type: 'crossRunway', aircraftId: 'y' })
    expect(until(sim, () => A(sim, 'y').onRunway)).toBe(true)

    const before = sim.snapshot().comms.length
    sim.dispatch({ type: 'holdShort', aircraftId: 'x' })
    expect(sim.snapshot().comms.slice(before)[0]!.text).toMatch(/traffic on the runway/i)
  })

  it('says it plainly when nothing is in the way — no invented reason', () => {
    const sim = createGroundSim([transit('x')], { guard, runway: KSAN_RUNWAYS['27'] })
    expect(until(sim, () => A(sim, 'x').holdShort)).toBe(true)
    const before = sim.snapshot().comms.length
    sim.dispatch({ type: 'holdShort', aircraftId: 'x' })
    const said = sim.snapshot().comms.slice(before)[0]!.text
    expect(said).toMatch(/hold short of runway \d+\.$/i)
    expect(said).not.toMatch(/traffic/i)
  })

  it('leaves it off a clearance that never reaches a runway', () => {
    const noRunway: AircraftInit = {
      id: 'g', callsign: 'g', type: 'B738', wake: 'M',
      path: [[0.5, -0.4], [1.5, -0.4]], targetSpeed: 15, intent: 'arrival',
    }
    const sim = createGroundSim([noRunway], { guard, runway: KSAN_RUNWAYS['27'] })
    const before = sim.snapshot().comms.length
    sim.dispatch({ type: 'hold', aircraftId: 'g' })
    const said = sim.snapshot().comms.slice(before)
    expect(said[0]!.text).not.toMatch(/hold short/i)
  })
})

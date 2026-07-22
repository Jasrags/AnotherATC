import { describe, it, expect } from 'vitest'
import { createGroundSim } from './sim'
import type { AircraftInit } from './sim'
import { buildRunwayGuard } from './runwayGuard'
import type { AirportSurface, Point } from '../world/types'

// The two levers the incursion alert needs: send the inbound around, or tell the aircraft on
// the runway to get off it. Same geometry as the incursion scenario.
const surface: AirportSurface = {
  icao: 'TEST',
  name: 'Test',
  ref: { lat: 0, lon: 0, elevationFt: 0 },
  units: 'nm',
  source: 'synthetic',
  bounds: { minX: -0.5, minY: -0.5, maxX: 2, maxY: 0.5 },
  features: [{ kind: 'runway', points: [[0, 0], [2, 0]] }],
}
const guard = buildRunwayGuard(surface)
const THRESHOLD: Point = [0, 0]
const FIX: Point = [-4, 0]

function crosser(id: string): AircraftInit {
  return {
    id,
    callsign: id,
    type: 'B738',
    wake: 'M',
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
function until(sim: ReturnType<typeof createGroundSim>, pred: () => boolean, steps = 4000): boolean {
  for (let i = 0; i < steps; i += 1) {
    sim.step(0.1)
    if (pred()) return true
  }
  return false
}

describe('go around (controller-issued)', () => {
  it('sends an arrival back to the final fix and takes away its landing clearance', () => {
    const sim = createGroundSim([arrival('inb')], { guard })
    expect(sim.dispatch({ type: 'clearedToLand', aircraftId: 'inb' }).ok).toBe(true)
    expect(until(sim, () => A(sim, 'inb').finalNm <= 2)).toBe(true)

    expect(sim.dispatch({ type: 'goAround', aircraftId: 'inb' }).ok).toBe(true)
    const a = A(sim, 'inb')
    expect(a.finalNm).toBeCloseTo(4, 1) // re-established at the fix
    expect(a.status).toBe('onFinal') // …and no longer cleared to land
  })

  it('is on the air as an instruction, not as the pilot announcing it', () => {
    // A go-around the controller issues and one the pilot calls are different transmissions,
    // and the transcript has to be able to tell them apart.
    const sim = createGroundSim([arrival('inb')], { guard })
    sim.dispatch({ type: 'clearedToLand', aircraftId: 'inb' })
    run(sim, 10)
    const before = sim.snapshot().comms.length
    sim.dispatch({ type: 'goAround', aircraftId: 'inb' })

    const said = sim.snapshot().comms.slice(before)
    expect(said).toHaveLength(2)
    expect(said[0]!.from).toBe('controller')
    expect(said[0]!.text).toContain('go around')
    expect(said[1]!.from).toBe('pilot')
    expect(said[1]!.text).toContain('Going around')
  })

  it('refuses anything that is not an arrival on final', () => {
    const sim = createGroundSim([crosser('x'), arrival('inb')], { guard })
    expect(sim.dispatch({ type: 'goAround', aircraftId: 'x' })).toEqual({
      ok: false,
      reason: 'only an arrival on final can be sent around',
    })
    // An arrival that has already landed is on the ground; there is nothing to send around.
    sim.dispatch({ type: 'clearedToLand', aircraftId: 'inb' })
    expect(until(sim, () => A(sim, 'inb').status === 'rollout')).toBe(true)
    expect(sim.dispatch({ type: 'goAround', aircraftId: 'inb' }).ok).toBe(false)
  })

  it('resolves the incursion it was issued for', () => {
    // The whole point: an occupant stuck on the runway under an inbound, and the lever that
    // buys the time to move it.
    const sim = createGroundSim([crosser('x'), arrival('inb')], { guard })
    expect(until(sim, () => A(sim, 'x').holdShort)).toBe(true)
    sim.dispatch({ type: 'clearedToLand', aircraftId: 'inb' })
    expect(until(sim, () => A(sim, 'inb').finalNm <= 2.5)).toBe(true)
    sim.dispatch({ type: 'crossRunway', aircraftId: 'x' })
    expect(until(sim, () => A(sim, 'x').onRunway)).toBe(true)
    sim.dispatch({ type: 'hold', aircraftId: 'x' })
    expect(until(sim, () => sim.snapshot().incursions.length > 0)).toBe(true)

    expect(sim.dispatch({ type: 'goAround', aircraftId: 'inb' }).ok).toBe(true)
    run(sim, 1)
    // The occupant has not moved — but nothing is landing on it any more.
    expect(A(sim, 'x').onRunway).toBe(true)
    expect(sim.snapshot().incursions).toEqual([])
  })
})

describe('expedite', () => {
  it('gets a held aircraft moving again, faster than a normal taxi', () => {
    const sim = createGroundSim([crosser('x')], { guard })
    expect(until(sim, () => A(sim, 'x').holdShort)).toBe(true)
    sim.dispatch({ type: 'crossRunway', aircraftId: 'x' })
    expect(until(sim, () => A(sim, 'x').onRunway)).toBe(true)
    sim.dispatch({ type: 'hold', aircraftId: 'x' })
    expect(until(sim, () => A(sim, 'x').groundspeed === 0)).toBe(true)

    expect(sim.dispatch({ type: 'expedite', aircraftId: 'x' }).ok).toBe(true)
    expect(A(sim, 'x').expedite).toBe(true)
    run(sim, 60)
    expect(A(sim, 'x').groundspeed).toBeGreaterThan(15) // faster than a normal taxi
  })

  it('clears the runway sooner than a normal taxi would', () => {
    const clearAt = (expedite: boolean): number => {
      const sim = createGroundSim([crosser('x')], { guard })
      until(sim, () => A(sim, 'x').holdShort)
      sim.dispatch({ type: 'crossRunway', aircraftId: 'x' })
      until(sim, () => A(sim, 'x').onRunway)
      if (expedite) sim.dispatch({ type: 'expedite', aircraftId: 'x' })
      until(sim, () => !A(sim, 'x').onRunway)
      return sim.snapshot().time
    }
    expect(clearAt(true)).toBeLessThan(clearAt(false))
  })

  it('cancels a give-way hold, because it is the opposite instruction', () => {
    const sim = createGroundSim([crosser('x'), crosser('y')], { guard })
    sim.dispatch({ type: 'giveWay', aircraftId: 'x', toId: 'y' })
    expect(A(sim, 'x').giveWayTo).toBe('y') // the snapshot exposes the callsign, not the id
    expect(sim.dispatch({ type: 'expedite', aircraftId: 'x' }).ok).toBe(true)
    expect(A(sim, 'x').giveWayTo).toBeNull()
  })

  it('is spent by the next clearance, not carried into it', () => {
    const sim = createGroundSim([crosser('x')], { guard })
    sim.dispatch({ type: 'expedite', aircraftId: 'x' })
    expect(A(sim, 'x').expedite).toBe(true)
    expect(sim.dispatch({ type: 'resume', aircraftId: 'x' }).ok).toBe(true)
    expect(A(sim, 'x').expedite).toBe(false)
  })

  it('refuses an aircraft with nothing left to run', () => {
    const parked: AircraftInit = { id: 'p', callsign: 'P', type: 'B738', wake: 'M', path: [[1, -0.4]], targetSpeed: 0 }
    const sim = createGroundSim([parked], { guard })
    expect(sim.dispatch({ type: 'expedite', aircraftId: 'p' })).toEqual({
      ok: false,
      reason: 'nothing to expedite — no clearance to run',
    })
  })

  it('still holds behind traffic — expedite is not permission to run into anyone', () => {
    // Separation caps are applied on top of the target speed, so the fast aircraft still
    // stops behind a stopped one. An instruction to hurry is not an instruction to collide.
    const lead: AircraftInit = { id: 'l', callsign: 'L', type: 'B738', wake: 'M', path: [[1, 0.2], [1, 0.25]], targetSpeed: 0 }
    const sim = createGroundSim([crosser('x'), lead], { guard })
    sim.dispatch({ type: 'expedite', aircraftId: 'x' })
    run(sim, 900)
    const x = A(sim, 'x')
    const l = A(sim, 'l')
    expect(x.y).toBeLessThan(l.y)
    expect(l.y - x.y).toBeGreaterThan(0.015)
  })
})

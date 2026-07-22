import { describe, it, expect } from 'vitest'
import { createGroundSim } from './sim'
import type { AircraftInit } from './sim'
import { buildRunwayGuard } from './runwayGuard'
import { buildTaxiGraph } from './taxiGraph'
import type { ActiveRunway } from './runway'
import type { AirportSurface, Point } from '../world/types'

// One runway (y=0, x 0→2) with a parallel taxiway and two connectors — the same shape as the
// approach fixtures, kept local so this file's timings are its own.
const surface: AirportSurface = {
  icao: 'TEST',
  name: 'Test',
  ref: { lat: 0, lon: 0, elevationFt: 0 },
  units: 'nm',
  source: 'synthetic',
  bounds: { minX: 0, minY: -0.3, maxX: 2, maxY: 0 },
  features: [
    { kind: 'runway', points: [[0, 0], [2, 0]] },
    { kind: 'taxiway', ref: 'A', points: [[0.2, -0.2], [1, -0.2], [1.5, -0.2], [1.8, -0.2]] },
    { kind: 'taxiway', ref: 'E1', points: [[0.2, -0.2], [0.2, -0.02]] },
    { kind: 'taxiway', ref: 'E5', points: [[1.1, 0], [1.35, -0.12], [1.5, -0.2]] },
    { kind: 'taxiway', ref: 'E9', points: [[1.8, -0.2], [1.8, -0.02]] },
  ],
}
const guard = buildRunwayGuard(surface)
const graph = buildTaxiGraph(surface)
const GATE: Point = [1.8, -0.2]
const THRESHOLD: Point = [0, 0]
const FIX: Point = [-4, 0]
const runway: ActiveRunway = {
  ident: '09',
  threshold: THRESHOLD,
  departureStart: [0, 0],
  farEnd: [2, 0],
  toraFt: 12000,
  ldaFt: 12000,
  glidePathDeg: 3,
  pattern: 'left',
}

const arrival = (id: string): AircraftInit => ({
  id,
  callsign: id.toUpperCase(),
  type: 'B738',
  wake: 'M',
  path: [FIX, THRESHOLD],
  targetSpeed: 140,
  airborne: true,
  intent: 'arrival',
  goalPoint: GATE,
  gate: 'A1',
})

/** A departure holding short at the far end, so a landing aircraft passes it on the way down. */
const departure = (id: string, x = 0.2): AircraftInit => ({
  id,
  callsign: id.toUpperCase(),
  type: 'B738',
  wake: 'M',
  path: [[x, -0.2], [x, -0.02], [x, 0.02]],
  targetSpeed: 15,
  intent: 'departure',
  goalPoint: [x, 0],
})

const A = (sim: ReturnType<typeof createGroundSim>, id: string) =>
  sim.snapshot().aircraft.find((a) => a.id === id)
const say = (sim: ReturnType<typeof createGroundSim>) => sim.snapshot().comms.map((c) => c.text)

/**
 * The conditional line-up: "behind the landing 737, line up runway 9 and wait, behind."
 *
 * ICAO phraseology (Doc 4444), and deliberately not FAA — the US issues explicit clearances
 * only. It is here for the mechanic: a clearance issued *now* that takes effect *later*, which
 * is the first thing in this sim the controller commits to before it happens. The tension is
 * entirely in what can change between the two moments, and the go-around is the case that
 * matters — the aircraft it was issued behind stops being a landing aircraft.
 */
describe('issuing a conditional line-up', () => {
  /** An arrival cleared to land, and a departure holding short on Tower's frequency. */
  function pair() {
    const sim = createGroundSim([arrival('arr'), departure('dep')], { guard, graph, runway })
    sim.dispatch({ type: 'clearedToLand', aircraftId: 'arr' })
    for (let i = 0; i < 2000 && !A(sim, 'dep')?.holdShort; i += 1) sim.step(0.1)
    expect(sim.dispatch({ type: 'contactTower', aircraftId: 'dep' })).toEqual({ ok: true })
    return sim
  }

  it('is refused against traffic that is not a landing aircraft', () => {
    const sim = createGroundSim([arrival('arr'), departure('dep')], { guard, graph, runway })
    for (let i = 0; i < 2000 && !A(sim, 'dep')?.holdShort; i += 1) sim.step(0.1)
    sim.dispatch({ type: 'contactTower', aircraftId: 'dep' })
    // Not cleared to land: "the landing traffic" is not landing, and a condition nobody has
    // authorized is a condition that may never happen.
    expect(sim.dispatch({ type: 'lineUpAndWait', aircraftId: 'dep', behind: 'arr' })).toEqual({
      ok: false,
      reason: 'that traffic is not cleared to land',
    })
    expect(sim.dispatch({ type: 'lineUpAndWait', aircraftId: 'dep', behind: 'nobody' })).toEqual({
      ok: false,
      reason: 'unknown traffic',
    })
  })

  it('leaves the aircraft where it is — the clearance is for later', () => {
    const sim = pair()
    expect(sim.dispatch({ type: 'lineUpAndWait', aircraftId: 'dep', behind: 'arr' })).toEqual({ ok: true })
    for (let i = 0; i < 50; i += 1) sim.step(0.1)
    const dep = A(sim, 'dep')!
    expect(dep.status).toBe('holdShort')
    expect(dep.onRunway).toBe(false)
    expect(dep.lineUpBehind).toBe('ARR')
  })

  it('says the condition first and last, and the read-back repeats it', () => {
    // The ICAO sandwich: the condition brackets the clearance so it cannot be heard as an
    // unconditional one, which is the entire safety case for saying it at all.
    const sim = pair()
    sim.dispatch({ type: 'lineUpAndWait', aircraftId: 'dep', behind: 'arr' })
    const [instruction, readback] = sim.snapshot().comms.slice(-2)
    expect(instruction!.text).toBe('DEP, behind the landing ARR, runway 9, line up and wait, behind.')
    expect(readback!.text).toBe('Behind the landing ARR, runway 9, line up and wait, behind, DEP.')
  })

  it('is refused to an aircraft that is not holding short of the runway', () => {
    const sim = createGroundSim([arrival('arr'), departure('dep')], { guard, graph, runway })
    sim.dispatch({ type: 'clearedToLand', aircraftId: 'arr' })
    expect(sim.dispatch({ type: 'lineUpAndWait', aircraftId: 'dep', behind: 'arr' })).toEqual({
      ok: false,
      reason: 'not on tower frequency — hand off to tower first',
    })
  })
})

describe('the condition coming true', () => {
  function armed() {
    const sim = createGroundSim([arrival('arr'), departure('dep')], { guard, graph, runway })
    sim.dispatch({ type: 'clearedToLand', aircraftId: 'arr' })
    for (let i = 0; i < 2000 && !A(sim, 'dep')?.holdShort; i += 1) sim.step(0.1)
    sim.dispatch({ type: 'contactTower', aircraftId: 'dep' })
    expect(sim.dispatch({ type: 'lineUpAndWait', aircraftId: 'dep', behind: 'arr' })).toEqual({ ok: true })
    return sim
  }

  it('puts the aircraft on the runway once the landing traffic is past it', () => {
    const sim = armed()
    let enteredWhileArrivalStillLanding = false
    for (let i = 0; i < 6000 && A(sim, 'dep')?.status !== 'lineUpWait'; i += 1) {
      sim.step(0.1)
      const arr = A(sim, 'arr')
      if (A(sim, 'dep')?.status === 'lineUpWait' && arr?.altitude && arr.altitude > 0) {
        enteredWhileArrivalStillLanding = true
      }
    }
    expect(A(sim, 'dep')!.status).toBe('lineUpWait')
    expect(enteredWhileArrivalStillLanding).toBe(false) // never under an aircraft still flying
    expect(A(sim, 'dep')!.lineUpBehind).toBeNull() // the condition is spent
    // The pilot says so, because the controller is not watching this one aircraft.
    expect(say(sim).at(-1)).toBe('Lining up runway 9, DEP.')
  })

  it('does not enter until the traffic has actually passed the holding point', () => {
    // Behind means behind. The aircraft is holding at the *approach* end here, so a landing
    // that has merely touched down has not passed it yet.
    const sim = armed()
    for (let i = 0; i < 6000 && A(sim, 'arr')?.status !== 'rollout'; i += 1) sim.step(0.1)
    expect(A(sim, 'dep')!.status).toBe('holdShort') // touched down, not yet past
    for (let i = 0; i < 6000 && A(sim, 'dep')?.status !== 'lineUpWait'; i += 1) sim.step(0.1)
    expect(A(sim, 'dep')!.status).toBe('lineUpWait')
  })

  it('raises no incursion doing it', () => {
    // The pair this creates — a rollout leaving, a departure lining up behind it — is the
    // anticipated separation the detector was taught about. A clearance that alerts on itself
    // would be worse conditional than unconditional.
    const sim = armed()
    let alerted: string | null = null
    for (let i = 0; i < 8000; i += 1) {
      sim.step(0.1)
      const inc = sim.snapshot().incursions[0]
      if (inc && !alerted) alerted = inc.message
    }
    expect(alerted).toBeNull()
  })
})

describe('the condition that never comes true', () => {
  function armed() {
    const sim = createGroundSim([arrival('arr'), departure('dep')], { guard, graph, runway })
    sim.dispatch({ type: 'clearedToLand', aircraftId: 'arr' })
    for (let i = 0; i < 2000 && !A(sim, 'dep')?.holdShort; i += 1) sim.step(0.1)
    sim.dispatch({ type: 'contactTower', aircraftId: 'dep' })
    sim.dispatch({ type: 'lineUpAndWait', aircraftId: 'dep', behind: 'arr' })
    return sim
  }

  it('cancels the clearance when the traffic goes around', () => {
    // The case the whole mechanic turns on: the aircraft it was issued behind stops being a
    // landing aircraft, so the condition can never be met by it. Leaving it armed would put a
    // departure onto a runway for a landing that is not coming — or, worse, for the *next* one.
    const sim = armed()
    expect(sim.dispatch({ type: 'goAround', aircraftId: 'arr' })).toEqual({ ok: true })
    sim.step(0.1)

    const dep = A(sim, 'dep')!
    expect(dep.lineUpBehind).toBeNull()
    expect(dep.status).toBe('holdShort')
    expect(say(sim).at(-2)).toBe('DEP, cancel line up and wait, hold short of runway 9.')
    expect(say(sim).at(-1)).toBe('Holding short of runway 9, DEP.')

    // …and it stays held: the aircraft never enters the runway on a spent condition.
    for (let i = 0; i < 4000; i += 1) sim.step(0.1)
    expect(A(sim, 'dep')!.onRunway).toBe(false)
  })

  it('cancels when the traffic leaves the simulation entirely', () => {
    const sim = armed()
    expect(sim.remove('arr')).toBe(true)
    sim.step(0.1)
    expect(A(sim, 'dep')!.lineUpBehind).toBeNull()
    expect(A(sim, 'dep')!.status).toBe('holdShort')
  })

  it('is taken back by "hold short", like any other clearance not yet acted on', () => {
    const sim = armed()
    expect(sim.dispatch({ type: 'holdShort', aircraftId: 'dep' })).toEqual({ ok: true })
    expect(A(sim, 'dep')!.lineUpBehind).toBeNull()
    for (let i = 0; i < 6000; i += 1) sim.step(0.1)
    expect(A(sim, 'dep')!.onRunway).toBe(false)
  })
})

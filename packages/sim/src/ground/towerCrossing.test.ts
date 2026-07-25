import { describe, it, expect } from 'vitest'
import { createGroundSim } from './sim'
import type { AircraftInit } from './sim'
import { buildRunwayGuard } from './runwayGuard'
import type { AirportSurface } from '../world/types'

// One runway, and routes that cross it at mid-field — the geometry for a transit, which is the
// aircraft this whole path exists for. See docs/atc-runway-crossing.md §5–7.
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

/** A transit: its route continues past the runway, so it is holding short to *cross*. */
function transit(id: string, intent: 'departure' | 'arrival' = 'departure'): AircraftInit {
  return {
    id,
    callsign: id,
    type: 'B738',
    wake: 'M',
    path: [[1, -0.15], [1, -0.1], [1, 0.1], [1, 0.4]],
    targetSpeed: 15,
    intent,
    goalPoint: [1, 0.4],
  }
}

/** A departure whose goal is *on* the runway: holding short for takeoff, not to cross. */
function forTakeoff(id: string): AircraftInit {
  return {
    id,
    callsign: id,
    type: 'B738',
    wake: 'M',
    path: [[1, -0.15], [1, -0.1], [1, 0]],
    targetSpeed: 15,
    intent: 'departure',
    goalPoint: [1, 0],
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
/** Step a transit up to the hold-short line. */
function atHoldShort(sim: ReturnType<typeof createGroundSim>, id: string): void {
  expect(until(sim, () => A(sim, id).holdShort)).toBe(true)
}

describe('crossRunway — what actually counts as a crossing', () => {
  it('refuses an aircraft whose route ends on the runway: that is a line-up, not a crossing', () => {
    // Its held portion stops on the pavement, so "crossing" it would drive it onto the runway
    // and park it there, unaligned, with no takeoff clearance — a runway incursion issued by
    // the controller. Ground never offers it, but the sim must not accept it either.
    const sim = createGroundSim([forTakeoff('dep')], { guard })
    atHoldShort(sim, 'dep')
    const r = sim.dispatch({ type: 'crossRunway', aircraftId: 'dep' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/does not cross/i)
    run(sim, 50)
    expect(A(sim, 'dep').onRunway).toBe(false)
  })
})

describe('Ground → Tower for a crossing (procedure option B)', () => {
  it('hands a transit to Tower instead of clearing it across itself', () => {
    const sim = createGroundSim([transit('x')], { guard })
    atHoldShort(sim, 'x')
    expect(A(sim, 'x').holdingForTakeoff).toBe(false) // it is a transit, not a departure roll

    expect(sim.dispatch({ type: 'contactTower', aircraftId: 'x' }).ok).toBe(true)
    expect(A(sim, 'x').controlledBy).toBe('tower')
    expect(A(sim, 'x').holdShort).toBe(true) // still holding short — a frequency change only
  })

  it('hands an *arrival* across too — crossing to reach a gate is not a departure operation', () => {
    const sim = createGroundSim([transit('arr', 'arrival')], { guard })
    atHoldShort(sim, 'arr')
    expect(sim.dispatch({ type: 'contactTower', aircraftId: 'arr' }).ok).toBe(true)
    expect(A(sim, 'arr').controlledBy).toBe('tower')
  })

  it('says on the air that the handoff is for a crossing, not for takeoff', () => {
    const sim = createGroundSim([transit('x')], { guard }, )
    atHoldShort(sim, 'x')
    const before = sim.snapshot().comms.length
    sim.dispatch({ type: 'contactTower', aircraftId: 'x' })
    const said = sim.snapshot().comms.slice(before)
    expect(said[0]!.text).toMatch(/crossing/i)
  })
})

describe('Tower clears the crossing', () => {
  const handedOff = (): ReturnType<typeof createGroundSim> => {
    const sim = createGroundSim([transit('x')], { guard })
    atHoldShort(sim, 'x')
    sim.dispatch({ type: 'contactTower', aircraftId: 'x' })
    return sim
  }

  it('clears a Tower-owned transit across, and it goes', () => {
    const sim = handedOff()
    expect(sim.dispatch({ type: 'crossRunway', aircraftId: 'x' }).ok).toBe(true)
    expect(until(sim, () => A(sim, 'x').onRunway)).toBe(true)
    // Clear of the runway means out of the guard band, which is barely past the centerline —
    // "across" is reaching the far side of the route, so let it run on to its goal.
    expect(until(sim, () => !A(sim, 'x').onRunway)).toBe(true)
    expect(until(sim, () => A(sim, 'x').y > 0.39)).toBe(true)
  })

  it("adds 'no delay' when Tower issues it — Ground's own crossing does not", () => {
    const tower = handedOff()
    const beforeT = tower.snapshot().comms.length
    tower.dispatch({ type: 'crossRunway', aircraftId: 'x' })
    const towerSaid = tower.snapshot().comms.slice(beforeT)[0]!.text
    expect(towerSaid).toMatch(/no delay/i)

    const ground = createGroundSim([transit('y')], { guard })
    atHoldShort(ground, 'y')
    const beforeG = ground.snapshot().comms.length
    ground.dispatch({ type: 'crossRunway', aircraftId: 'y' })
    const groundSaid = ground.snapshot().comms.slice(beforeG)[0]!.text
    // These fixtures configure no runway, so both phrasings say "the runway" — the difference
    // under test is the "no delay" Local Control adds, not the designator.
    expect(groundSaid).toMatch(/cross the runway/i)
    expect(groundSaid).not.toMatch(/no delay/i)
  })

  it('refuses to clear it across a runway someone else is committed to', () => {
    const sim = createGroundSim([transit('x'), transit('other')], { guard })
    atHoldShort(sim, 'x')
    sim.dispatch({ type: 'contactTower', aircraftId: 'x' })
    // Put the other aircraft on the runway first.
    sim.dispatch({ type: 'crossRunway', aircraftId: 'other' })
    expect(until(sim, () => A(sim, 'other').onRunway)).toBe(true)

    const r = sim.dispatch({ type: 'crossRunway', aircraftId: 'x' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/occupied/i)
  })
})

// Two parallel runways — the geometry that trips up a goal-based "is this a takeoff?" test. A
// departure off RWY_B must cross RWY_A to reach it, so while it holds short of RWY_A its *goal*
// sits on a runway (RWY_B) even though the runway it is holding short of is one it only crosses.
// This is KOAK: cross 28R to depart 28L (see the multi-runway NOTE in sim.ts).
const twoRunwaySurface: AirportSurface = {
  icao: 'TST2',
  name: 'Two Runway Test',
  ref: { lat: 0, lon: 0, elevationFt: 0 },
  units: 'nm',
  source: 'synthetic',
  bounds: { minX: -0.5, minY: -1.5, maxX: 2, maxY: 0.5 },
  features: [
    { kind: 'runway', points: [[0, 0], [2, 0]] }, // RWY_A — the one crossed
    { kind: 'runway', points: [[0, -1], [2, -1]] }, // RWY_B — the departure runway (goal sits here)
  ],
}
const guard2 = buildRunwayGuard(twoRunwaySurface)

/** A departure that crosses RWY_A to reach a goal *on* RWY_B — cross one runway to depart another. */
function crossesToDepart(id: string): AircraftInit {
  return {
    id,
    callsign: id,
    type: 'B738',
    wake: 'M',
    // North of RWY_A → across RWY_A (y=0) → down to a goal on RWY_B (y=-1).
    path: [[1, 0.15], [1, 0.1], [1, -0.9], [1, -1]],
    targetSpeed: 15,
    intent: 'departure',
    goalPoint: [1, -1],
  }
}

describe('crossing one runway to depart another (multi-runway)', () => {
  it('holding short of the crossed runway is a crossing, not a takeoff hold', () => {
    // Regression: `holdingForTakeoff` keyed off the goal sitting on *a* runway, so a departure
    // holding short of the runway it crosses (goal on the far runway) read as a takeoff hold —
    // Tower then offered line-up/takeoff on a runway the aircraft has no business using, and no
    // "cross runway". The held route ends short of the crossed runway, which is the tell.
    const sim = createGroundSim([crossesToDepart('dep')], { guard: guard2 })
    atHoldShort(sim, 'dep')
    expect(A(sim, 'dep').holdingForTakeoff).toBe(false)
  })

  it('hands off to Tower and clears across, same as any transit', () => {
    const sim = createGroundSim([crossesToDepart('dep')], { guard: guard2 })
    atHoldShort(sim, 'dep')
    expect(sim.dispatch({ type: 'contactTower', aircraftId: 'dep' }).ok).toBe(true)
    expect(A(sim, 'dep').controlledBy).toBe('tower')
    expect(sim.dispatch({ type: 'crossRunway', aircraftId: 'dep' }).ok).toBe(true)
    expect(until(sim, () => A(sim, 'dep').onRunway)).toBe(true)
  })

  it('refuses line-up-and-wait on a runway it only crosses', () => {
    // The sibling guard has the same multi-runway blind spot: the goal is on a runway, so a naive
    // "goal on a runway → may line up" would drive it onto the crossed runway unaligned.
    const sim = createGroundSim([crossesToDepart('dep')], { guard: guard2 })
    atHoldShort(sim, 'dep')
    sim.dispatch({ type: 'contactTower', aircraftId: 'dep' })
    const r = sim.dispatch({ type: 'lineUpAndWait', aircraftId: 'dep' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/cross/i)
  })
})

describe('Tower → Ground once the crossing is complete', () => {
  const crossing = (): ReturnType<typeof createGroundSim> => {
    const sim = createGroundSim([transit('x')], { guard })
    atHoldShort(sim, 'x')
    sim.dispatch({ type: 'contactTower', aircraftId: 'x' })
    sim.dispatch({ type: 'crossRunway', aircraftId: 'x' })
    return sim
  }

  it('arms the handoff while the aircraft is still on the runway, and applies it once clear', () => {
    // Issued mid-crossing this is the real "when clear of the runway, contact ground": the
    // aircraft does not switch on its own, and must not switch while still on the pavement.
    const sim = crossing()
    expect(until(sim, () => A(sim, 'x').onRunway)).toBe(true)
    expect(sim.dispatch({ type: 'contactGround', aircraftId: 'x' }).ok).toBe(true)
    expect(A(sim, 'x').controlledBy).toBe('tower') // still Tower's while it is on the runway

    expect(until(sim, () => !A(sim, 'x').onRunway)).toBe(true)
    run(sim, 2)
    expect(A(sim, 'x').controlledBy).toBe('ground')
  })

  it('applies immediately when issued after the aircraft is already clear', () => {
    const sim = crossing()
    expect(until(sim, () => A(sim, 'x').onRunway)).toBe(true)
    expect(until(sim, () => !A(sim, 'x').onRunway)).toBe(true)
    expect(sim.dispatch({ type: 'contactGround', aircraftId: 'x' }).ok).toBe(true)
    expect(A(sim, 'x').controlledBy).toBe('ground')
  })

  it('still says the crossing is complete, though applying it ends the crossing', () => {
    // The instruction is worded from the state as *issued*, not the state it creates. Phrased
    // afterwards, this aircraft is an ordinary Ground taxi and the transmission collapses to a
    // bare "contact ground" — losing the half that says the runway is clear. Only reachable
    // through a real dispatch: a hand-built phrase context cannot show it.
    const sim = crossing()
    expect(until(sim, () => A(sim, 'x').onRunway)).toBe(true)
    expect(until(sim, () => !A(sim, 'x').onRunway)).toBe(true)
    const before = sim.snapshot().comms.length
    sim.dispatch({ type: 'contactGround', aircraftId: 'x' })
    expect(sim.snapshot().comms.slice(before)[0]!.text).toMatch(/clear, contact ground/i)
  })

  it('reports the armed handoff as pending, so it is not offered twice', () => {
    const sim = crossing()
    expect(until(sim, () => A(sim, 'x').onRunway)).toBe(true)
    expect(A(sim, 'x').handoffPending).toBe(false)
    sim.dispatch({ type: 'contactGround', aircraftId: 'x' })
    expect(A(sim, 'x').handoffPending).toBe(true)
  })

  it('keeps taxiing its own clearance across the handoff — it was never re-routed', () => {
    const sim = crossing()
    expect(until(sim, () => !A(sim, 'x').onRunway)).toBe(true)
    sim.dispatch({ type: 'contactGround', aircraftId: 'x' })
    expect(until(sim, () => A(sim, 'x').y > 0.39)).toBe(true) // reached its original goal
  })

  it('refuses a second handoff', () => {
    const sim = crossing()
    expect(until(sim, () => A(sim, 'x').onRunway)).toBe(true)
    expect(sim.dispatch({ type: 'contactGround', aircraftId: 'x' }).ok).toBe(true)
    expect(sim.dispatch({ type: 'contactGround', aircraftId: 'x' }).ok).toBe(false)
  })
})

describe('the full crossing, end to end', () => {
  it('runs the whole procedure: hold short → Tower → cross → back to Ground → goal', () => {
    const sim = createGroundSim([transit('x')], { guard })
    atHoldShort(sim, 'x')
    expect(sim.snapshot().incursions).toEqual([])

    expect(sim.dispatch({ type: 'contactTower', aircraftId: 'x' }).ok).toBe(true)
    expect(sim.dispatch({ type: 'crossRunway', aircraftId: 'x' }).ok).toBe(true)
    expect(until(sim, () => A(sim, 'x').onRunway)).toBe(true)
    // Crossing under a clearance is never an incursion, whoever issued it.
    expect(sim.snapshot().incursions).toEqual([])

    expect(sim.dispatch({ type: 'contactGround', aircraftId: 'x' }).ok).toBe(true)
    expect(until(sim, () => A(sim, 'x').controlledBy === 'ground')).toBe(true)
    expect(until(sim, () => A(sim, 'x').y > 0.39)).toBe(true)
    expect(sim.snapshot().incursions).toEqual([])
  })
})

import { describe, it, expect } from 'vitest'
import { createGroundSim } from './sim'
import type { AircraftInit, GroundSimOptions } from './sim'
import { KSAN } from '../world/ksanAirport'
import { createAirportGame } from '../world/airport'
import { buildTaxiGraph } from './taxiGraph'
import { buildRunwayGuard } from './runwayGuard'

const parked = (id: string): AircraftInit => ({
  id,
  callsign: id,
  type: 'B738',
  wake: 'M',
  path: [[0, 0]],
  targetSpeed: 0,
  intent: 'departure',
  gate: '1',
})

/** Every departure gets a slot / no departure does, so the mechanic is testable without
 *  hunting a seed for a probability. */
const LEAD = { leadMinSec: 8 * 60, leadMaxSec: 14 * 60 }
const always: GroundSimOptions = { slots: { rate: 1, seed: 5, ...LEAD } }
const never: GroundSimOptions = { slots: { rate: 0, seed: 5, ...LEAD } }

const only = (sim: ReturnType<typeof createGroundSim>) => sim.snapshot().aircraft[0]!
/**
 * Wheels-up time windows — the slot half of Clearance Delivery.
 *
 * See docs/atc-flight-cycle.md ("Wheels-Up Time Windows" and the As-implemented note): the
 * release from TRACON waits for TRACON, but the *time* needs no facility, and the constraint is
 * entirely Ground's and Tower's to plan around.
 */
describe('EDCT assignment', () => {
  it('is off by default — no configuration, no slots', () => {
    const sim = createGroundSim([parked('a')])
    sim.dispatch({ type: 'clearance', aircraftId: 'a' })
    expect(only(sim).edctSec).toBeNull()
  })

  it('comes with the IFR clearance, at the lead the *field* asked for', () => {
    // The lead is airfield-specific: a slot has to clear that field's taxi time, and a KSAN
    // departure is about seven minutes from clearance to the hold-short line. The engine takes
    // the number rather than owning one.
    const sim = createGroundSim([parked('a')], always)
    sim.dispatch({ type: 'clearance', aircraftId: 'a' })
    const edct = only(sim).edctSec!
    expect(edct).toBeGreaterThanOrEqual(8 * 60)
    expect(edct).toBeLessThanOrEqual(14 * 60)
  })

  it('is read out with the clearance — an unspoken slot is not a clearance', () => {
    const sim = createGroundSim([parked('a')], always)
    sim.dispatch({ type: 'clearance', aircraftId: 'a' })
    const [instruction, readback] = sim.snapshot().comms.slice(-2)
    expect(instruction!.text).toMatch(/EDCT \d+:\d\d/)
    expect(readback!.text).toMatch(/EDCT \d+:\d\d/)
  })

  it('goes to some departures and not others, and never to an arrival', () => {
    const sim = createGroundSim(
      [parked('a'), parked('b'), parked('c'), parked('d'), parked('e'), parked('f')],
      { slots: { rate: 0.5, seed: 5, ...LEAD } },
    )
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) sim.dispatch({ type: 'clearance', aircraftId: id })
    const withSlot = sim.snapshot().aircraft.filter((x) => x.edctSec !== null)
    expect(withSlot.length).toBeGreaterThan(0)
    expect(withSlot.length).toBeLessThan(6)
  })

  it('is deterministic — the same seed gives the same slots', () => {
    const go = () => {
      const sim = createGroundSim([parked('a'), parked('b'), parked('c')], { slots: { rate: 0.5, seed: 9, ...LEAD } })
      for (const id of ['a', 'b', 'c']) sim.dispatch({ type: 'clearance', aircraftId: id })
      return sim.snapshot().aircraft.map((x) => x.edctSec).join(',')
    }
    expect(go()).toBe(go())
  })
})

describe('the window is what Tower has to hit', () => {
  const graph = buildTaxiGraph(KSAN.surface)
  const guard = buildRunwayGuard(KSAN.surface)

  /** A KSAN departure cleared, taxied to the runway and handed to Tower, holding for its slot. */
  function readyToRoll(opts: GroundSimOptions) {
    const game = createAirportGame(KSAN, 1)
    const slot = KSAN.fleets[0]!.gates[0]!
    const sim = createGroundSim(
      [{
        id: 'd', callsign: 'SKW412', type: 'B738', wake: 'M',
        path: [slot.point], targetSpeed: 0,
        ...(slot.headingDeg !== undefined ? { heading: slot.headingDeg } : {}),
        intent: 'departure', gate: slot.ref, goalPoint: game.runway.departureStart,
      }],
      { graph, guard, runway: game.runway, stands: game.stands, ...opts },
    )
    const D = () => sim.snapshot().aircraft.find((a) => a.id === 'd')!
    sim.dispatch({ type: 'clearance', aircraftId: 'd' })
    sim.dispatch({ type: 'pushback', aircraftId: 'd' })
    for (let i = 0; i < 2000 && D().status === 'pushback'; i += 1) sim.step(0.1)
    sim.dispatch({ type: 'taxiToGoal', aircraftId: 'd' })
    for (let i = 0; i < 30000 && D().status !== 'holdShort'; i += 1) sim.step(0.1)
    sim.dispatch({ type: 'contactTower', aircraftId: 'd' })
    return { sim, D }
  }

  it('refuses a takeoff clearance before the window opens, and says how long', () => {
    const { sim, D } = readyToRoll(always)
    const res = sim.dispatch({ type: 'clearedForTakeoff', aircraftId: 'd' })
    expect(res).toEqual({ ok: false, reason: expect.stringMatching(/EDCT/) })
    expect(D().edctSec).toBeGreaterThan(sim.snapshot().time) // still ahead of it
  })

  it('lets it go once the window opens', () => {
    const { sim, D } = readyToRoll(always)
    // Two minutes before the slot: the window is open, and holding it longer would be Tower
    // inventing a delay the flow never asked for.
    while (sim.snapshot().time < D().edctSec! - 110) sim.step(0.1)
    expect(sim.dispatch({ type: 'clearedForTakeoff', aircraftId: 'd' })).toEqual({ ok: true })
    expect(sim.snapshot().slotsMet).toBe(1)
    expect(sim.snapshot().slotsMissed).toBe(0)
  })

  it('counts a miss and issues a new slot further out', () => {
    const { sim, D } = readyToRoll(always)
    const missed = D().edctSec!
    while (sim.snapshot().time < missed + 130) sim.step(0.1) // past the back of the window

    const res = sim.dispatch({ type: 'clearedForTakeoff', aircraftId: 'd' })
    expect(res.ok).toBe(false)
    expect(sim.snapshot().slotsMissed).toBe(1)
    // The negotiation the real thing requires, as a penalty: a new time, further out, and the
    // aircraft is still sitting on everyone else's runway.
    expect(D().edctSec).toBeGreaterThan(missed)
    expect(D().edctSec).toBeGreaterThan(sim.snapshot().time)
    expect(sim.snapshot().comms.at(-2)!.text).toMatch(/EDCT/)
  })

  it('only counts the miss once, however many times the clearance is tried', () => {
    const { sim, D } = readyToRoll(always)
    while (sim.snapshot().time < D().edctSec! + 130) sim.step(0.1)
    sim.dispatch({ type: 'clearedForTakeoff', aircraftId: 'd' })
    sim.dispatch({ type: 'clearedForTakeoff', aircraftId: 'd' })
    expect(sim.snapshot().slotsMissed).toBe(1)
  })

  it('never gets in the way of a departure with no slot at all', () => {
    const { sim } = readyToRoll(never)
    expect(sim.dispatch({ type: 'clearedForTakeoff', aircraftId: 'd' })).toEqual({ ok: true })
    expect(sim.snapshot().slotsMet).toBe(0) // nothing to meet
  })

  it('lets Tower line it up inside the wait — holding on the runway is the point', () => {
    // "Tower holds the aircraft at the runway until the window opens" (docs/atc-flight-cycle.md).
    // Lining up is how it holds; refusing that would leave it at the hold line instead, which is
    // a different queue and a different kind of blockage.
    const { sim } = readyToRoll(always)
    expect(sim.dispatch({ type: 'lineUpAndWait', aircraftId: 'd' })).toEqual({ ok: true })
  })
})

describe('a slot worked end to end, on the real field', () => {
  const graph = buildTaxiGraph(KSAN.surface)
  const guard = buildRunwayGuard(KSAN.surface)

  it('is issued at the gate, carried through the taxi, and met at the runway', () => {
    // The whole claim: a promise made before the aircraft moves, which the controller then has
    // to plan a taxi around — through nothing but the ordinary command sequence.
    const game = createAirportGame(KSAN, 1)
    const sim = createGroundSim(game.inits, {
      graph,
      guard,
      runway: game.runway,
      stands: game.stands,
      servicing: game.servicing,
      slots: { rate: 1, seed: 5, ...LEAD },
    })
    const id = game.inits[0]!.id
    const D = () => sim.snapshot().aircraft.find((a) => a.id === id)!

    sim.dispatch({ type: 'clearance', aircraftId: id })
    const edct = D().edctSec!
    expect(edct).toBeGreaterThan(0)

    for (let i = 0; i < 3000 && D().serviceSec > 0; i += 1) sim.step(0.1)
    sim.dispatch({ type: 'pushback', aircraftId: id })
    for (let i = 0; i < 3000 && D().status === 'pushback'; i += 1) sim.step(0.1)
    sim.dispatch({ type: 'taxiToGoal', aircraftId: id })
    for (let i = 0; i < 30000 && D().status !== 'holdShort'; i += 1) sim.step(0.1)
    sim.dispatch({ type: 'contactTower', aircraftId: id })

    // Worked promptly, it arrives with time in hand — and waits, which is the mechanic.
    const arrived = sim.snapshot().time
    expect(arrived).toBeLessThan(edct)
    expect(sim.dispatch({ type: 'clearedForTakeoff', aircraftId: id }).ok).toBe(false)

    // Tower holds it at the runway until the window opens (docs/atc-flight-cycle.md), then goes.
    expect(sim.dispatch({ type: 'lineUpAndWait', aircraftId: id }).ok).toBe(true)
    for (let i = 0; i < 30000 && !sim.dispatch({ type: 'clearedForTakeoff', aircraftId: id }).ok; i += 1) {
      sim.step(0.1)
    }
    expect(sim.snapshot().slotsMet).toBe(1)
    expect(sim.snapshot().slotsMissed).toBe(0)
    expect(D().edctSec).toBeNull() // spent — it is not a constraint on the roll

    for (let i = 0; i < 3000 && sim.snapshot().aircraft.some((a) => a.id === id); i += 1) sim.step(0.1)
    expect(sim.snapshot().departed).toBe(1)
  })
})

describe('a slot-holding departure is in everyone else\'s way', () => {
  const graph = buildTaxiGraph(KSAN.surface)
  const guard = buildRunwayGuard(KSAN.surface)

  /** Two departures off two stands, both taxied to the runway and handed to Tower. */
  function twoAtTheRunway(opts: GroundSimOptions) {
    const game = createAirportGame(KSAN, 1)
    const gates = KSAN.fleets[0]!.gates
    const mk = (id: string, i: number) => {
      const slot = gates[i]!
      return {
        id, callsign: id.toUpperCase(), type: 'B738', wake: 'M' as const,
        path: [slot.point], targetSpeed: 0,
        ...(slot.headingDeg !== undefined ? { heading: slot.headingDeg } : {}),
        intent: 'departure' as const, gate: slot.ref, goalPoint: game.runway.departureStart,
      }
    }
    const sim = createGroundSim([mk('one', 0), mk('two', 8)], {
      graph, guard, runway: game.runway, stands: game.stands, ...opts,
    })
    const A = (id: string) => sim.snapshot().aircraft.find((a) => a.id === id)!
    for (const id of ['one', 'two']) {
      sim.dispatch({ type: 'clearance', aircraftId: id })
      sim.dispatch({ type: 'pushback', aircraftId: id })
    }
    for (let i = 0; i < 3000 && ['one', 'two'].some((id) => A(id).status === 'pushback'); i += 1) sim.step(0.1)
    for (const id of ['one', 'two']) sim.dispatch({ type: 'taxiToGoal', aircraftId: id })
    // Only the first reaches the line: the second queues *behind* it, which is the whole shape
    // of a departure queue and the reason a hold at the runway costs everyone.
    for (let i = 0; i < 40000 && A('one').status !== 'holdShort'; i += 1) sim.step(0.1)
    expect(sim.dispatch({ type: 'contactTower', aircraftId: 'one' })).toEqual({ ok: true })

    /** Bring the second aircraft up to the line and onto Tower's frequency, once there is room. */
    const advanceSecond = () => {
      for (let i = 0; i < 40000 && A('two').status !== 'holdShort'; i += 1) sim.step(0.1)
      expect(sim.dispatch({ type: 'contactTower', aircraftId: 'two' })).toEqual({ ok: true })
    }
    return { sim, A, advanceSecond }
  }

  it('blocks the aircraft behind it while it sits on the runway waiting for its window', () => {
    // The cost the mechanic is *for*: an aircraft ready to go, on the runway, holding a slot,
    // with the whole departure queue stopped behind it. If the runway gates did not see it the
    // hold would be free, and a free hold is not a constraint.
    const { sim, A, advanceSecond } = twoAtTheRunway({ slots: { rate: 1, seed: 5, ...LEAD } })
    expect(A('one').edctSec).not.toBeNull()
    expect(sim.dispatch({ type: 'clearedForTakeoff', aircraftId: 'one' }).ok).toBe(false) // its window
    expect(sim.dispatch({ type: 'lineUpAndWait', aircraftId: 'one' })).toEqual({ ok: true })
    advanceSecond()

    expect(sim.dispatch({ type: 'lineUpAndWait', aircraftId: 'two' })).toEqual({
      ok: false,
      reason: 'runway occupied',
    })
    const res = sim.dispatch({ type: 'clearedForTakeoff', aircraftId: 'two' })
    expect(res).toEqual({ ok: false, reason: 'runway occupied' })
    // …and the runway gate answers before the slot does, so the reason names the thing the
    // controller can actually act on rather than a clock nobody can move.
    expect(A('two').onRunway).toBe(false)
  })

  it('makes the aircraft behind miss its own slot — the delay cascades', () => {
    // Not contrived: this fell out of running two ordinary departures. The first holds the
    // runway for its window, the second is stuck behind it, and by the time the runway and the
    // wake interval are clear the second has blown a window nobody could have made it hit.
    // "A natural source of cascading delay" (docs/atc-flight-cycle.md) — and the reason a slot
    // is a thing you plan a whole field around rather than one aircraft.
    const { sim, A, advanceSecond } = twoAtTheRunway({ slots: { rate: 1, seed: 5, ...LEAD } })
    sim.dispatch({ type: 'lineUpAndWait', aircraftId: 'one' })
    advanceSecond()
    const twosSlot = A('two').edctSec!

    for (let i = 0; i < 40000 && !sim.dispatch({ type: 'clearedForTakeoff', aircraftId: 'one' }).ok; i += 1) {
      sim.step(0.1)
    }
    expect(sim.snapshot().slotsMet).toBe(1)
    for (let i = 0; i < 6000 && sim.snapshot().aircraft.some((a) => a.id === 'one'); i += 1) sim.step(0.1)
    expect(sim.snapshot().departed).toBe(1)
    for (let i = 0; i < 3000; i += 1) sim.step(0.1) // wake interval

    const res = sim.dispatch({ type: 'clearedForTakeoff', aircraftId: 'two' })
    expect(res.ok).toBe(false)
    expect(res).toEqual({ ok: false, reason: expect.stringMatching(/slot missed/) })
    expect(sim.snapshot().slotsMissed).toBe(1)
    expect(A('two').edctSec).toBeGreaterThan(twosSlot) // re-issued, and it waits again

    // …and the new one is makeable, which is what stops a cascade being a dead end.
    for (let i = 0; i < 40000 && !sim.dispatch({ type: 'clearedForTakeoff', aircraftId: 'two' }).ok; i += 1) {
      sim.step(0.1)
    }
    expect(sim.snapshot().slotsMet).toBe(2)
  })

  it('does not let a slot stop an arrival landing over the field', () => {
    // A slot is a departure's constraint. An aircraft holding one must never be a reason an
    // arrival cannot be worked — it holds short or lines up, and the landing traffic is the
    // runway's own business.
    const { sim } = twoAtTheRunway({ slots: { rate: 1, seed: 5, ...LEAD } })
    sim.dispatch({ type: 'lineUpAndWait', aircraftId: 'one' }) // holding on the runway for it
    const game = createAirportGame(KSAN, 1)
    sim.add({
      id: 'arr', callsign: 'ARR1', type: 'B738', wake: 'M',
      path: [game.spawn.approach.fix, game.spawn.approach.threshold],
      targetSpeed: 140, airborne: true, intent: 'arrival',
      goalPoint: KSAN.fleets[0]!.gates[2]!.point, gate: KSAN.fleets[0]!.gates[2]!.ref,
    })
    expect(sim.dispatch({ type: 'clearedToLand', aircraftId: 'arr' })).toEqual({ ok: true })
  })
})

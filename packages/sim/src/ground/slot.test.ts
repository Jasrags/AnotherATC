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

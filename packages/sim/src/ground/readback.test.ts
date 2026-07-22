import { describe, it, expect } from 'vitest'
import { APPROACH_SPEED_KT, createGroundSim } from './sim'
import type { AircraftInit, GroundSimOptions } from './sim'
import { KSAN } from '../world/ksanAirport'
import { createAirportGame } from '../world/airport'
import { buildTaxiGraph } from './taxiGraph'
import { buildRunwayGuard } from './runwayGuard'
import type { ActiveRunway } from './runway'

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

/** Always misheard / never misheard, so the mechanic is testable without hunting a seed. */
const always: GroundSimOptions = { readback: { errorRate: 1, seed: 7 } }
const never: GroundSimOptions = { readback: { errorRate: 0, seed: 7 } }

const last = (sim: ReturnType<typeof createGroundSim>) => sim.snapshot().comms.at(-1)!
const only = (sim: ReturnType<typeof createGroundSim>) => sim.snapshot().aircraft[0]!

describe('read-back verification', () => {
  it('is off by default — no configuration, no misheard clearances', () => {
    const sim = createGroundSim([parked('a')])
    sim.dispatch({ type: 'clearance', aircraftId: 'a' })
    expect(last(sim).text).toContain(only(sim).squawk!)
    expect(sim.snapshot().readbackErrors).toBe(0)
  })

  it('a wrong read-back quotes a different code — and the aircraft squawks what it read back', () => {
    const sim = createGroundSim([parked('a')], always)
    sim.dispatch({ type: 'clearance', aircraftId: 'a' })

    const readback = last(sim).text
    const issued = sim.snapshot().comms.at(-2)!.text
    const said = /squawk ([0-7]{4})/.exec(issued)![1]!
    const read = /squawk ([0-7]{4})/.exec(readback)![1]!
    expect(read).not.toBe(said)
    // The pilot flies what they heard, not what was said. That is the whole mechanic.
    expect(only(sim).squawk).toBe(read)
    expect(sim.snapshot().readbackErrors).toBe(1)
  })

  it('a zero error rate never mishears', () => {
    const sim = createGroundSim([parked('a')], never)
    sim.dispatch({ type: 'clearance', aircraftId: 'a' })
    expect(last(sim).text).toContain(only(sim).squawk!)
    expect(sim.snapshot().readbackErrors).toBe(0)
  })

  it('"say again" re-issues the clearance and restores what the controller actually said', () => {
    const sim = createGroundSim([parked('a')], always)
    sim.dispatch({ type: 'clearance', aircraftId: 'a' })
    const said = /squawk ([0-7]{4})/.exec(sim.snapshot().comms[0]!.text)![1]!
    expect(only(sim).squawk).not.toBe(said)

    expect(sim.dispatch({ type: 'sayAgain', aircraftId: 'a' })).toEqual({ ok: true })
    expect(only(sim).squawk).toBe(said)
    expect(sim.snapshot().readbackCaught).toBe(1)
    // The correction is on the air, and the second read-back is right.
    const [instruction, readback] = sim.snapshot().comms.slice(-2)
    expect(instruction!.text).toContain('negative')
    expect(readback!.text).toContain(said)
  })

  it('"say again" on a correct read-back simply repeats it — the player is never told they were right', () => {
    const sim = createGroundSim([parked('a')], never)
    sim.dispatch({ type: 'clearance', aircraftId: 'a' })
    const code = only(sim).squawk

    expect(sim.dispatch({ type: 'sayAgain', aircraftId: 'a' })).toEqual({ ok: true })
    expect(only(sim).squawk).toBe(code)
    expect(sim.snapshot().comms.at(-2)!.text).toContain('negative')
    // A wasted transmission is not a caught error.
    expect(sim.snapshot().readbackCaught).toBe(0)
  })

  it('refuses "say again" when nothing has been said to that aircraft yet', () => {
    const sim = createGroundSim([parked('a')], always)
    expect(sim.dispatch({ type: 'sayAgain', aircraftId: 'a' }).ok).toBe(false)
  })

  it('repeats the latest instruction — and still puts a stale wrong code right', () => {
    const sim = createGroundSim([parked('a')], always)
    sim.dispatch({ type: 'clearance', aircraftId: 'a' })
    sim.dispatch({ type: 'hold', aircraftId: 'a' }) // a new clearance, correctly read back or not
    sim.dispatch({ type: 'sayAgain', aircraftId: 'a' })

    // What is *said* is the latest instruction: "say again" repeats what was said most
    // recently, not a stale one.
    expect(sim.snapshot().comms.at(-2)!.text).toContain('hold position')
    // The code, though, is not a thing that was said — it is a thing the transponder is set
    // to, and it stays set wrong through every instruction that follows. It used to be
    // treated as superseded, which made an uncaught error permanent *and* invisible: nothing
    // could correct it and nothing could tell it had happened.
    expect(sim.snapshot().readbackCaught).toBe(1)
    expect(sim.snapshot().aircraft[0]!.squawk).toBe(
      /squawk ([0-7]{4})/.exec(sim.snapshot().comms[0]!.text)![1]!,
    )
  })

  it('is deterministic: the same seed mishears the same clearances', () => {
    const opts: GroundSimOptions = { readback: { errorRate: 0.5, seed: 42 } }
    const run = () => {
      const sim = createGroundSim([parked('a'), parked('b'), parked('c')], opts)
      for (const id of ['a', 'b', 'c']) sim.dispatch({ type: 'clearance', aircraftId: id })
      return sim.snapshot().aircraft.map((x) => x.squawk).join(',')
    }
    expect(run()).toBe(run())
  })
})

// End-to-end on the real field: the mechanic only means anything if a misheard clearance
// survives all the way through the flight unless the controller catches it.
describe('read-back through a whole KSAN departure', () => {
  const build = (errorRate: number) => {
    const graph = buildTaxiGraph(KSAN.surface)
    const guard = buildRunwayGuard(KSAN.surface)
    const game = createAirportGame(KSAN)
    const sim = createGroundSim(game.inits, {
      graph,
      guard,
      runway: game.runway,
      servicing: game.servicing,
      frequencies: { ground: KSAN.comms.ground, tower: KSAN.comms.tower },
      readback: { errorRate, seed: 3 },
    })
    return { sim, id: game.inits[0]!.id }
  }
  const fly = (sim: ReturnType<typeof createGroundSim>, id: string, correct: boolean) => {
    const at = () => sim.snapshot().aircraft.find((a) => a.id === id)!
    sim.dispatch({ type: 'clearance', aircraftId: id })
    if (correct) sim.dispatch({ type: 'sayAgain', aircraftId: id })
    for (let i = 0; i < 1200; i += 1) sim.step(0.1)
    sim.dispatch({ type: 'pushback', aircraftId: id })
    for (let i = 0; i < 600; i += 1) sim.step(0.1)
    sim.dispatch({ type: 'taxiToGoal', aircraftId: id })
    for (let i = 0; i < 20000 && !at().holdShort; i += 1) sim.step(0.1)
    sim.dispatch({ type: 'contactTower', aircraftId: id })
    return at()
  }
  /** The code the controller actually issued, read off the transcript. */
  const issued = (sim: ReturnType<typeof createGroundSim>) =>
    /squawk ([0-7]{4})/.exec(sim.snapshot().comms.find((t) => t.from === 'controller')!.text)![1]!

  it('an uncaught error follows the aircraft to the runway, and stops it there', () => {
    const { sim, id } = build(1)
    const ac = fly(sim, id, false)
    expect(ac.holdShort).toBe(true)
    expect(ac.squawk).not.toBe(issued(sim))
    expect(sim.snapshot().readbackErrors).toBe(1)
    expect(sim.snapshot().readbackCaught).toBe(0)
    // Nothing on the way stops it: pushback, taxi and the hold-short line are all indifferent
    // to what it is squawking, which is what gives the controller the whole taxi to notice.
    // The handoff is where it finally costs something — Ground does not hand the next position
    // an aircraft it cannot identify.
    expect(ac.controlledBy).toBe('ground') // `fly` tried the handoff; it was refused
    expect(sim.dispatch({ type: 'contactTower', aircraftId: id })).toEqual({
      ok: false,
      reason: 'verify transponder code — the read-back was never checked',
    })
    // …and the fix is the one the controller should have used a taxi ago.
    expect(sim.dispatch({ type: 'sayAgain', aircraftId: id })).toEqual({ ok: true })
    expect(sim.dispatch({ type: 'contactTower', aircraftId: id })).toEqual({ ok: true })
  })

  it('catching it at the gate puts the right code on the aircraft for the rest of the flight', () => {
    const { sim, id } = build(1)
    const ac = fly(sim, id, true)
    expect(ac.squawk).toBe(issued(sim))
    expect(sim.snapshot().readbackCaught).toBe(1)
  })
})

// The transcript must never assert something the simulation has already retracted. A clearance
// the sim voids on its own — without any command — stops being repeatable at that moment.
describe('clearances the sim voids on its own are no longer repeatable', () => {
  const runway: ActiveRunway = {
    ident: '27',
    threshold: [0.5, 0],
    departureStart: [0.6, 0],
    farEnd: [-0.6, 0],
    toraFt: 7000,
    ldaFt: 6500,
    glidePathDeg: 3,
    pattern: 'left',
  }
  const arrivalSim = () => {
    const sim = createGroundSim(
      [
        {
          id: 'r',
          callsign: 'r',
          type: 'B738',
          wake: 'M',
          path: [[4.5, 0], [0.5, 0]],
          targetSpeed: APPROACH_SPEED_KT,
          airborne: true,
          intent: 'arrival',
          goalPoint: [0.5, 0],
        },
      ],
      { runway },
    )
    return sim
  }

  it('a landing clearance stops being repeatable the moment it is used', () => {
    const sim = arrivalSim()
    expect(sim.dispatch({ type: 'clearedToLand', aircraftId: 'r' })).toEqual({ ok: true })
    // Fly it to the threshold and around again — the sim does this with no command at all.
    for (let i = 0; i < 4000; i += 1) sim.step(0.1)
    expect(sim.snapshot().aircraft[0]!.status).toBe('rollout') // it landed on the clearance
    // The clearance is spent the moment it is used; there is nothing left to repeat.
    expect(sim.dispatch({ type: 'sayAgain', aircraftId: 'r' }).ok).toBe(false)
  })

  it('a runway change goes the arrival around, and the voided clearance is not repeatable', () => {
    const sim = arrivalSim()
    sim.dispatch({ type: 'clearedToLand', aircraftId: 'r' })
    // While it is in force, it repeats.
    expect(sim.dispatch({ type: 'sayAgain', aircraftId: 'r' })).toEqual({ ok: true })
    expect(sim.snapshot().comms.at(-2)!.text).toContain('cleared to land')

    // Turning the airport around sends everything on final around — no command to the aircraft.
    const other: ActiveRunway = {
      ...runway,
      ident: '09',
      threshold: [-0.5, 0],
      departureStart: [-0.6, 0],
      farEnd: [0.6, 0],
    }
    expect(sim.setRunway(other)).toEqual({ ok: true })
    expect(sim.snapshot().comms.at(-1)!.text).toContain('going around')
    expect(sim.snapshot().aircraft[0]!.status).toBe('onFinal') // clearance voided by the sim
    expect(sim.dispatch({ type: 'sayAgain', aircraftId: 'r' }).ok).toBe(false)
  })
})

describe('an unverified read-back bites at the handoff', () => {
  const graph = buildTaxiGraph(KSAN.surface)
  const guard = buildRunwayGuard(KSAN.surface)

  /** A KSAN departure cleared, pushed back and taxied to hold short of the runway. */
  function heldShort(opts: GroundSimOptions) {
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
    expect(D().status).toBe('holdShort')
    return { sim, D }
  }

  it('refuses to hand on an aircraft squawking a code nobody issued', () => {
    // The point at which a missed read-back has to cost something. Ground owns this aircraft
    // until the handoff and has had the whole taxi to notice; handing it on with the wrong code
    // is handing the next position an aircraft it cannot identify.
    const { sim } = heldShort(always)
    expect(sim.dispatch({ type: 'contactTower', aircraftId: 'd' })).toEqual({
      ok: false,
      reason: 'verify transponder code — the read-back was never checked',
    })
  })

  it('lets it go once "say again" has put the code right', () => {
    const { sim, D } = heldShort(always)
    const issued = sim.snapshot().comms.find((c) => c.text.includes('squawk'))!.text
    expect(issued).not.toContain(D().squawk!) // it is squawking what it misheard

    expect(sim.dispatch({ type: 'sayAgain', aircraftId: 'd' })).toEqual({ ok: true })
    expect(issued).toContain(D().squawk!) // …and now what it was told
    expect(sim.dispatch({ type: 'contactTower', aircraftId: 'd' })).toEqual({ ok: true })
    expect(sim.snapshot().readbackCaught).toBe(1)
  })

  it('never gets in the way when the read-back was right', () => {
    const { sim } = heldShort(never)
    expect(sim.dispatch({ type: 'contactTower', aircraftId: 'd' })).toEqual({ ok: true })
  })

  it('does not gate a crossing — a transit is not being identified by anybody', () => {
    // The code matters because the position taking the aircraft has to find it on radar. An
    // aircraft handed to Tower to *cross* the runway is coming straight back to Ground;
    // refusing that would strand it at a hold-short line over a code nothing is about to use.
    const game = createAirportGame(KSAN, 1)
    const slot = KSAN.fleets[0]!.gates[0]! // a terminal stand, south of the runway
    const northRamp = KSAN.fleets.find((f) => f.kind === 'cargo')!.gates[0]! // …and across it
    const sim = createGroundSim(
      [{
        id: 'x', callsign: 'SKW9', type: 'B738', wake: 'M',
        path: [slot.point], targetSpeed: 0,
        ...(slot.headingDeg !== undefined ? { heading: slot.headingDeg } : {}),
        // Its goal is the far side of the field, not the runway: "where is it going" is what
        // makes the runway something to cross rather than something to use.
        intent: 'departure', gate: slot.ref, goalPoint: northRamp.point,
      }],
      { graph, guard, runway: game.runway, stands: game.stands, ...always },
    )
    const X = () => sim.snapshot().aircraft.find((a) => a.id === 'x')!
    sim.dispatch({ type: 'clearance', aircraftId: 'x' })
    sim.dispatch({ type: 'pushback', aircraftId: 'x' })
    for (let i = 0; i < 2000 && X().status === 'pushback'; i += 1) sim.step(0.1)
    expect(sim.dispatch({ type: 'taxiToGoal', aircraftId: 'x' }).ok).toBe(true)
    for (let i = 0; i < 40000 && X().status !== 'holdShort'; i += 1) sim.step(0.1)
    expect(X().status).toBe('holdShort')
    expect(X().holdingForTakeoff).toBe(false) // holding to cross, not to depart
    expect(sim.dispatch({ type: 'contactTower', aircraftId: 'x' }).ok).toBe(true)
  })
})

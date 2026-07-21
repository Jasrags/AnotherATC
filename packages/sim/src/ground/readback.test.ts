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

  it('a second clearance replaces what "say again" would correct', () => {
    const sim = createGroundSim([parked('a')], always)
    sim.dispatch({ type: 'clearance', aircraftId: 'a' })
    sim.dispatch({ type: 'hold', aircraftId: 'a' }) // a new clearance, correctly read back or not
    // Correcting now repeats the *latest* instruction, not the stale one — and the earlier
    // mishearing is beyond correcting, because that is no longer what was said.
    sim.dispatch({ type: 'sayAgain', aircraftId: 'a' })
    expect(sim.snapshot().comms.at(-2)!.text).toContain('hold position')
    expect(sim.snapshot().readbackCaught).toBe(0)
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

  it('an uncaught error follows the aircraft to the runway', () => {
    const { sim, id } = build(1)
    const ac = fly(sim, id, false)
    expect(ac.holdShort).toBe(true)
    expect(ac.squawk).not.toBe(issued(sim))
    expect(sim.snapshot().readbackErrors).toBe(1)
    expect(sim.snapshot().readbackCaught).toBe(0)
    // It is legal in every other respect — a wrong squawk is a quiet error, not a blocked one.
    expect(sim.dispatch({ type: 'clearedForTakeoff', aircraftId: id })).toEqual({ ok: true })
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

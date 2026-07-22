import { describe, it, expect } from 'vitest'
import { KSAN } from '../world/ksanAirport'
import { createAirportGame } from '../world/airport'
import { createGroundSim } from './sim'
import { buildTaxiGraph } from './taxiGraph'
import { buildRunwayGuard } from './runwayGuard'
import { KSAN_SURFACE } from '../world/ksan'
import type { AircraftInit } from './sim'

const graph = buildTaxiGraph(KSAN_SURFACE)
const guard = buildRunwayGuard(KSAN_SURFACE)
const game = createAirportGame(KSAN, 1)
const gates = KSAN.fleets[0]!.gates

const inbound = (id: string, gateIndex = 0): AircraftInit => ({
  id,
  callsign: id.toUpperCase(),
  type: 'B738',
  wake: 'M',
  path: [game.spawn.approach.fix, game.spawn.approach.threshold],
  targetSpeed: 140,
  airborne: true,
  intent: 'arrival',
  goalPoint: gates[gateIndex]!.point,
  gate: gates[gateIndex]!.ref,
})

/**
 * How long an aircraft has been waiting on the controller.
 *
 * An arrival that has checked in with Ground has been issued nothing and cannot move until it
 * is; left alone it holds its turnoff indefinitely, quietly, looking exactly like an aircraft
 * that is fine. This is the clock that says otherwise.
 */
describe('awaitingSec', () => {
  const sim = () =>
    createGroundSim([inbound('a')], { graph, guard, runway: game.runway, stands: game.stands })
  const A = (s: ReturnType<typeof sim>) => s.snapshot().aircraft.find((x) => x.id === 'a')!

  /** Land it and get it onto Ground's frequency, stopped in its turnoff. */
  function checkedIn() {
    const s = sim()
    s.dispatch({ type: 'clearedToLand', aircraftId: 'a' })
    for (let i = 0; i < 6000 && A(s).status !== 'rollout'; i += 1) s.step(0.1)
    s.dispatch({ type: 'contactGround', aircraftId: 'a' })
    for (let i = 0; i < 6000 && A(s).controlledBy !== 'ground'; i += 1) s.step(0.1)
    return s
  }

  it('is zero while the aircraft is still flying or rolling out — nobody is waiting yet', () => {
    const s = sim()
    expect(A(s).awaitingSec).toBe(0)
    s.dispatch({ type: 'clearedToLand', aircraftId: 'a' })
    for (let i = 0; i < 6000 && A(s).status !== 'rollout'; i += 1) s.step(0.1)
    expect(A(s).awaitingSec).toBe(0)
  })

  it('counts up once it has checked in with Ground and been issued nothing', () => {
    const s = checkedIn()
    for (let i = 0; i < 600; i += 1) s.step(0.1) // a minute of being ignored
    expect(A(s).awaitingSec).toBeGreaterThanOrEqual(59)
    expect(A(s).awaitingSec).toBeLessThanOrEqual(61)
  })

  it('is whole seconds, so the strip is not re-rendered ten times a second', () => {
    const s = checkedIn()
    for (let i = 0; i < 55; i += 1) s.step(0.1)
    expect(Number.isInteger(A(s).awaitingSec)).toBe(true)
  })

  it('stops the moment Ground actually taxis it', () => {
    const s = checkedIn()
    for (let i = 0; i < 300; i += 1) s.step(0.1)
    expect(A(s).awaitingSec).toBeGreaterThan(0)
    s.dispatch({ type: 'taxiToGoal', aircraftId: 'a' })
    s.step(0.1)
    expect(A(s).awaitingSec).toBe(0)
    for (let i = 0; i < 300; i += 1) s.step(0.1)
    expect(A(s).awaitingSec).toBe(0) // and stays stopped while it runs the clearance
  })

  it('starts again if it is stopped mid-taxi and left there with the route spent', () => {
    // "Hold position" is an instruction, so it is not waiting on anybody: the clock only runs
    // when there is no clearance left to run.
    const s = checkedIn()
    s.dispatch({ type: 'taxiToGoal', aircraftId: 'a' })
    for (let i = 0; i < 100; i += 1) s.step(0.1)
    s.dispatch({ type: 'hold', aircraftId: 'a' })
    for (let i = 0; i < 300; i += 1) s.step(0.1)
    expect(A(s).awaitingSec).toBe(0)
  })

  it('does not run for a departure parked on its stand', () => {
    // It is waiting for its clearance, which the strip already says, and it is not holding
    // anything up by sitting there. Counting it would make the signal mean nothing.
    const s = createGroundSim(createAirportGame(KSAN, 1).inits, {
      graph,
      guard,
      runway: game.runway,
      stands: game.stands,
      servicing: game.servicing,
    })
    for (let i = 0; i < 600; i += 1) s.step(0.1)
    expect(s.snapshot().aircraft.every((x) => x.awaitingSec === 0)).toBe(true)
  })

  it('runs for a departure left sitting on the alley after its pushback', () => {
    // Same failure, same signal: pushed off the stand, facing a taxiway, told nothing since.
    const inits = createAirportGame(KSAN, 1).inits
    const s = createGroundSim(inits, { graph, guard, runway: game.runway, stands: game.stands })
    const id = inits[0]!.id
    const B = () => s.snapshot().aircraft.find((x) => x.id === id)!
    s.dispatch({ type: 'clearance', aircraftId: id })
    expect(s.dispatch({ type: 'pushback', aircraftId: id }).ok).toBe(true)
    for (let i = 0; i < 3000 && B().status === 'pushback'; i += 1) s.step(0.1)
    expect(B().status).not.toBe('pushback') // the push is done; it is now nobody's business
    for (let i = 0; i < 600; i += 1) s.step(0.1)
    expect(B().awaitingSec).toBeGreaterThan(30)
  })
})

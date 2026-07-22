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

/**
 * A turnoff holds one aircraft.
 *
 * Since an arrival stops in its turnoff and waits there for a taxi clearance, the turnoff a
 * landing is planned onto is a place that can already be taken — and a rollout is the one
 * movement separation cannot rescue, because it meets the aircraft ahead inside the curve at
 * a speed it cannot stop from. Tested on the real field, through the real command sequence.
 */
describe('a landing is not sent to an occupied turnoff', () => {
  const game = createAirportGame(KSAN, 1)
  const gates = KSAN.fleets[0]!.gates

  const inbound = (id: string, gateIndex: number): AircraftInit => ({
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

  function landAndCheckIn() {
    const sim = createGroundSim([inbound('one', 0)], {
      graph,
      guard,
      runway: game.runway,
      stands: game.stands,
    })
    const A = (id: string) => sim.snapshot().aircraft.find((x) => x.id === id)
    sim.dispatch({ type: 'clearedToLand', aircraftId: 'one' })
    for (let i = 0; i < 6000 && A('one')!.status !== 'rollout'; i += 1) sim.step(0.1)
    sim.dispatch({ type: 'contactGround', aircraftId: 'one' })
    for (let i = 0; i < 6000 && A('one')!.controlledBy !== 'ground'; i += 1) sim.step(0.1)
    for (let i = 0; i < 300; i += 1) sim.step(0.1) // let it roll to a stop in the turnoff
    return { sim, A }
  }

  it('sends the second landing to a different turnoff, and neither drives into the other', () => {
    const { sim, A } = landAndCheckIn()
    const first = A('one')!
    expect(first.groundspeed).toBe(0) // sitting in its turnoff, awaiting a taxi clearance
    expect(first.exitRef).not.toBeNull()

    sim.add(inbound('two', 1))
    sim.dispatch({ type: 'clearedToLand', aircraftId: 'two' })
    let minSepNm = Infinity
    let conflicted = false
    for (let i = 0; i < 6000; i += 1) {
      sim.step(0.1)
      const a = A('one')
      const b = A('two')
      if (!a || !b) break
      if (b.status !== 'onFinal' && b.status !== 'landing') {
        minSepNm = Math.min(minSepNm, Math.hypot(a.x - b.x, a.y - b.y))
        conflicted ||= a.conflict || b.conflict
      }
      if (b.status === 'rollout' && !b.handoffPending) {
        sim.dispatch({ type: 'contactGround', aircraftId: 'two' })
      }
    }

    const [a, b] = [A('one')!, A('two')!]
    expect(b.exitRef).not.toBe(a.exitRef) // it took a different turnoff…
    expect(b.onRunway).toBe(false) // …and got off the runway on it
    expect(minSepNm).toBeGreaterThan(0.03) // never nose-to-nose
    expect(conflicted).toBe(false)
  })

  it('does not offer the controller a turnoff someone is standing in', () => {
    const { sim, A } = landAndCheckIn()
    const taken = A('one')!.exitRef!

    sim.add(inbound('two', 1))
    sim.dispatch({ type: 'clearedToLand', aircraftId: 'two' })
    const offered = sim.exitOptions('two').map((e) => e.ref)
    expect(offered.length).toBeGreaterThan(0)
    expect(offered).not.toContain(taken)
    expect(sim.dispatch({ type: 'assignExit', aircraftId: 'two', ref: taken })).toEqual({
      ok: false,
      reason: `unable ${taken} — cannot slow down in time`,
    })
  })
})

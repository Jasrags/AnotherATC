import { describe, it, expect } from 'vitest'
import { createGroundSim, type AircraftInit } from './sim'
import { buildTaxiGraph } from './taxiGraph'
import { buildRunwayGuard, runwayIdAt } from './runwayGuard'
import { KBUR, KBUR_RUNWAYS } from '../world/kburAirport'

/**
 * A departure's runway is wherever it is going — its `goalPoint` — and taxiing it to a *different*
 * runway has to move that goal, or the sim keeps deciding its runway (targetRunwayId reads the goal
 * first) from a stale target. The bug this guards: a dev-placed departure whose goal was runway 33
 * was taxied to runway 26; the route rebuilt to 26 but the goal stayed 33, so it was refused a
 * line-up ("RWY 33…") while physically holding short of 26, and its hold-short landed by the wrong
 * runway. See the DEV05 report. KBUR is the two-runway field where it bit.
 */
const graph = buildTaxiGraph(KBUR.surface)
const guard = buildRunwayGuard(KBUR.surface)
const end26 = KBUR_RUNWAYS['26'].departureStart
const end33 = KBUR_RUNWAYS['33'].departureStart

/** A departure parked at the first gate, its goal preset to runway 33's departure end. */
const departureGoalingAt33 = (): AircraftInit => {
  const gate = KBUR.fleets[0]!.gates[0]!
  return {
    id: 'd',
    callsign: 'SWA1',
    type: 'B738',
    wake: 'M',
    path: [gate.point],
    targetSpeed: 0,
    intent: 'departure',
    gate: gate.ref,
    goalPoint: end33,
  }
}
const mkSim = () => createGroundSim([departureGoalingAt33()], { graph, guard, runwaysInteract: () => false })

describe('taxiing a departure to a runway retargets its goal (DEV05)', () => {
  it('starts out goaling at the runway it was given', () => {
    const sim = mkSim()
    expect(sim.inspect('d')!.goalPoint).toEqual(end33)
    expect(runwayIdAt(end33, guard)).toBe(runwayIdAt(end33, guard)) // sanity: end33 resolves to a runway
  })

  it('moves the goal onto the runway it is taxied to', () => {
    const sim = mkSim()
    expect(sim.dispatch({ type: 'taxiTo', aircraftId: 'd', dest: end26, exact: true }).ok).toBe(true)
    // The goal is now runway 26's end — so targetRunwayId (which reads the goal) names 26, the
    // runway it is actually taxiing to, not the stale 33.
    expect(sim.inspect('d')!.goalPoint).toEqual(end26)
    expect(runwayIdAt(sim.inspect('d')!.goalPoint!, guard)).toBe(runwayIdAt(end26, guard))
    expect(runwayIdAt(end26, guard)).not.toBe(runwayIdAt(end33, guard)) // the two really are different runways
  })

  it('leaves the goal alone when taxied to a non-runway point (a gate, or a crossing beyond the runway)', () => {
    const sim = mkSim()
    const otherGate = KBUR.fleets[0]!.gates[1]!.point
    expect(sim.dispatch({ type: 'taxiTo', aircraftId: 'd', dest: otherGate, exact: true }).ok).toBe(true)
    expect(sim.inspect('d')!.goalPoint).toEqual(end33) // unchanged — a gate is not a departure runway
  })

  it('end to end: taxied from the gate to 26, it holds short of 26 and lines up (not refused for 33)', () => {
    // The whole DEV05 sequence with only runway 26 active. Before the retarget, this departure held
    // short of 26 but the sim thought its runway was 33, so the line-up was refused "RWY 33 is not
    // in use" — the exact symptom. With the goal moved to 26, the loop completes.
    const sim = createGroundSim([departureGoalingAt33()], {
      graph,
      guard,
      runways: [KBUR_RUNWAYS['26']],
      runwaysInteract: () => false,
    })
    expect(sim.dispatch({ type: 'taxiTo', aircraftId: 'd', dest: end26, exact: true }).ok).toBe(true)
    for (let i = 0; i < 8000 && !sim.inspect('d')!.holdShort; i += 1) sim.step(0.1)
    const held = sim.inspect('d')!
    expect(held.holdShort).toBe(true)
    expect(held.holdingForTakeoff).toBe(true) // holding to depart 26, not to cross it
    expect(sim.dispatch({ type: 'contactTower', aircraftId: 'd' }).ok).toBe(true)
    const res = sim.dispatch({ type: 'lineUpAndWait', aircraftId: 'd' })
    expect(res.ok).toBe(true) // was refused "RWY 33 is not in use" before the fix
  })
})

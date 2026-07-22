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

/** A departure parked on a terminal stand, cleared and ready to be worked. */
function parked(id: string, gateIndex: number): AircraftInit {
  const slot = gates[gateIndex]!
  return {
    id,
    callsign: id.toUpperCase(),
    type: 'B738',
    wake: 'M',
    path: [slot.point],
    targetSpeed: 0,
    ...(slot.headingDeg !== undefined ? { heading: slot.headingDeg } : {}),
    intent: 'departure',
    gate: slot.ref,
    goalPoint: game.runway.departureStart,
  }
}

/**
 * Prediction, on the real field, through the real command sequence.
 *
 * The unit tests build the geometry they want. This one takes two aircraft off two stands at
 * KSAN, taxis both toward the same runway with nothing but ordinary clearances, and asks
 * whether the scope would have warned the controller before the two met — which is the entire
 * claim being made.
 */
describe('converging traffic on the real field', () => {
  /** Two departures off two stands, pushed back and taxiing to the same runway. */
  function twoOutbound() {
    const sim = createGroundSim([parked('one', 0), parked('two', 8)], {
      graph,
      guard,
      runway: game.runway,
      stands: game.stands,
      hotspots: KSAN_SURFACE.hotspots ?? [],
    })
    for (const id of ['one', 'two']) {
      expect(sim.dispatch({ type: 'clearance', aircraftId: id }).ok).toBe(true)
      expect(sim.dispatch({ type: 'pushback', aircraftId: id }).ok).toBe(true)
    }
    for (let i = 0; i < 1200 && sim.snapshot().aircraft.some((a) => a.status === 'pushback'); i += 1) {
      sim.step(0.1)
    }
    // Both to the same runway, the ordinary way. Nothing here is contrived to make them meet:
    // one apron, one taxiway system, one runway is the whole reason ground control exists.
    for (const id of ['one', 'two']) expect(sim.dispatch({ type: 'taxiToGoal', aircraftId: id }).ok).toBe(true)
    return sim
  }

  it('warns while there is still time to act, before anyone is too close', () => {
    const sim = twoOutbound()
    let firstWarnAt = -1
    let firstConflictAt = -1
    let warned: string | null = null
    for (let i = 0; i < 6000; i += 1) {
      sim.step(0.1)
      const snap = sim.snapshot()
      const advisory = snap.conflicts.find((c) => c.severity === 'advisory')
      if (advisory && firstWarnAt < 0) {
        firstWarnAt = snap.time
        warned = advisory.message
      }
      if (snap.conflicts.some((c) => c.severity === 'alert') && firstConflictAt < 0) {
        firstConflictAt = snap.time
      }
    }

    expect(firstWarnAt).toBeGreaterThan(0) // it warned at all…
    expect(warned).toMatch(/ONE and TWO converging/)
    // …and either nothing ever became a conflict (the warning did its job / the automatic floor
    // held), or the warning came first. What must never happen is a conflict nobody saw coming.
    if (firstConflictAt >= 0) expect(firstWarnAt).toBeLessThan(firstConflictAt)
  })

  it('keeps the two flags a state machine, and the list and the flags in step', () => {
    // The scope draws a solid ring for one and a dashed ring for the other, so an aircraft in
    // both states would be drawn as both. And a flag with no entry in the list (or the reverse)
    // would mean the ring and the alert line disagreed about the same instant.
    const sim = twoOutbound()
    let sawConverging = false
    for (let i = 0; i < 6000; i += 1) {
      sim.step(0.1)
      const snap = sim.snapshot()
      const named = new Set(snap.conflicts.flatMap((c) => c.aircraftIds))
      for (const a of snap.aircraft) {
        expect(a.conflict && a.converging).toBe(false)
        expect(a.conflict || a.converging).toBe(named.has(a.id))
        if (a.converging) sawConverging = true
      }
    }
    expect(sawConverging).toBe(true)
  })

  it('says nothing at all about a field with one aircraft on it', () => {
    const quiet = createGroundSim([parked('solo', 0)], { graph, guard, runway: game.runway, stands: game.stands })
    quiet.dispatch({ type: 'clearance', aircraftId: 'solo' })
    quiet.dispatch({ type: 'pushback', aircraftId: 'solo' })
    for (let i = 0; i < 600; i += 1) quiet.step(0.1)
    quiet.dispatch({ type: 'taxiToGoal', aircraftId: 'solo' })
    for (let i = 0; i < 3000; i += 1) {
      quiet.step(0.1)
      expect(quiet.snapshot().conflicts).toEqual([])
    }
  })
})

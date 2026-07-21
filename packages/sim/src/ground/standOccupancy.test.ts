import { describe, expect, it } from 'vitest'
import { createGroundSim } from './sim'
import { buildTaxiGraph } from './taxiGraph'
import { buildRunwayGuard } from './runwayGuard'
import { buildStands } from './stands'
import { createAirportGame } from '../world/airport'
import { KSAN } from '../world/ksanAirport'
import type { Point } from '../world/types'

const dist = (a: Point, b: Point): number => Math.hypot(a[0] - b[0], a[1] - b[1])
const graph = buildTaxiGraph(KSAN.surface)
const stands = buildStands(KSAN.surface)

function field() {
  const game = createAirportGame(KSAN)
  const sim = createGroundSim(game.inits, {
    graph,
    guard: buildRunwayGuard(KSAN.surface),
    runway: game.runway,
    servicing: game.servicing,
    stands: game.stands,
  })
  return { game, sim }
}

/**
 * Put an arrival on the alley heading for `ref`'s lead-in, approaching from a realistic distance.
 *
 * The graph is densely vertexed, so the entry's immediate neighbour is only ~20 m away — an
 * aircraft placed there starts *inside* the hold zone and simply coasts to a stop on the paint,
 * which tests nothing. Walk out along the alley until it is a real approach.
 */
function inbound(sim: ReturnType<typeof createGroundSim>, ref: string, id = 'arr') {
  const stand = stands.find((s) => s.ref === ref)!
  const entryKey = graph.nearestNode(stand.entry)!
  const legs: Point[] = [graph.nodePoint(entryKey)!]
  let cur = entryKey
  let prev: string | null = null
  let out = 0
  while (out < 0.35) {
    const next = graph.neighbours(cur).find((n) => n !== prev)
    if (!next) break
    const p = graph.nodePoint(next)!
    out += dist(legs[0]!, p) - out > 0 ? dist(graph.nodePoint(cur)!, p) : 0
    legs.unshift(p)
    prev = cur
    cur = next
  }
  sim.add({
    id,
    callsign: id.toUpperCase(),
    type: 'B738',
    wake: 'M',
    path: legs,
    targetSpeed: 15,
    intent: 'arrival',
    gate: ref,
    goalPoint: stand.stop,
  })
  return { stand, at: () => sim.snapshot().aircraft.find((a) => a.id === id)! }
}

describe('a stand is a resource, not a label', () => {
  it('reports a stand as occupied while an aircraft is parked on it', () => {
    const { game, sim } = field()
    const parked = sim.snapshot().aircraft.find((a) => a.gate !== null)!
    expect(sim.standOccupied(parked.gate!)).toBe(true)
    // A stand nobody is on is free.
    const taken = new Set(sim.snapshot().aircraft.map((a) => a.gate))
    const empty = game.stands.find((s) => !taken.has(s.ref))!
    expect(sim.standOccupied(empty.ref)).toBe(false)
  })

  it('holds an arrival on the alley, short of the paint, while its gate is taken', () => {
    const { sim } = field()
    const occupiedRef = sim.snapshot().aircraft.find((a) => a.gate !== null)!.gate!
    const { stand, at } = inbound(sim, occupiedRef)

    sim.dispatch({ type: 'taxiToGoal', aircraftId: 'arr' })
    for (let i = 0; i < 4000; i += 1) sim.step(0.1)

    // Stopped well short of the paint, leaving the stand's own lead-in clear so the aircraft on
    // it can still push back and get out — holding nose-to-nose would deadlock the pair.
    const a = at()
    expect(a.groundspeed).toBeLessThanOrEqual(0.5)
    expect(dist([a.x, a.y], stand.entry)).toBeGreaterThan(dist(stand.entry, stand.stop))
    expect(a.waitingForStand).toBe(occupiedRef)
    // The gate is still held by the aircraft actually on it.
    expect(sim.standOccupied(occupiedRef)).toBe(true)
  })

  it('lets it in on its own once the stand frees, with no new clearance', () => {
    const { sim } = field()
    const blocker = sim.snapshot().aircraft.find((a) => a.gate !== null)!
    const { stand, at } = inbound(sim, blocker.gate!)

    sim.dispatch({ type: 'taxiToGoal', aircraftId: 'arr' })
    for (let i = 0; i < 3000; i += 1) sim.step(0.1)
    expect(at().waitingForStand).toBe(blocker.gate)

    // Free the gate: the blocker pushes back and taxis away.
    for (let i = 0; i < 1200; i += 1) sim.step(0.1) // its ground servicing
    expect(sim.dispatch({ type: 'pushback', aircraftId: blocker.id })).toEqual({ ok: true })
    for (let i = 0; i < 900; i += 1) sim.step(0.1) // …off the stand onto the alley
    // …and away, or it just blocks the alley instead of the stand.
    sim.dispatch({ type: 'taxiToGoal', aircraftId: blocker.id })
    for (let i = 0; i < 20000; i += 1) {
      sim.step(0.1)
      if (dist([at().x, at().y], stand.stop) < 0.004) break
    }

    // It went in by itself — the clearance was always good, the gate just wasn't.
    expect(dist([at().x, at().y], stand.stop)).toBeLessThan(0.02)
    expect(at().waitingForStand).toBeNull()
  })

  it('does not hold an aircraft already parked on its own stand', () => {
    const { sim } = field()
    const parked = sim.snapshot().aircraft.find((a) => a.gate !== null)!
    // It occupies its own gate, but must not be blocked by itself.
    expect(sim.snapshot().aircraft.find((a) => a.id === parked.id)!.waitingForStand).toBeNull()
    for (let i = 0; i < 1200; i += 1) sim.step(0.1)
    expect(sim.dispatch({ type: 'pushback', aircraftId: parked.id })).toEqual({ ok: true })
  })

  it('holds only for its own gate, not for a neighbour that happens to be occupied', () => {
    const { sim } = field()
    const taken = new Set(sim.snapshot().aircraft.map((a) => a.gate))
    const free = stands.find((s) => s.source === 'charted' && !taken.has(s.ref))!
    const { at } = inbound(sim, free.ref)

    sim.dispatch({ type: 'taxiToGoal', aircraftId: 'arr' })
    for (let i = 0; i < 4000 && dist([at().x, at().y], free.stop) > 0.004; i += 1) sim.step(0.1)
    expect(dist([at().x, at().y], free.stop)).toBeLessThan(0.02)
    expect(at().waitingForStand).toBeNull()
  })
})

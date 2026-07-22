import { describe, expect, it } from 'vitest'
import { createGroundSim } from './sim'
import { buildTaxiGraph } from './taxiGraph'
import { buildRunwayGuard } from './runwayGuard'
import { buildStands } from './stands'
import { createAirportGame } from '../world/airport'
import { KSAN } from '../world/ksanAirport'
import type { Point } from '../world/types'

const dist = (a: Point, b: Point): number => Math.hypot(a[0] - b[0], a[1] - b[1])
/** Shortest distance from `p` to a polyline — how far off the painted line the aircraft is. */
function offLine(p: Point, line: readonly Point[]): number {
  let best = Infinity
  for (let i = 1; i < line.length; i += 1) {
    const a = line[i - 1] as Point
    const b = line[i] as Point
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const len2 = dx * dx + dy * dy
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2))
    best = Math.min(best, dist(p, [a[0] + t * dx, a[1] + t * dy]))
  }
  return best
}
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

// `gateBlocked` is the field-wide signal: a conflict that has not happened yet. It is what both
// the strip warning and the scope's gate alert read, so it is asserted here rather than in the
// two places that display it.
describe('gateBlocked — a gate conflict before it happens', () => {
  it('flags an arrival still on final whose stand is occupied', () => {
    const { sim } = field()
    const occupiedRef = sim.snapshot().aircraft.find((a) => a.gate !== null)!.gate!
    const stand = stands.find((s) => s.ref === occupiedRef)!
    const ap = sim.approach()!
    sim.add({
      id: 'arr', callsign: 'ARR', type: 'B738', wake: 'M',
      path: [ap.fix, ap.threshold], targetSpeed: 140, airborne: true,
      intent: 'arrival', gate: occupiedRef, goalPoint: stand.stop,
    })
    const arr = () => sim.snapshot().aircraft.find((a) => a.id === 'arr')!
    // Still airborne, nowhere near the gate — and already flagged.
    expect(arr().altitude).toBeGreaterThan(0)
    expect(arr().gateBlocked).toBe(true)
    expect(arr().waitingForStand).toBeNull() // it hasn't bitten yet; that is the difference
  })

  it('does not flag an arrival bound for a free stand', () => {
    const { sim } = field()
    const taken = new Set(sim.snapshot().aircraft.map((a) => a.gate))
    const free = stands.find((s) => s.source === 'charted' && !taken.has(s.ref))!
    const ap = sim.approach()!
    sim.add({
      id: 'arr', callsign: 'ARR', type: 'B738', wake: 'M',
      path: [ap.fix, ap.threshold], targetSpeed: 140, airborne: true,
      intent: 'arrival', gate: free.ref, goalPoint: free.stop,
    })
    expect(sim.snapshot().aircraft.find((a) => a.id === 'arr')!.gateBlocked).toBe(false)
  })

  it('clears the moment the stand frees, with no command', () => {
    const { sim } = field()
    const blocker = sim.snapshot().aircraft.find((a) => a.gate !== null)!
    const stand = stands.find((s) => s.ref === blocker.gate)!
    const ap = sim.approach()!
    sim.add({
      id: 'arr', callsign: 'ARR', type: 'B738', wake: 'M',
      path: [ap.fix, ap.threshold], targetSpeed: 140, airborne: true,
      intent: 'arrival', gate: blocker.gate!, goalPoint: stand.stop,
    })
    const arr = () => sim.snapshot().aircraft.find((a) => a.id === 'arr')!
    expect(arr().gateBlocked).toBe(true)

    for (let i = 0; i < 1200; i += 1) sim.step(0.1) // the blocker's ground servicing
    sim.dispatch({ type: 'pushback', aircraftId: blocker.id })
    for (let i = 0; i < 900 && sim.snapshot().aircraft.find((a) => a.id === blocker.id); i += 1) {
      sim.step(0.1)
      if (!arr().gateBlocked) break
    }
    expect(arr().gateBlocked).toBe(false)
  })

  it('never flags a departure — its gate is where it came from, not where it is going', () => {
    const { sim } = field()
    const parked = sim.snapshot().aircraft.filter((a) => a.intent === 'departure' && a.gate !== null)
    expect(parked.length).toBeGreaterThan(0)
    expect(parked.every((a) => a.gateBlocked)).toBe(false)
  })
})

// Reassigning is the lever the gate alert would otherwise leave you without: the alternative to
// waiting for a blocked gate is not taking it.
describe('assignStand — sending an arrival somewhere else', () => {
  function inboundToOccupied() {
    const { sim } = field()
    const blocker = sim.snapshot().aircraft.find((a) => a.gate !== null)!
    const stand = stands.find((s) => s.ref === blocker.gate)!
    const ap = sim.approach()!
    sim.add({
      id: 'arr', callsign: 'ARR', type: 'B738', wake: 'M',
      path: [ap.fix, ap.threshold], targetSpeed: 140, airborne: true,
      intent: 'arrival', gate: blocker.gate!, goalPoint: stand.stop,
    })
    return { sim, blocker, arr: () => sim.snapshot().aircraft.find((a) => a.id === 'arr')! }
  }

  it('offers only stands that are free and unclaimed, nearest first', () => {
    const { sim, arr } = inboundToOccupied()
    const opts = sim.standOptions('arr')
    expect(opts.length).toBeGreaterThan(0)

    const claimed = new Set(sim.snapshot().aircraft.map((a) => a.gate))
    for (const o of opts) {
      expect(claimed.has(o.ref)).toBe(false) // nobody else is going there…
      expect(sim.standOccupied(o.ref)).toBe(false) // …and nobody is on it
    }
    expect(opts.some((o) => o.ref === arr().gate)).toBe(false) // not the one it already has
    // Nearest first, so the top of the menu is the sensible reassignment.
    const dists = opts.map((o) => o.distanceNm)
    expect(dists).toEqual([...dists].sort((a, b) => a - b))
  })

  it('clears the conflict — the arrival is no longer waiting on a blocked gate', () => {
    const { sim, arr } = inboundToOccupied()
    expect(arr().gateBlocked).toBe(true)

    const free = sim.standOptions('arr')[0]!
    expect(sim.dispatch({ type: 'assignStand', aircraftId: 'arr', ref: free.ref })).toEqual({ ok: true })
    expect(arr().gate).toBe(free.ref)
    expect(arr().gateBlocked).toBe(false)
  })

  it('refuses a stand that is occupied, or already promised to someone else', () => {
    const { sim, blocker } = inboundToOccupied()
    // Someone else's stand — not the one this arrival already holds, which refuses earlier
    // with "already assigned".
    const otherOccupied = sim
      .snapshot()
      .aircraft.find((a) => a.gate !== null && a.gate !== blocker.gate && a.id !== 'arr')!
    const occupied = sim.dispatch({ type: 'assignStand', aircraftId: 'arr', ref: otherOccupied.gate! })
    expect(occupied.ok).toBe(false)
    if (!occupied.ok) expect(occupied.reason).toContain('occupied')

    // A second arrival cannot be sent to a gate the first is already going to.
    const free = sim.standOptions('arr')[0]!
    sim.dispatch({ type: 'assignStand', aircraftId: 'arr', ref: free.ref })
    const ap = sim.approach()!
    sim.add({
      id: 'arr2', callsign: 'ARR2', type: 'B738', wake: 'M',
      path: [ap.fix, ap.threshold], targetSpeed: 140, airborne: true,
      intent: 'arrival', goalPoint: ap.threshold,
    })
    const taken = sim.dispatch({ type: 'assignStand', aircraftId: 'arr2', ref: free.ref })
    expect(taken.ok).toBe(false)
    if (!taken.ok) expect(taken.reason).toContain('ARR')
  })

  it('refuses an unknown stand and a departure, and says which it is', () => {
    const { sim } = inboundToOccupied()
    const bad = sim.dispatch({ type: 'assignStand', aircraftId: 'arr', ref: 'ZZ9' })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.reason).toContain('unknown stand')

    const dep = sim.snapshot().aircraft.find((a) => a.intent === 'departure')!
    const asDeparture = sim.dispatch({ type: 'assignStand', aircraftId: dep.id, ref: '20' })
    expect(asDeparture.ok).toBe(false)
    if (!asDeparture.ok) expect(asDeparture.reason).toContain('only arrivals')
  })

  it('reroutes an arrival already taxiing to the old gate', () => {
    const { sim } = field()
    const graph2 = graph
    const taken = new Set(sim.snapshot().aircraft.map((a) => a.gate))
    const from = stands.find((s) => s.source === 'charted' && !taken.has(s.ref))!
    const entryKey = graph2.nearestNode(from.entry)!
    const start = graph2.nodePoint(graph2.neighbours(entryKey)[0]!)!
    sim.add({
      id: 'arr', callsign: 'ARR', type: 'B738', wake: 'M',
      path: [start, graph2.nodePoint(entryKey)!], targetSpeed: 15,
      intent: 'arrival', gate: from.ref, goalPoint: from.stop,
    })
    sim.dispatch({ type: 'taxiToGoal', aircraftId: 'arr' })
    for (let i = 0; i < 50; i += 1) sim.step(0.1)

    const other = sim.standOptions('arr')[0]!
    expect(sim.dispatch({ type: 'assignStand', aircraftId: 'arr', ref: other.ref })).toEqual({ ok: true })
    // Its route now ends on the new stand, not the old one.
    const route = sim.routeOf('arr')
    const end = route[route.length - 1]!
    const target = stands.find((s) => s.ref === other.ref)!
    expect(dist(end, target.stop)).toBeLessThan(1e-6)
  })
})

// The non-terminal stands are most of KSAN's parking and were previously invisible to the sim:
// 72 painted lines, 32 stands. "Usable" means the same things a gate is — reachable, occupiable,
// and offered when an arrival needs somewhere else to go.
describe('remote stands are real parking', () => {
  it('an aircraft can be sent to one, and occupies it like any other stand', () => {
    const { sim } = field()
    const remote = stands.find((s) => s.kind === 'remote')!
    const entryKey = graph.nearestNode(remote.entry)!
    const from = graph.nodePoint(graph.neighbours(entryKey)[0]!)!
    sim.add({
      id: 'ga',
      callsign: 'N123AB',
      type: 'C208',
      wake: 'L',
      path: [from, graph.nodePoint(entryKey)!],
      targetSpeed: 15,
      intent: 'arrival',
      gate: remote.ref,
      goalPoint: remote.stop,
    })
    const at = () => sim.snapshot().aircraft.find((a) => a.id === 'ga')!

    expect(sim.standOccupied(remote.ref)).toBe(false)
    expect(sim.dispatch({ type: 'taxiToGoal', aircraftId: 'ga' })).toEqual({ ok: true })
    // Run until it has actually *stopped* on the mark: a stand is occupied by an aircraft
    // parked on it, not by one still creeping down the last few metres of the lead-in.
    for (let i = 0; i < 12000; i += 1) {
      sim.step(0.1)
      if (dist([at().x, at().y], remote.stop) < 0.01 && at().groundspeed === 0) break
    }

    expect(dist([at().x, at().y], remote.stop)).toBeLessThan(0.02)
    expect(offLine([at().x, at().y], remote.lead)).toBeLessThan(0.003) // came in on the paint
    expect(sim.standOccupied(remote.ref)).toBe(true)
  })

  it('is offered as somewhere else to put a blocked arrival', () => {
    const { sim } = field()
    const occupiedRef = sim.snapshot().aircraft.find((a) => a.gate !== null)!.gate!
    const stand = stands.find((s) => s.ref === occupiedRef)!
    const ap = sim.approach()!
    sim.add({
      id: 'arr', callsign: 'ARR', type: 'B738', wake: 'M',
      path: [ap.fix, ap.threshold], targetSpeed: 140, airborne: true,
      intent: 'arrival', gate: occupiedRef, goalPoint: stand.stop,
    })
    // Reassignment now has the whole field to choose from, not just the terminal.
    const refs = sim.standOptions('arr').map((o) => o.ref)
    const remoteRefs = new Set(stands.filter((s) => s.kind === 'remote').map((s) => s.ref))
    expect(refs.some((r) => remoteRefs.has(r))).toBe(true)

    const target = refs.find((r) => remoteRefs.has(r))!
    expect(sim.dispatch({ type: 'assignStand', aircraftId: 'arr', ref: target })).toEqual({ ok: true })
    expect(sim.snapshot().aircraft.find((a) => a.id === 'arr')!.gateBlocked).toBe(false)
  })

  it('is not seeded with scheduled airline traffic', () => {
    // Remote parking now has traffic of its own (cargo and GA fleets), but it is *their*
    // traffic: the airline fleet never parks on a freight apron, and the initial fill is
    // airline only. Which traffic belongs where is a scenario question, not a geometry one.
    const { game } = field()
    const remoteRefs = new Set(stands.filter((s) => s.kind === 'remote').map((s) => s.ref))
    const airline = game.spawn.fleets.find((f) => f.kind === 'airline')!
    expect(airline.gates.some((g) => remoteRefs.has(g.ref))).toBe(false)
    expect(game.inits.some((i) => i.gate !== undefined && remoteRefs.has(i.gate))).toBe(false)
  })
})

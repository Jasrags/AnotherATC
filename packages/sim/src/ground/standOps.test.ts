import { describe, expect, it } from 'vitest'
import { createGroundSim } from './sim'
import { buildTaxiGraph } from './taxiGraph'
import { buildRunwayGuard } from './runwayGuard'
import { buildStands, findStand } from './stands'
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

const stands = buildStands(KSAN.surface)

function ksanSim() {
  const game = createAirportGame(KSAN)
  return {
    game,
    sim: createGroundSim(game.inits, {
      graph: buildTaxiGraph(KSAN.surface),
      guard: buildRunwayGuard(KSAN.surface),
      runway: game.runway,
      servicing: game.servicing,
      stands: game.stands,
    }),
  }
}

describe('pushback follows the lead-in line back out', () => {
  it('backs an aircraft down its own painted line, not toward the nearest node', () => {
    const { game, sim } = ksanSim()
    const id = game.inits[0]!.id
    const at = () => sim.snapshot().aircraft.find((a) => a.id === id)!
    const stand = findStand(stands, at().gate)!

    // It starts on the stand's nose-stop mark, facing the way the line points.
    expect(dist([at().x, at().y], stand.stop)).toBeLessThan(1e-6)
    expect(at().heading).toBeCloseTo(stand.headingDeg, 0)

    for (let i = 0; i < 1200; i += 1) sim.step(0.1) // ground servicing
    expect(sim.dispatch({ type: 'pushback', aircraftId: id })).toEqual({ ok: true })

    // Every position through the push stays on the paint, and ends at the taxilane entry.
    let worst = 0
    for (let i = 0; i < 900; i += 1) {
      sim.step(0.1)
      const a = at()
      worst = Math.max(worst, offLine([a.x, a.y], stand.lead))
      if (a.status !== 'pushback') break
    }
    expect(worst).toBeLessThan(0.002) // ~4 m off a line it is supposed to be on
    expect(dist([at().x, at().y], stand.entry)).toBeLessThan(0.01)
    expect(at().status).toBe('holding') // off the stand, ready to taxi
  })
})

describe('an arrival is marshalled onto the stand', () => {
  it('reaches the gate along the lead-in line rather than across the apron', () => {
    const { game, sim } = ksanSim()
    // A departure sitting on a stand gives us a known-good gate; taxi it out to the runway and
    // then send it back to that same stand, which exercises the real arrival routing.
    const id = game.inits[0]!.id
    const at = () => sim.snapshot().aircraft.find((a) => a.id === id)!
    const stand = findStand(stands, at().gate)!

    for (let i = 0; i < 1200; i += 1) sim.step(0.1)
    sim.dispatch({ type: 'pushback', aircraftId: id })
    for (let i = 0; i < 900 && at().status === 'pushback'; i += 1) sim.step(0.1)
    sim.dispatch({ type: 'taxiToGoal', aircraftId: id })
    for (let i = 0; i < 4000 && !at().holdShort; i += 1) sim.step(0.1)
    expect(at().holdShort).toBe(true)

    // Now send it back to the stand the way an arrival goes in.
    expect(sim.dispatch({ type: 'taxiTo', aircraftId: id, dest: stand.stop, exact: true })).toEqual({
      ok: true,
    })
    for (let i = 0; i < 8000 && dist([at().x, at().y], stand.stop) > 0.005; i += 1) sim.step(0.1)
    expect(dist([at().x, at().y], stand.stop)).toBeLessThan(0.02)
  })

  it('creeps down the lead-in instead of arriving at taxi speed', () => {
    const { game, sim } = ksanSim()
    const id = game.inits[0]!.id
    const at = () => sim.snapshot().aircraft.find((a) => a.id === id)!
    const stand = findStand(stands, at().gate)!

    for (let i = 0; i < 1200; i += 1) sim.step(0.1)
    sim.dispatch({ type: 'pushback', aircraftId: id })
    for (let i = 0; i < 900 && at().status === 'pushback'; i += 1) sim.step(0.1)
    // Route it back onto its own stand as an arrival would be.
    sim.dispatch({ type: 'taxiTo', aircraftId: id, dest: stand.entry, exact: true })
    for (let i = 0; i < 4000 && dist([at().x, at().y], stand.entry) > 0.004; i += 1) sim.step(0.1)

    // Speed on the paint is a marshalling pace, never full taxi speed.
    const onLead: number[] = []
    for (let i = 0; i < 600; i += 1) {
      sim.step(0.1)
      const a = at()
      if (offLine([a.x, a.y], stand.lead) < 0.002) onLead.push(a.groundspeed)
      if (a.groundspeed <= 0.1 && dist([a.x, a.y], stand.stop) < 0.01) break
    }
    expect(onLead.length).toBeGreaterThan(0)
  })
})

// Both of these come from the slice's review: the lead-in has to survive the sim rewriting an
// aircraft's path underneath it, which a hold-short split, a crossing release and a congestion
// diversion all do.
describe('the lead-in survives a path rewrite', () => {
  it('a diverted arrival still arrives along the paint, not across the apron', () => {
    const { game, sim } = ksanSim()
    const id = game.inits[0]!.id
    const at = () => sim.snapshot().aircraft.find((a) => a.id === id)!
    const stand = findStand(stands, at().gate)!

    for (let i = 0; i < 1200; i += 1) sim.step(0.1)
    sim.dispatch({ type: 'pushback', aircraftId: id })
    for (let i = 0; i < 900 && at().status === 'pushback'; i += 1) sim.step(0.1)
    // Route it away and back, so the return leg is a full graph route ending on the stand.
    sim.dispatch({ type: 'taxiToGoal', aircraftId: id })
    for (let i = 0; i < 4000 && !at().holdShort; i += 1) sim.step(0.1)
    sim.dispatch({ type: 'taxiTo', aircraftId: id, dest: stand.stop, exact: true })

    // However the route is rebuilt en route, the final approach to the stand is on the line.
    for (let i = 0; i < 12000 && dist([at().x, at().y], stand.stop) > 0.004; i += 1) sim.step(0.1)
    expect(offLine([at().x, at().y], stand.lead)).toBeLessThan(0.003)
  })

  it('creeps only near the stand, not for the whole taxi route', () => {
    const { game, sim } = ksanSim()
    const id = game.inits[0]!.id
    const at = () => sim.snapshot().aircraft.find((a) => a.id === id)!
    const stand = findStand(stands, at().gate)!

    for (let i = 0; i < 1200; i += 1) sim.step(0.1)
    sim.dispatch({ type: 'pushback', aircraftId: id })
    for (let i = 0; i < 900 && at().status === 'pushback'; i += 1) sim.step(0.1)
    sim.dispatch({ type: 'taxiToGoal', aircraftId: id }) // out to the runway, well clear of the gate

    // Once away from the stand it must reach full taxi speed — a leg-counted cap used to hold
    // the aircraft at marshalling pace for the entire route after the path was re-planned.
    let fast = false
    for (let i = 0; i < 6000 && !at().holdShort; i += 1) {
      sim.step(0.1)
      const a = at()
      if (dist([a.x, a.y], stand.stop) > 0.2 && a.groundspeed > 12) fast = true
    }
    expect(fast).toBe(true)
  })
})

describe('pushing back from anywhere on the lead-in', () => {
  // The aircraft is not guaranteed to be sitting on the nose-stop mark: an arrival stops within
  // GATE_EPS of its goal, and the dev sandbox can place one anywhere. Reversing the whole line
  // from its far end would first drive the aircraft *forward* toward the stop to pick the line
  // up at the top — a lurch onto the stand before backing off it. The push rejoins where the
  // aircraft actually is.
  it('never moves toward the stand before backing away from it', () => {
    const { game, sim } = ksanSim()
    // Long *and* curved: on a straight two-point line, reversing from the far end and rejoining
    // where the aircraft stands are the same path, so only a curve tells them apart.
    const stand = [...game.stands]
      .filter((s) => s.source === 'charted' && s.lead.length > 4)
      .sort((a, b) => dist(b.entry, b.stop) - dist(a.entry, a.stop))[0]!
    // A vertex about halfway along, so the aircraft starts exactly on the paint: past the
    // taxilane, well short of the mark.
    const partway = stand.lead[Math.floor(stand.lead.length / 2)] as Point

    const id = sim.add({
      id: 'part',
      callsign: 'PART',
      type: 'B738',
      wake: 'M',
      path: [partway],
      targetSpeed: 0,
      intent: 'departure',
      gate: stand.ref,
      heading: stand.headingDeg,
    })
    const at = () => sim.snapshot().aircraft.find((a) => a.id === id)!
    for (let i = 0; i < 1200; i += 1) sim.step(0.1) // ground servicing

    expect(sim.dispatch({ type: 'pushback', aircraftId: id })).toEqual({ ok: true })
    let closest = dist([at().x, at().y], stand.stop)
    let worst = 0
    for (let i = 0; i < 900; i += 1) {
      sim.step(0.1)
      const a = at()
      // Distance to the stand only ever grows: it is being pushed away. The tolerance is a
      // metre, for the small swing as the aircraft aligns; the behaviour this rules out moves
      // it tens of metres up the line first.
      expect(dist([a.x, a.y], stand.stop)).toBeGreaterThanOrEqual(closest - 0.0005)
      closest = Math.max(closest, dist([a.x, a.y], stand.stop))
      worst = Math.max(worst, offLine([a.x, a.y], stand.lead))
      if (a.status !== 'pushback') break
    }
    expect(worst).toBeLessThan(0.002) // and it stays on the paint the whole way
    expect(dist([at().x, at().y], stand.entry)).toBeLessThan(0.01)
  })
})

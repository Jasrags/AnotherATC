import { describe, expect, it } from 'vitest'
import { createGroundSim } from './sim'
import type { GroundSimOptions } from './sim'
import { buildTaxiGraph } from './taxiGraph'
import { buildRunwayGuard } from './runwayGuard'
import { buildStands } from './stands'
import { createAirportGame } from '../world/airport'
import { KSAN } from '../world/ksanAirport'
import type { Point } from '../world/types'

const dist = (a: Point, b: Point): number => Math.hypot(a[0] - b[0], a[1] - b[1])
const graph = buildTaxiGraph(KSAN.surface)
const stands = buildStands(KSAN.surface)

function field(extra: Partial<GroundSimOptions> = {}) {
  const game = createAirportGame(KSAN)
  const sim = createGroundSim(game.inits, {
    graph,
    guard: buildRunwayGuard(KSAN.surface),
    runway: game.runway,
    servicing: game.servicing,
    stands: game.stands,
    ...extra,
  })
  return { game, sim }
}

/** An arrival a short taxi from a free stand, pointed at it. */
function inbound(sim: ReturnType<typeof createGroundSim>) {
  const taken = new Set(sim.snapshot().aircraft.map((a) => a.gate))
  const stand = stands.find((s) => s.source === 'charted' && !taken.has(s.ref))!
  const entryKey = graph.nearestNode(stand.entry)!
  const from = graph.nodePoint(graph.neighbours(entryKey)[0]!)!
  sim.add({
    id: 'arr',
    callsign: 'ARR100',
    type: 'A320',
    wake: 'M',
    path: [from, graph.nodePoint(entryKey)!],
    targetSpeed: 15,
    intent: 'arrival',
    gate: stand.ref,
    goalPoint: stand.stop,
  })
  sim.dispatch({ type: 'taxiToGoal', aircraftId: 'arr' })
  return { stand, at: () => sim.snapshot().aircraft.find((a) => a.id === 'arr') }
}

/** Step until the arrival has finished its gate dwell, or we give up. */
function parkIt(sim: ReturnType<typeof createGroundSim>, stand: { stop: Point }): void {
  for (let i = 0; i < 12000; i += 1) {
    sim.step(0.1)
    const a = sim.snapshot().aircraft.find((x) => x.id === 'arr')
    if (!a) return // despawned
    if (a.intent === 'departure') return // turned round
    if (dist([a.x, a.y], stand.stop) < 0.01 && a.groundspeed === 0 && sim.snapshot().arrived > 0) return
  }
}

describe('turnaround', () => {
  it('is off by default — an arrival still clears the field when it parks', () => {
    const { sim } = field()
    const { stand } = inbound(sim)
    parkIt(sim, stand)
    for (let i = 0; i < 200; i += 1) sim.step(0.1)
    expect(sim.snapshot().aircraft.find((a) => a.id === 'arr')).toBeUndefined()
    expect(sim.snapshot().arrived).toBe(1)
  })

  it('turns the arrival into a departure on the same stand', () => {
    const { sim } = field({ turnaround: true })
    const { stand, at } = inbound(sim)
    parkIt(sim, stand)

    const a = at()!
    expect(a).toBeDefined()
    expect(sim.snapshot().arrived).toBe(1) // the arrival still counts as complete
    expect(a.intent).toBe('departure')
    expect(a.status).toBe('parked')
    expect(a.gate).toBe(stand.ref)
    expect(a.controlledBy).toBe('ground')
    // Same airframe, still on the mark it was marshalled onto.
    expect(a.type).toBe('A320')
    expect(dist([a.x, a.y], stand.stop)).toBeLessThan(0.02)
  })

  it('is a new flight: it needs its own clearance and its own beacon code', () => {
    const { sim } = field({ turnaround: true })
    const { stand, at } = inbound(sim)
    sim.dispatch({ type: 'clearance', aircraftId: 'arr' }) // refused — arrivals aren't cleared
    parkIt(sim, stand)

    expect(at()!.squawk).toBeNull()
    expect(at()!.hasInstruction).toBe(false) // nothing to "say again" — the arrival's calls are done
    expect(sim.dispatch({ type: 'clearance', aircraftId: 'arr' })).toEqual({ ok: true })
    expect(at()!.squawk).toMatch(/^[0-7]{4}$/)
  })

  it('runs a fresh ground-service cycle before it can push back', () => {
    const { sim } = field({ turnaround: true })
    const { stand, at } = inbound(sim)
    parkIt(sim, stand)

    // Servicing starts over for the new flight, and gates the pushback exactly as it does for
    // a departure that was seeded on the stand.
    expect(at()!.serviceSec).toBeGreaterThan(0)
    const early = sim.dispatch({ type: 'pushback', aircraftId: 'arr' })
    expect(early.ok).toBe(false)
    if (!early.ok) expect(early.reason).toContain('servicing')

    for (let i = 0; i < 1200; i += 1) sim.step(0.1)
    expect(at()!.serviceSec).toBe(0)
    expect(sim.dispatch({ type: 'pushback', aircraftId: 'arr' })).toEqual({ ok: true })
  })

  it('holds the gate against another arrival for the whole turnaround', () => {
    // The point of the mechanic: a stand is finite. Before this, a gate freed itself the moment
    // it was reached, so nothing was ever really waiting for one.
    const { sim } = field({ turnaround: true })
    const { stand } = inbound(sim)
    parkIt(sim, stand)
    expect(sim.standOccupied(stand.ref)).toBe(true)

    const ap = sim.approach()!
    sim.add({
      id: 'next',
      callsign: 'NEXT',
      type: 'B738',
      wake: 'M',
      path: [ap.fix, ap.threshold],
      targetSpeed: 140,
      airborne: true,
      intent: 'arrival',
      gate: stand.ref,
      goalPoint: stand.stop,
    })
    expect(sim.snapshot().aircraft.find((a) => a.id === 'next')!.gateBlocked).toBe(true)
  })

  // The whole point is that the airframe keeps flying, so the cycle has to actually close.
  it('flies the turned-round aircraft back out as a departure', () => {
    const { sim } = field({ turnaround: true })
    const { stand, at } = inbound(sim)
    parkIt(sim, stand)
    expect(at()!.intent).toBe('departure')

    sim.dispatch({ type: 'clearance', aircraftId: 'arr' })
    for (let i = 0; i < 1200; i += 1) sim.step(0.1) // servicing
    expect(sim.dispatch({ type: 'pushback', aircraftId: 'arr' })).toEqual({ ok: true })
    for (let i = 0; i < 1200 && at()?.status === 'pushback'; i += 1) sim.step(0.1)
    expect(sim.dispatch({ type: 'taxiToGoal', aircraftId: 'arr' })).toEqual({ ok: true })
    for (let i = 0; i < 20000 && !at()?.holdShort; i += 1) sim.step(0.1)
    expect(at()!.holdShort).toBe(true)

    sim.dispatch({ type: 'contactTower', aircraftId: 'arr' })
    expect(sim.dispatch({ type: 'clearedForTakeoff', aircraftId: 'arr' })).toEqual({ ok: true })
    for (let i = 0; i < 4000 && sim.snapshot().departed < 1; i += 1) sim.step(0.1)

    // One airframe, one arrival and one departure — and the gate it used is free again.
    expect(sim.snapshot().arrived).toBe(1)
    expect(sim.snapshot().departed).toBe(1)
    expect(sim.standOccupied(stand.ref)).toBe(false)
  })
})

// The single-aircraft tests above cannot see this: instructions issued to the *arrival* have to
// die with it, and a give-way is the one that outlives the gate dwell whenever the traffic it
// names is still standing nearby — which, on a ramp, it usually is.
describe('turnaround discards the arrival’s own instructions', () => {
  it('does not carry a give-way hold into the new flight', () => {
    const { sim } = field({ turnaround: true })
    const { stand, at } = inbound(sim)

    // Let it reach the stand first: a give-way issued while it is still taxiing simply stops
    // it short, and it never arrives at all. The case that matters is one issued on the ramp
    // while it sits at the gate — the instruction is then still in force when the dwell ends.
    for (let i = 0; i < 12000; i += 1) {
      sim.step(0.1)
      const a = at()!
      if (dist([a.x, a.y], stand.stop) < 0.01 && a.groundspeed === 0) break
    }

    // Traffic parked on a neighbouring stand, close enough that the give-way never expires.
    const neighbour = sim
      .snapshot()
      .aircraft.filter((a) => a.id !== 'arr')
      .map((a) => ({ a, d: dist([a.x, a.y], stand.stop) }))
      .sort((x, y) => x.d - y.d)[0]!
    expect(neighbour.d).toBeLessThan(0.35) // inside GIVEWAY_FORGET_NM, so it stays in force

    expect(sim.dispatch({ type: 'giveWay', aircraftId: 'arr', toId: neighbour.a.id })).toEqual({
      ok: true,
    })
    expect(at()!.giveWayTo).not.toBeNull()

    parkIt(sim, stand)
    expect(at()!.intent).toBe('departure')
    // The new flight is not still giving way to traffic the previous one was told about.
    expect(at()!.giveWayTo).toBeNull()

    // …and it can actually leave: a stale hold caps its speed at zero forever, with a strip
    // that looks like an ordinary uncleared departure.
    sim.dispatch({ type: 'clearance', aircraftId: 'arr' })
    for (let i = 0; i < 1200; i += 1) sim.step(0.1)
    expect(sim.dispatch({ type: 'pushback', aircraftId: 'arr' })).toEqual({ ok: true })
    for (let i = 0; i < 1500 && at()?.status === 'pushback'; i += 1) sim.step(0.1)
    sim.dispatch({ type: 'taxiToGoal', aircraftId: 'arr' })
    let moved = false
    const from: Point = [at()!.x, at()!.y]
    for (let i = 0; i < 4000 && !moved; i += 1) {
      sim.step(0.1)
      if (dist([at()!.x, at()!.y], from) > 0.05) moved = true
    }
    expect(moved).toBe(true)
  })
})

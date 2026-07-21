import { describe, expect, it } from 'vitest'
import { createGroundSim } from './sim'
import { buildTaxiGraph } from './taxiGraph'
import { buildRunwayGuard } from './runwayGuard'
import { createAirportGame } from '../world/airport'
import { KSAN } from '../world/ksanAirport'

/** Smallest angle between two headings. */
const off = (a: number, b: number): number => Math.abs((((a - b + 540) % 360) - 180))

function ksan() {
  const game = createAirportGame(KSAN)
  const sim = createGroundSim(game.inits, {
    graph: buildTaxiGraph(KSAN.surface),
    guard: buildRunwayGuard(KSAN.surface),
    runway: game.runway,
    servicing: game.servicing,
    stands: game.stands,
  })
  const id = game.inits[0]!.id
  return { game, sim, id, at: () => sim.snapshot().aircraft.find((a) => a.id === id)! }
}

describe('pushback direction', () => {
  it('offers both ways out of the alley', () => {
    const { sim, id } = ksan()
    const opts = sim.pushbackOptions(id)
    // Every KSAN stand's alley runs two ways, so this is always a real choice.
    expect(opts).toHaveLength(2)
    expect(new Set(opts.map((o) => o.facing)).size).toBe(2)
    // The two are close to opposite: they are the two ends of the same taxiway.
    expect(off(opts[0]!.headingDeg, opts[1]!.headingDeg)).toBeGreaterThan(120)
  })

  it('leaves the aircraft facing the direction it was pushed into', () => {
    const { sim, id, at } = ksan()
    const opts = sim.pushbackOptions(id)
    for (let i = 0; i < 1200; i += 1) sim.step(0.1) // servicing

    expect(sim.dispatch({ type: 'pushback', aircraftId: id, facing: opts[1]!.facing })).toEqual({
      ok: true,
    })
    for (let i = 0; i < 1200 && at().status === 'pushback'; i += 1) sim.step(0.1)
    expect(at().status).not.toBe('pushback')
    expect(off(at().heading, opts[1]!.headingDeg)).toBeLessThan(5)
  })

  it('refuses a direction the alley does not go, and says which it does', () => {
    const { sim, id } = ksan()
    for (let i = 0; i < 1200; i += 1) sim.step(0.1)
    const bad = sim.dispatch({ type: 'pushback', aircraftId: id, facing: 'NNW' })
    expect(bad.ok).toBe(false)
    if (!bad.ok) {
      expect(bad.reason).toContain('unable')
      for (const o of sim.pushbackOptions(id)) expect(bad.reason).toContain(o.facing)
    }
  })

  // The point of the whole feature: the direction is binding, so pushing the wrong way makes
  // the aircraft go the long way round rather than pirouetting on the alley.
  it('binds the taxi that follows — the wrong way round costs a longer route', () => {
    const lengths: number[] = []
    for (const which of [0, 1]) {
      const { sim, id, at } = ksan()
      const opts = sim.pushbackOptions(id)
      for (let i = 0; i < 1200; i += 1) sim.step(0.1)
      sim.dispatch({ type: 'pushback', aircraftId: id, facing: opts[which]!.facing })
      for (let i = 0; i < 1200 && at().status === 'pushback'; i += 1) sim.step(0.1)

      expect(sim.dispatch({ type: 'taxiToGoal', aircraftId: id })).toEqual({ ok: true })
      const route = sim.routeOf(id)
      let len = 0
      for (let i = 1; i < route.length; i += 1) {
        len += Math.hypot(route[i]![0] - route[i - 1]![0], route[i]![1] - route[i - 1]![1])
      }
      lengths.push(len)

      // Whichever way it was pushed, it sets off that way — never a turn on the spot.
      const first = route[1]
      if (first) {
        const bearing =
          ((Math.atan2(first[0] - at().x, first[1] - at().y) * 180) / Math.PI + 360) % 360
        expect(off(bearing, opts[which]!.headingDeg)).toBeLessThan(120)
      }
    }
    // The two directions do not cost the same — that is what makes the choice matter.
    expect(Math.abs(lengths[0]! - lengths[1]!)).toBeGreaterThan(0.01)
  })

  it('picks a direction that serves the aircraft when none is named', () => {
    const { sim, id, at } = ksan()
    const opts = sim.pushbackOptions(id)
    for (let i = 0; i < 1200; i += 1) sim.step(0.1)
    expect(sim.dispatch({ type: 'pushback', aircraftId: id })).toEqual({ ok: true })
    for (let i = 0; i < 1200 && at().status === 'pushback'; i += 1) sim.step(0.1)

    // It settled on one of the real options, and can still get to its goal from there.
    expect(opts.some((o) => off(at().heading, o.headingDeg) < 5)).toBe(true)
    expect(sim.dispatch({ type: 'taxiToGoal', aircraftId: id })).toEqual({ ok: true })
  })
})

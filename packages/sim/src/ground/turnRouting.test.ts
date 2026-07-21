import { describe, expect, it } from 'vitest'
import { buildTaxiGraph, MAX_TURN_DEG } from './taxiGraph'
import { buildStands } from './stands'
import { KSAN } from '../world/ksanAirport'
import type { AirportSurface, Point } from '../world/types'

const bearing = (a: Point, b: Point): number =>
  ((Math.atan2(b[0] - a[0], b[1] - a[1]) * 180) / Math.PI + 360) % 360
/** Deviation from straight ahead: 0 = carry on, 180 = double back. */
const deviation = (inb: number, out: number): number => Math.abs((((out - inb + 540) % 360) - 180))

/** The sharpest turn anywhere along a routed path. */
function sharpestTurn(path: readonly Point[]): number {
  let worst = 0
  for (let i = 2; i < path.length; i += 1) {
    worst = Math.max(worst, deviation(bearing(path[i - 2]!, path[i - 1]!), bearing(path[i - 1]!, path[i]!)))
  }
  return worst
}

describe('routing respects what an aircraft can physically turn', () => {
  const graph = buildTaxiGraph(KSAN.surface)
  const stands = buildStands(KSAN.surface)
  const runway = KSAN.runways[0]!

  it('never plans a turn sharper than an aircraft can make, on any gate → runway route', () => {
    const goal = graph.nearestNode(runway.departureStart)!
    let routed = 0
    for (const s of stands) {
      const from = graph.nearestNode(s.entry)
      if (!from) continue
      const path = graph.route(from, goal)
      if (path.length < 3) continue
      routed += 1
      expect(sharpestTurn(path)).toBeLessThanOrEqual(MAX_TURN_DEG)
    }
    // Every stand still reaches the runway: the constraint removed impossible turns without
    // stranding anything. Before it, eight of these routes doubled back through 155°.
    expect(routed).toBe(stands.length)
  })

  it('honours a heading the aircraft is already committed to', () => {
    // A short dead-straight taxiway: from the middle, facing east, a route to the west end
    // cannot begin by reversing — it is simply unreachable without a turn nobody can make.
    const surface: AirportSurface = {
      icao: 'T', name: 'T', ref: { lat: 0, lon: 0, elevationFt: 0 }, units: 'nm', source: 'x',
      bounds: { minX: -1, minY: -1, maxX: 1, maxY: 1 },
      features: [{ kind: 'taxiway', ref: 'A', points: [[-1, 0], [0, 0], [1, 0]] }],
    }
    const g = buildTaxiGraph(surface)
    const mid = g.keyAt([0, 0])!
    const west = g.keyAt([-1, 0])!
    const east = g.keyAt([1, 0])!

    expect(g.route(mid, west)).toHaveLength(2) // unconstrained: it may set off either way
    expect(g.route(mid, west, 90)).toEqual([]) // facing east, the west end is behind it
    expect(g.route(mid, east, 90)).toHaveLength(2) // …and the east end is straight ahead
  })

  it('prefers the gentler of two equal-length ways round', () => {
    // Two routes of identical length from A to C: one straight through B, one via a dogleg.
    const surface: AirportSurface = {
      icao: 'T', name: 'T', ref: { lat: 0, lon: 0, elevationFt: 0 }, units: 'nm', source: 'x',
      bounds: { minX: -1, minY: -1, maxX: 2, maxY: 2 },
      features: [
        { kind: 'taxiway', ref: 'A', points: [[0, 0], [1, 0], [2, 0]] },
        { kind: 'taxiway', ref: 'B', points: [[0, 0], [1, 1], [2, 0]] },
      ],
    }
    const g = buildTaxiGraph(surface)
    const path = g.route(g.keyAt([0, 0])!, g.keyAt([2, 0])!)
    expect(sharpestTurn(path)).toBeLessThan(90) // took the straight one, not the dogleg
  })
})

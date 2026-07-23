import { describe, it, expect } from 'vitest'
import { buildTaxiGraph, edgeKey } from './taxiGraph'
import { KSAN_SURFACE } from '../world/ksan'
import type { AirportSurface } from '../world/types'

// A tiny synthetic airport: an L-shaped pair of connected taxiways.
const toy: AirportSurface = {
  icao: 'TEST',
  name: 'Test',
  ref: { lat: 0, lon: 0, elevationFt: 0 },
  units: 'nm',
  source: 'synthetic',
  bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
  features: [
    { kind: 'taxiway', points: [[0, 0], [1, 0]] }, // A: west→east
    { kind: 'taxiway', points: [[1, 0], [1, 1]] }, // B: shares node (1,0), turns north
  ],
}

describe('buildTaxiGraph', () => {
  it('merges shared vertices into one node', () => {
    const g = buildTaxiGraph(toy)
    expect(g.size).toBe(3) // (0,0), (1,0), (1,1)
  })

  it('routes across connected taxiways through the shared node', () => {
    const g = buildTaxiGraph(toy)
    const from = g.nearestNode([0, 0])!
    const to = g.nearestNode([1, 1])!
    const path = g.route(from, to)
    expect(path).toEqual([
      [0, 0],
      [1, 0],
      [1, 1],
    ])
  })

  it('returns [] when the goal is unreachable', () => {
    const disjoint: AirportSurface = {
      ...toy,
      features: [
        { kind: 'taxiway', points: [[0, 0], [1, 0]] },
        { kind: 'taxiway', points: [[5, 5], [6, 5]] }, // separate component
      ],
    }
    const g = buildTaxiGraph(disjoint)
    expect(g.route(g.nearestNode([0, 0])!, g.nearestNode([6, 5])!)).toEqual([])
  })

  it('reports the taxiway designator of an edge', () => {
    const named: AirportSurface = {
      ...toy,
      features: [
        { kind: 'taxiway', points: [[0, 0], [1, 0]], ref: 'A' },
        { kind: 'taxiway', points: [[1, 0], [1, 1]], ref: 'B' },
      ],
    }
    const g = buildTaxiGraph(named)
    expect(g.refBetween(g.nearestNode([0, 0])!, g.nearestNode([1, 0])!)).toBe('A')
    expect(g.refBetween(g.nearestNode([1, 0])!, g.nearestNode([1, 1])!)).toBe('B')
  })

  describe('routeVia', () => {
    // Two ways S→G: taxiway A over the top, taxiway B underneath (same length).
    const diamond: AirportSurface = {
      ...toy,
      features: [
        { kind: 'taxiway', points: [[0, 0], [0.2, 0.1], [0.4, 0]], ref: 'A' },
        { kind: 'taxiway', points: [[0, 0], [0.2, -0.1], [0.4, 0]], ref: 'B' },
      ],
    }

    it('routes via the requested taxiway even when equal-cost alternatives exist', () => {
      const g = buildTaxiGraph(diamond)
      const s = g.nearestNode([0, 0])!
      const gg = g.nearestNode([0.4, 0])!
      expect(g.routeVia(s, gg, ['A'])).toContainEqual([0.2, 0.1]) // took the top (A)
      expect(g.routeVia(s, gg, ['B'])).toContainEqual([0.2, -0.1]) // took the bottom (B)
    })

    it('follows a taxiway sequence in order and returns [] for an unknown taxiway', () => {
      // S ─A─ M ─B─ G : "via A, B" is the direct route.
      const chain: AirportSurface = {
        ...toy,
        features: [
          { kind: 'taxiway', points: [[0, 0], [0.2, 0]], ref: 'A' },
          { kind: 'taxiway', points: [[0.2, 0], [0.4, 0]], ref: 'B' },
        ],
      }
      const g = buildTaxiGraph(chain)
      const s = g.nearestNode([0, 0])!
      const gg = g.nearestNode([0.4, 0])!
      expect(g.routeVia(s, gg, ['A', 'B'])).toEqual([
        [0, 0],
        [0.2, 0],
        [0.4, 0],
      ])
      expect(g.routeVia(s, gg, ['Z'])).toEqual([]) // no such taxiway → no route
    })
  })

  describe('routeAvoiding', () => {
    // A diamond: two equal-length ways S→G, taxiway A over the top, B underneath.
    const diamond: AirportSurface = {
      ...toy,
      features: [
        { kind: 'taxiway', points: [[0, 0], [0.2, 0.1], [0.4, 0]], ref: 'A' },
        { kind: 'taxiway', points: [[0, 0], [0.2, -0.1], [0.4, 0]], ref: 'B' },
      ],
    }

    it('reroutes around a blocked edge onto the parallel branch', () => {
      const g = buildTaxiGraph(diamond)
      const s = g.nearestNode([0, 0])!
      const gg = g.nearestNode([0.4, 0])!
      // Block the first edge of the top branch (S → apex-A); the route must take B.
      const apexA = g.nearestNode([0.2, 0.1])!
      const path = g.routeAvoiding(s, gg, new Set([edgeKey(s, apexA)]))
      expect(path).toContainEqual([0.2, -0.1]) // detoured onto B
      expect(path).not.toContainEqual([0.2, 0.1])
    })

    it('is the same as route() when nothing is blocked', () => {
      const g = buildTaxiGraph(diamond)
      const s = g.nearestNode([0, 0])!
      const gg = g.nearestNode([0.4, 0])!
      expect(g.routeAvoiding(s, gg, new Set())).toEqual(g.route(s, gg))
    })

    it('returns [] when blocking severs the only route', () => {
      // S ─A─ M ─B─ G : blocking A leaves G unreachable.
      const chain: AirportSurface = {
        ...toy,
        features: [
          { kind: 'taxiway', points: [[0, 0], [0.2, 0]], ref: 'A' },
          { kind: 'taxiway', points: [[0.2, 0], [0.4, 0]], ref: 'B' },
        ],
      }
      const g = buildTaxiGraph(chain)
      const s = g.nearestNode([0, 0])!
      const m = g.nearestNode([0.2, 0])!
      const gg = g.nearestNode([0.4, 0])!
      expect(g.routeAvoiding(s, gg, new Set([edgeKey(s, m)]))).toEqual([])
    })

    it('edgeKey is order-independent', () => {
      expect(edgeKey('a', 'b')).toBe(edgeKey('b', 'a'))
      expect(edgeKey('a', 'b')).not.toBe(edgeKey('a', 'c'))
    })
  })

  it('builds a large connected graph for KSAN', () => {
    const g = buildTaxiGraph(KSAN_SURFACE)
    expect(g.size).toBeGreaterThan(100)
    // Two arbitrary far-apart nodes should be routable across the field.
    const west = g.nearestNode([KSAN_SURFACE.bounds.minX, 0])!
    const east = g.nearestNode([KSAN_SURFACE.bounds.maxX, 0])!
    expect(g.route(west, east).length).toBeGreaterThan(2)
  })
})

describe('near-coincident nodes are merged so junctions route as one', () => {
  const dist = (a: readonly number[], b: readonly number[]): number => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!)

  it('leaves no disconnected pair of near-coincident nodes on KSAN', () => {
    // OSM taxiway features occasionally meet at a junction with endpoints a few dozen feet apart
    // rather than sharing a vertex. Left unmerged, the two nodes are disconnected and routing to
    // the wrong twin loops around the field to reach a stub it cannot turn onto (the DEV04 report).
    const g = buildTaxiGraph(KSAN_SURFACE)
    const { nodes, edges } = g.topology()
    const connected = new Set<string>()
    for (const e of edges) connected.add(edgeKey(e.a, e.b))
    const MERGE_EPS_NM = 0.005
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        if (dist(nodes[i]!.point, nodes[j]!.point) > MERGE_EPS_NM) continue
        expect(
          connected.has(edgeKey(nodes[i]!.key, nodes[j]!.key)),
          `nodes ${nodes[i]!.point} and ${nodes[j]!.point} are near-coincident but disconnected`,
        ).toBe(true)
      }
    }
  })

  it('routes directly between two nearby points on the north taxiway, not the long way round', () => {
    // C3 area to a point ~0.15 nm east on the same taxiway. Snapping to a disconnected stub used
    // to route ~0.70 nm (4.7x) around the field; the merged junction routes it near-straight.
    const g = buildTaxiGraph(KSAN_SURFACE)
    const from = g.nearestNode([0.27, -0.05])!
    const to = g.nearestNode([0.42, -0.05])!
    const route = g.route(from, to)
    let len = 0
    for (let i = 1; i < route.length; i += 1) len += dist(route[i - 1]!, route[i]!)
    expect(len).toBeLessThan(0.3) // straight-line is ~0.15; the loop was ~0.70
  })
})

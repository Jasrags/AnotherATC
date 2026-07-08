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

import { describe, it, expect } from 'vitest'
import { buildTaxiGraph } from './taxiGraph'
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

  it('builds a large connected graph for KSAN', () => {
    const g = buildTaxiGraph(KSAN_SURFACE)
    expect(g.size).toBeGreaterThan(100)
    // Two arbitrary far-apart nodes should be routable across the field.
    const west = g.nearestNode([KSAN_SURFACE.bounds.minX, 0])!
    const east = g.nearestNode([KSAN_SURFACE.bounds.maxX, 0])!
    expect(g.route(west, east).length).toBeGreaterThan(2)
  })
})

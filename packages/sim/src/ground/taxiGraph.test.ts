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

  it('builds a large connected graph for KSAN', () => {
    const g = buildTaxiGraph(KSAN_SURFACE)
    expect(g.size).toBeGreaterThan(100)
    // Two arbitrary far-apart nodes should be routable across the field.
    const west = g.nearestNode([KSAN_SURFACE.bounds.minX, 0])!
    const east = g.nearestNode([KSAN_SURFACE.bounds.maxX, 0])!
    expect(g.route(west, east).length).toBeGreaterThan(2)
  })
})

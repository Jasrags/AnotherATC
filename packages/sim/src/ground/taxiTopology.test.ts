import { describe, it, expect } from 'vitest'
import { buildTaxiGraph } from './taxiGraph'
import type { AirportSurface } from '../world/types'

const base = {
  icao: 'TEST',
  name: 'Test',
  ref: { lat: 0, lon: 0, elevationFt: 0 },
  units: 'nm' as const,
  source: 'synthetic' as const,
  bounds: { minX: -1, minY: -1, maxX: 1, maxY: 1 },
}

describe('taxi graph contraction (topology)', () => {
  it('collapses a run of pass-through vertices into one geometry-preserving edge', () => {
    // One straight taxiway sampled at 4 vertices.
    const surface: AirportSurface = {
      ...base,
      features: [{ kind: 'taxiway', points: [[0, 0], [0.1, 0], [0.2, 0], [0.3, 0]], ref: 'A' }],
    }
    const topo = buildTaxiGraph(surface).topology()
    expect(topo.nodes.length).toBe(2) // only the two endpoints survive
    expect(topo.edges.length).toBe(1)
    const e = topo.edges[0]!
    expect(e.geom).toEqual([[0, 0], [0.1, 0], [0.2, 0], [0.3, 0]]) // full shape retained
    expect(e.length).toBeCloseTo(0.3, 6) // true polyline length, not chord
    expect(e.ref).toBe('A')
  })

  it('keeps junctions as nodes and splits runs at them', () => {
    // Chain A (0→0.3 along x) with a stub B rising from the shared vertex (0.2,0).
    const surface: AirportSurface = {
      ...base,
      features: [
        { kind: 'taxiway', points: [[0, 0], [0.1, 0], [0.2, 0], [0.3, 0]], ref: 'A' },
        { kind: 'taxiway', points: [[0.2, 0], [0.2, 0.1]], ref: 'B' },
      ],
    }
    const topo = buildTaxiGraph(surface).topology()
    // Nodes: endpoints (0,0) & (0.3,0), the junction (0.2,0) deg 3, and the stub tip (0.2,0.1).
    expect(topo.nodes.length).toBe(4)
    expect(topo.edges.length).toBe(3)
    const junction = topo.nodes.find((n) => n.point[0] === 0.2 && n.point[1] === 0)!
    expect(junction.degree).toBe(3)
  })

  it('flags a long, dead-straight edge for chart review but not a curved one', () => {
    const surface: AirportSurface = {
      ...base,
      features: [
        // Long single straight segment (a chord across ~900ft) — suspicious.
        { kind: 'taxiway', points: [[0, 0], [0.15, 0]], ref: 'STR' },
        // Long but well-sampled curve of the same span — legitimate.
        {
          kind: 'taxiway',
          points: [[0, 0.5], [0.05, 0.56], [0.1, 0.585], [0.15, 0.5]],
          ref: 'CRV',
        },
      ],
    }
    const topo = buildTaxiGraph(surface).topology()
    const str = topo.edges.find((e) => e.ref === 'STR')!
    const crv = topo.edges.find((e) => e.ref === 'CRV')!
    expect(str.straight).toBe(true)
    expect(crv.straight).toBe(false)
  })
})

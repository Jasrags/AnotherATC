import { describe, it, expect } from 'vitest'
import { auditTaxiGraph, CATEGORY_OF, TAXI_CATEGORIES } from './taxiAudit'
import type { TaxiTopology, TopoEdge, TopoNode } from './taxiGraph'
import type { Point } from '../world/types'

const FT = 1 / 6076.12 // one foot, in nm

const node = (key: string, point: Point, degree: number): TopoNode => ({ key, point, degree })
const edge = (a: string, b: string, geom: Point[], ref?: string): TopoEdge => {
  let length = 0
  for (let i = 1; i < geom.length; i += 1) length += Math.hypot(geom[i]![0] - geom[i - 1]![0], geom[i]![1] - geom[i - 1]![1])
  const chord = Math.hypot(geom[geom.length - 1]![0] - geom[0]![0], geom[geom.length - 1]![1] - geom[0]![1])
  return { a, b, geom, length, straight: length > 0.1 && chord / length > 0.985, ...(ref ? { ref } : {}) }
}

describe('taxi-graph geometry audit (taxiAudit)', () => {
  it('a clean cross intersection produces no findings', () => {
    // Node C at origin, four arms leaving N/S/E/W — every pair is 90° or 180°, all fine.
    const c: Point = [0, 0]
    const topology: TaxiTopology = {
      nodes: [node('c', c, 4), node('e', [1, 0], 1), node('w', [-1, 0], 1), node('n', [0, 1], 1), node('s', [0, -1], 1)],
      edges: [
        edge('c', 'e', [c, [1, 0]]),
        edge('c', 'w', [c, [-1, 0]]),
        edge('c', 'n', [c, [0, 1]]),
        edge('c', 's', [c, [0, -1]]),
      ],
    }
    expect(auditTaxiGraph(topology).findings).toHaveLength(0)
  })

  it('flags a cusp — two edges spearing out of a node in nearly the same direction', () => {
    const c: Point = [0, 0]
    const topology: TaxiTopology = {
      nodes: [node('c', c, 2), node('a', [1, 0], 1), node('b', [1, 0.05], 1)], // ~2.9° apart
      edges: [edge('c', 'a', [c, [1, 0]], 'B'), edge('c', 'b', [c, [1, 0.05]], 'B')],
    }
    const r = auditTaxiGraph(topology)
    const cusp = r.findings.find((f) => f.kind === 'cusp')!
    expect(cusp).toBeTruthy()
    expect(cusp.severity).toBe('high')
    expect(cusp.metric).toBeLessThan(30)
    expect(cusp.suggestion).toMatch(/relocate|merge/i)
  })

  it('flags a tight turn between 30° and 60°', () => {
    const c: Point = [0, 0]
    const topology: TaxiTopology = {
      nodes: [node('c', c, 2), node('a', [1, 0], 1), node('b', [1, 1], 1)], // 45°
      edges: [edge('c', 'a', [c, [1, 0]]), edge('c', 'b', [c, [1, 1]])],
    }
    const r = auditTaxiGraph(topology)
    const turn = r.findings.find((f) => f.kind === 'tight-turn')!
    expect(turn).toBeTruthy()
    expect(turn.severity).toBe('medium')
    expect(turn.metric).toBeCloseTo(45, 0)
  })

  it('flags near-duplicate nodes and suggests merging them', () => {
    const topology: TaxiTopology = {
      nodes: [node('a', [0, 0], 3), node('b', [10 * FT, 0], 3)], // 10 ft apart
      edges: [],
    }
    const r = auditTaxiGraph(topology)
    const dup = r.findings.find((f) => f.kind === 'near-duplicate-nodes')!
    expect(dup).toBeTruthy()
    expect(dup.severity).toBe('high')
    expect(dup.metric).toBeCloseTo(10, 0)
  })

  it('flags a stub edge', () => {
    const topology: TaxiTopology = {
      nodes: [node('a', [0, 0], 3), node('b', [20 * FT, 0], 3)],
      edges: [edge('a', 'b', [[0, 0], [20 * FT, 0]], 'A')],
    }
    const r = auditTaxiGraph(topology)
    const stub = r.findings.find((f) => f.kind === 'stub-edge')!
    expect(stub).toBeTruthy()
    expect(stub.metric).toBeCloseTo(20, 0)
    expect(stub.ref).toBe('A')
  })

  it('flags a mid-edge kink', () => {
    // A single long run with a sharp interior corner at [1,0].
    const topology: TaxiTopology = {
      nodes: [node('a', [0, 0], 1), node('b', [1.5, 1], 1)],
      edges: [edge('a', 'b', [[0, 0], [1, 0], [1.5, 1]])], // ~63° bend
    }
    const r = auditTaxiGraph(topology)
    const kink = r.findings.find((f) => f.kind === 'kink')!
    expect(kink).toBeTruthy()
    expect(kink.metric).toBeGreaterThan(40)
    expect(kink.at).toEqual([1, 0])
  })

  it('flags duplicate parallel edges between the same node pair, anchored on a real edge', () => {
    const topology: TaxiTopology = {
      nodes: [node('a', [3, 7], 2), node('b', [4, 7], 2)],
      edges: [edge('a', 'b', [[3, 7], [4, 7]], 'D'), edge('a', 'b', [[3, 7], [3.5, 7.1], [4, 7]], 'D')],
    }
    const dup = auditTaxiGraph(topology).findings.find((f) => f.kind === 'duplicate-edge')!
    expect(dup).toBeTruthy()
    expect(dup.metric).toBe(2)
    expect(dup.at).toEqual([3, 7]) // the real first-edge start, not a [0,0] fallback
    expect(dup.ref).toBe('D')
  })

  it('flags a disconnected island', () => {
    const topology: TaxiTopology = {
      nodes: [node('a', [0, 0], 1), node('b', [1, 0], 1), node('x', [5, 5], 1), node('y', [6, 5], 1)],
      edges: [edge('a', 'b', [[0, 0], [1, 0]]), edge('x', 'y', [[5, 5], [6, 5]])],
    }
    const island = auditTaxiGraph(topology).findings.find((f) => f.kind === 'disconnected')!
    expect(island).toBeTruthy()
    expect(island.severity).toBe('high')
  })

  it('flags a dangling dead-end only when it is far from every endpoint', () => {
    const topology: TaxiTopology = {
      nodes: [node('end', [0, 0], 1), node('mid', [1, 0], 2), node('gate', [2, 0], 1)],
      edges: [edge('end', 'mid', [[0, 0], [1, 0]]), edge('mid', 'gate', [[1, 0], [2, 0]])],
    }
    // 'gate' sits on an endpoint; 'end' is 2 nm away from any → dangling.
    const r = auditTaxiGraph(topology, { endpoints: [[2, 0]] })
    const dangles = r.findings.filter((f) => f.kind === 'dangling-node')
    expect(dangles).toHaveLength(1)
    expect(dangles[0]!.at).toEqual([0, 0])
    // Without endpoints supplied the check is skipped entirely.
    expect(auditTaxiGraph(topology).findings.some((f) => f.kind === 'dangling-node')).toBe(false)
  })

  it('ranks worst-first and is deterministic', () => {
    const c: Point = [0, 0]
    const topology: TaxiTopology = {
      nodes: [node('c', c, 3), node('a', [1, 0], 1), node('b', [1, 0.02], 1), node('d', [1, 1], 1)],
      edges: [edge('c', 'a', [c, [1, 0]]), edge('c', 'b', [c, [1, 0.02]]), edge('c', 'd', [c, [1, 1]])],
    }
    const first = auditTaxiGraph(topology)
    const second = auditTaxiGraph(topology)
    expect(first.findings).toEqual(second.findings) // deterministic
    expect(first.findings[0]!.severity).toBe('high') // the cusp outranks the tight turn
    expect(first.summary.total).toBe(first.findings.length)
  })

  describe('compound intersections (the fillet-ring "diamond")', () => {
    it('groups two crossing nodes jammed close together into one finding', () => {
      // Two degree-3 crossings ~60 ft apart — a compound intersection, not two clean ones.
      const c1: Point = [0, 0]
      const c2: Point = [10 * FT, 0] // 10 ft (well inside the cluster radius)
      const topology: TaxiTopology = {
        nodes: [node('c1', c1, 3), node('c2', c2, 3), node('n', [0, 0.3], 1), node('s', [10 * FT, -0.3], 1), node('e', [0.3, 0], 1)],
        edges: [edge('c1', 'c2', [c1, c2]), edge('c1', 'n', [c1, [0, 0.3]]), edge('c2', 's', [c2, [10 * FT, -0.3]]), edge('c2', 'e', [c2, [0.3, 0]])],
      }
      const comp = auditTaxiGraph(topology).findings.find((f) => f.kind === 'compound-intersection')!
      expect(comp).toBeTruthy()
      expect(comp.category).toBe('intersections')
      expect(comp.metric).toBe(2) // two crossing nodes in the ring
    })

    it('does not flag a lone crossing node (a clean intersection)', () => {
      const c: Point = [0, 0]
      const topology: TaxiTopology = {
        nodes: [node('c', c, 4), node('e', [1, 0], 1), node('w', [-1, 0], 1), node('n', [0, 1], 1), node('s', [0, -1], 1)],
        edges: [edge('c', 'e', [c, [1, 0]]), edge('c', 'w', [c, [-1, 0]]), edge('c', 'n', [c, [0, 1]]), edge('c', 's', [c, [0, -1]])],
      }
      expect(auditTaxiGraph(topology).findings.some((f) => f.kind === 'compound-intersection')).toBe(false)
    })
  })

  it('reports whole-graph shape and a category rollup that accounts for every finding', () => {
    const c: Point = [0, 0]
    const topology: TaxiTopology = {
      nodes: [node('c', c, 3), node('a', [1, 0], 1), node('b', [1, 0.02], 1), node('d', [1, 1], 1)],
      edges: [edge('c', 'a', [c, [1, 0]]), edge('c', 'b', [c, [1, 0.02]]), edge('c', 'd', [c, [1, 1]])],
    }
    const r = auditTaxiGraph(topology)
    expect(r.graph.nodes).toBe(4)
    expect(r.graph.edges).toBe(3)
    expect(r.graph.components).toBe(1)
    // Every finding carries the category its kind maps to, and the rollup sums to the total.
    expect(r.findings.every((f) => f.category === CATEGORY_OF[f.kind])).toBe(true)
    expect(TAXI_CATEGORIES.reduce((sum, c2) => sum + r.byCategory[c2], 0)).toBe(r.summary.total)
  })
})

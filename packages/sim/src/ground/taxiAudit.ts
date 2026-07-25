import type { Point } from '../world/types'
import type { TaxiTopology, TopoEdge, TopoNode } from './taxiGraph'
import { FT_PER_NM } from './runway'

/**
 * A geometry audit of a built taxi graph — the "is this field smooth enough to taxi" check that
 * was being done by eye, intersection by intersection. It reads the contracted {@link TaxiTopology}
 * (decision nodes + geometry-preserving edges) and reports every rough spot at once, ranked, each
 * with a world coordinate to jump to and a suggested smoothing. It never mutates the graph — the
 * suggestions are for a human to apply (relocating a node, merging near-duplicates, rounding a
 * corner is a data decision, not something to automate blind).
 *
 * The thresholds below are geometry-quality constants, not airport data: a 20° cusp is a cusp at
 * every field, so they live in the engine (the airport/engine split — see CLAUDE.md). They are
 * expressed in feet / degrees and converted once, so they read the way a chart does.
 */

/** Two nodes closer than this are effectively the same point — a routing ambiguity and a source of
 *  micro-stubs. Real adjacent hold/junction nodes sit much further apart than this. */
const NEAR_DUP_FT = 15
/** A contracted edge shorter than this is a stub: a fragment no aircraft meaningfully taxis, almost
 *  always a digitization artifact or a pair of nodes that should have been one. */
const STUB_FT = 25
/** Between two edges meeting at a node, the angle of their *leaving* directions. Below CUSP the two
 *  spear out the same way — the spike/star artifact. CUSP..TIGHT is a turn sharper than an aircraft
 *  taxis comfortably. At or above TIGHT (a normal ≥60° corner, up to a 180° straight-through) is fine. */
const CUSP_MAX_DEG = 30
const TIGHT_MIN_DEG = 60
/** A direction change at an interior polyline vertex above this is a kink — a corner inside what
 *  should be one smooth run (the inward-bulging intersection fillets read as kinks here). */
const KINK_DEG = 40
/** A degree-1 node this far from any known endpoint (runway end / stand) is a dangling stub, not a
 *  legitimate dead-end. Only checked when endpoints are supplied. */
const DANGLE_FT = 120
/** A compound intersection is a *compact* knot of crossing nodes: the cluster's own diameter (its
 *  widest node-to-node span) must stay within this. A clean crossing is one node; a fillet ring
 *  digitizes two or more within a few car-lengths. The bound is a diameter, not a link distance, so
 *  the cluster cannot chain down a run of evenly-spaced connectors (which are a taxiway, not one
 *  intersection) — that chaining was the first cut's mistake. */
const CLUSTER_DIAMETER_FT = 120

export type TaxiFindingKind =
  | 'near-duplicate-nodes'
  | 'stub-edge'
  | 'cusp'
  | 'tight-turn'
  | 'kink'
  | 'duplicate-edge'
  | 'disconnected'
  | 'dangling-node'
  | 'compound-intersection'

/** The four things a graph can be wrong about, so a holistic audit reads as a health report rather
 *  than a flat list: is it all reachable, is any pavement drawn twice, are the crossings clean, do
 *  the runs curve smoothly. Every finding kind belongs to exactly one. */
export type TaxiCategory = 'connectivity' | 'redundancy' | 'intersections' | 'smoothness'

export const CATEGORY_OF: Record<TaxiFindingKind, TaxiCategory> = {
  disconnected: 'connectivity',
  'dangling-node': 'connectivity',
  'duplicate-edge': 'redundancy',
  'stub-edge': 'redundancy',
  'near-duplicate-nodes': 'redundancy',
  'compound-intersection': 'intersections',
  cusp: 'intersections',
  'tight-turn': 'intersections',
  kink: 'smoothness',
}

export const TAXI_CATEGORIES: readonly TaxiCategory[] = ['connectivity', 'redundancy', 'intersections', 'smoothness']

export type TaxiSeverity = 'high' | 'medium' | 'low'

export interface TaxiFinding {
  kind: TaxiFindingKind
  category: TaxiCategory
  severity: TaxiSeverity
  /** Where to look — the world point the problem centres on. */
  at: Point
  /** What is wrong, in one line. */
  detail: string
  /** A concrete smoothing to apply (for a human to apply, not auto-applied). */
  suggestion: string
  /** The measured value behind the finding (feet, or degrees) — for ranking and eyeballing. */
  metric: number
  /** The taxiway designator(s) involved, when known. */
  ref?: string
}

export interface TaxiAuditReport {
  findings: TaxiFinding[]
  summary: { high: number; medium: number; low: number; total: number }
  /** Whole-graph shape, so the report opens with what it is auditing, not just what is wrong. */
  graph: { nodes: number; edges: number; components: number }
  /** Finding counts rolled up by category — the holistic health line. */
  byCategory: Record<TaxiCategory, number>
}

/** A finding before its category is stamped on — the check functions build these; the category is
 *  derived once, centrally, from the kind. */
type RawFinding = Omit<TaxiFinding, 'category'>

const SEVERITY_RANK: Record<TaxiSeverity, number> = { high: 0, medium: 1, low: 2 }

const nm = (ft: number): number => ft / FT_PER_NM
const distNm = (a: Point, b: Point): number => Math.hypot(a[0] - b[0], a[1] - b[1])
const feet = (dNm: number): number => dNm * FT_PER_NM

/** Unit vector a→b, or null if the two points coincide. */
function unit(a: Point, b: Point): [number, number] | null {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len = Math.hypot(dx, dy)
  return len > 0 ? [dx / len, dy / len] : null
}

/** Angle between two unit vectors, in degrees ∈ [0, 180]. */
function angleDeg(u: [number, number], v: [number, number]): number {
  const dot = Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1]))
  return (Math.acos(dot) * 180) / Math.PI
}

/** The direction an edge *leaves* a node (the first meaningful segment away from it), or null if
 *  the node is neither endpoint or the edge is degenerate at that end. */
function leavingDir(edge: TopoEdge, nodeKey: string): [number, number] | null {
  const g = edge.geom
  if (g.length < 2) return null
  if (edge.a === nodeKey) {
    for (let i = 1; i < g.length; i += 1) {
      const u = unit(g[0]!, g[i]!)
      if (u) return u
    }
  }
  if (edge.b === nodeKey) {
    for (let i = g.length - 2; i >= 0; i -= 1) {
      const u = unit(g[g.length - 1]!, g[i]!)
      if (u) return u
    }
  }
  return null
}

function refLabel(...edges: (TopoEdge | undefined)[]): string | undefined {
  const refs = [...new Set(edges.map((e) => e?.ref).filter((r): r is string => !!r))]
  return refs.length ? refs.join('↔') : undefined
}

/** Near-duplicate nodes: a routing ambiguity waiting to happen (and the usual seed of a stub). */
function findNearDuplicateNodes(nodes: TopoNode[]): RawFinding[] {
  const out: RawFinding[] = []
  const limit = nm(NEAR_DUP_FT)
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const d = distNm(nodes[i]!.point, nodes[j]!.point)
      if (d > 0 && d < limit) {
        const ft = feet(d)
        out.push({
          kind: 'near-duplicate-nodes',
          severity: 'high',
          at: nodes[i]!.point,
          detail: `two nodes ${ft.toFixed(1)} ft apart`,
          suggestion: 'merge the two nodes to their midpoint',
          metric: ft,
        })
      }
    }
  }
  return out
}

/** Stub edges and duplicate edges between the same node pair. */
function findEdgeDefects(edges: TopoEdge[]): RawFinding[] {
  const out: RawFinding[] = []
  const stubLimit = nm(STUB_FT)
  // Track a representative edge (the first seen) alongside the count for each node pair, so a
  // duplicate-edge finding anchors on that real edge's geometry rather than a re-derived lookup.
  const seenPairs = new Map<string, { count: number; first: TopoEdge }>()
  for (const e of edges) {
    if (e.a === e.b) continue // a loop edge is handled by the kink/cusp checks, not as a stub
    const pairKey = e.a < e.b ? `${e.a}|${e.b}` : `${e.b}|${e.a}`
    const seen = seenPairs.get(pairKey)
    if (seen) seen.count += 1
    else seenPairs.set(pairKey, { count: 1, first: e })
    if (e.length < stubLimit) {
      const ft = feet(e.length)
      out.push({
        kind: 'stub-edge',
        severity: 'medium',
        at: e.geom[0]!,
        detail: `edge only ${ft.toFixed(1)} ft long`,
        suggestion: 'collapse the stub — merge its two endpoints into one node',
        metric: ft,
        ...(e.ref ? { ref: e.ref } : {}),
      })
    }
  }
  for (const { count, first } of seenPairs.values()) {
    if (count > 1) {
      out.push({
        kind: 'duplicate-edge',
        severity: 'medium',
        at: first.geom[0]!,
        detail: `${count} parallel edges between the same node pair`,
        suggestion: 'keep one edge between the pair; drop the redundant paint',
        metric: count,
        ...(first.ref ? { ref: first.ref } : {}),
      })
    }
  }
  return out
}

/** Cusps and tight turns where edges meet a node — the angle between each pair of leaving
 *  directions. A near-zero angle is a spike (the star artifact); a small-but-nonzero angle is a
 *  turn sharper than an aircraft taxis. */
function findNodeAngles(topology: TaxiTopology): RawFinding[] {
  const out: RawFinding[] = []
  const incident = new Map<string, TopoEdge[]>()
  for (const e of topology.edges) {
    if (e.a === e.b) continue
    ;(incident.get(e.a) ?? incident.set(e.a, []).get(e.a)!).push(e)
    ;(incident.get(e.b) ?? incident.set(e.b, []).get(e.b)!).push(e)
  }
  for (const node of topology.nodes) {
    const edges = incident.get(node.key) ?? []
    if (edges.length < 2) continue
    const dirs = edges.map((e) => ({ e, dir: leavingDir(e, node.key) })).filter((d) => d.dir)
    // One finding per node — the sharpest pair. A degree-5 node with a couple of duplicate arms
    // would otherwise emit a fistful of cusps for what a human fixes as a single intersection; the
    // node is the unit of the fix, so it is the unit of the finding.
    let worst: { theta: number; a: TopoEdge; b: TopoEdge } | null = null
    for (let i = 0; i < dirs.length; i += 1) {
      for (let j = i + 1; j < dirs.length; j += 1) {
        const theta = angleDeg(dirs[i]!.dir!, dirs[j]!.dir!)
        if (!worst || theta < worst.theta) worst = { theta, a: dirs[i]!.e, b: dirs[j]!.e }
      }
    }
    if (!worst) continue
    const ref = refLabel(worst.a, worst.b)
    if (worst.theta < CUSP_MAX_DEG) {
      out.push({
        kind: 'cusp',
        severity: 'high',
        at: node.point,
        detail: `two edges leave this node only ${worst.theta.toFixed(0)}° apart (a spike)`,
        suggestion: 'relocate/merge the node so the edges leave along the real pavement, not back on themselves',
        metric: worst.theta,
        ...(ref ? { ref } : {}),
      })
    } else if (worst.theta < TIGHT_MIN_DEG) {
      out.push({
        kind: 'tight-turn',
        severity: 'medium',
        at: node.point,
        detail: `${worst.theta.toFixed(0)}° between edges — a turn sharper than an aircraft taxis`,
        suggestion: `round the corner (aim for ≥${TIGHT_MIN_DEG}° between legs)`,
        metric: worst.theta,
        ...(ref ? { ref } : {}),
      })
    }
  }
  return out
}

/** Kinks inside a single edge's polyline — a sharp direction change at an interior vertex, i.e. a
 *  corner in what should be one smooth run (the inward-bulging intersection fillets show up here). */
function findKinks(edges: TopoEdge[]): RawFinding[] {
  const out: RawFinding[] = []
  for (const e of edges) {
    const g = e.geom
    for (let i = 1; i < g.length - 1; i += 1) {
      const into = unit(g[i - 1]!, g[i]!)
      const outof = unit(g[i]!, g[i + 1]!)
      if (!into || !outof) continue
      const turn = angleDeg(into, outof) // 0 = straight; larger = sharper corner
      if (turn > KINK_DEG) {
        out.push({
          kind: 'kink',
          severity: turn > 2 * KINK_DEG ? 'medium' : 'low',
          at: g[i]!,
          detail: `${turn.toFixed(0)}° bend mid-edge`,
          suggestion: 'resample the run into a smooth curve, or split it at a real junction node',
          metric: turn,
          ...(e.ref ? { ref: e.ref } : {}),
        })
      }
    }
  }
  return out
}

/** Connectivity: any node not reachable from the largest component is a disconnected island. */
function findDisconnected(topology: TaxiTopology): RawFinding[] {
  const adj = new Map<string, string[]>()
  for (const n of topology.nodes) adj.set(n.key, [])
  for (const e of topology.edges) {
    if (e.a === e.b) continue
    adj.get(e.a)?.push(e.b)
    adj.get(e.b)?.push(e.a)
  }
  const comp = new Map<string, number>()
  let c = 0
  for (const n of topology.nodes) {
    if (comp.has(n.key)) continue
    const stack = [n.key]
    comp.set(n.key, c)
    while (stack.length) {
      const k = stack.pop()!
      for (const nb of adj.get(k) ?? []) {
        if (!comp.has(nb)) {
          comp.set(nb, c)
          stack.push(nb)
        }
      }
    }
    c += 1
  }
  if (c <= 1) return []
  const sizes = new Array(c).fill(0)
  for (const v of comp.values()) sizes[v] += 1
  let main = 0
  for (let i = 1; i < c; i += 1) if (sizes[i] > sizes[main]) main = i
  // One finding per island, anchored at its lowest-coordinate node (a stable representative), not
  // one per node — a human reconnects or removes the whole component as a unit.
  const rep = new Map<number, TopoNode>()
  for (const n of topology.nodes) {
    const id = comp.get(n.key)!
    if (id === main) continue
    const cur = rep.get(id)
    if (!cur || n.point[0] < cur.point[0] || (n.point[0] === cur.point[0] && n.point[1] < cur.point[1])) rep.set(id, n)
  }
  return [...rep.entries()].map(([id, n]) => ({
    kind: 'disconnected' as const,
    severity: 'high' as const,
    at: n.point,
    detail: `isolated component of ${sizes[id]} node(s) — unreachable from the main taxiway network`,
    suggestion: 'connect it to the network, or drop the orphaned pavement',
    metric: sizes[id]!,
  }))
}

/** Degree-1 nodes far from any legitimate endpoint (runway end / stand): dangling stubs. Skipped
 *  entirely when no endpoints are supplied — without them every gate and runway end looks dangling. */
function findDangling(topology: TaxiTopology, endpoints: Point[]): RawFinding[] {
  if (endpoints.length === 0) return []
  const limit = nm(DANGLE_FT)
  const out: RawFinding[] = []
  for (const n of topology.nodes) {
    if (n.degree !== 1) continue
    const nearest = Math.min(...endpoints.map((p) => distNm(n.point, p)))
    if (nearest > limit) {
      out.push({
        kind: 'dangling-node',
        severity: 'low',
        at: n.point,
        detail: `dead-end ${feet(nearest).toFixed(0)} ft from the nearest runway end or stand`,
        suggestion: 'connect the stub to the network or remove it — a dead-end here strands anything routed to it',
        metric: feet(nearest),
      })
    }
  }
  return out
}

/**
 * Compound intersections — the multi-node "diamond". A clean crossing is one decision node; a
 * fillet-ring digitization packs two or more crossing nodes (degree ≥ 3) within a few car-lengths,
 * which renders as the concave star and gives routing several near-identical ways through one
 * junction. Single-linkage clusters the crossing nodes within {@link CLUSTER_RADIUS_FT}; a cluster
 * of two or more is one finding, anchored at its lowest-coordinate node and ranked by node count.
 * This is characterisation, not a mechanical fix (simplifying a crossing to a single node is a data
 * decision), so it is `medium`.
 */
function findCompoundIntersections(nodes: TopoNode[]): RawFinding[] {
  const crossings = nodes.filter((n) => n.degree >= 3)
  const limit = nm(CLUSTER_DIAMETER_FT)
  // Complete-linkage: a crossing joins a cluster only if it is within the diameter of *every* member
  // already in it, so the cluster stays compact (bounded diameter) and cannot chain along a taxiway.
  // Greedy over the fixed node order — deterministic. O(n²), and n is a few hundred.
  const assigned = new Set<string>()
  const clusters: TopoNode[][] = []
  for (const seed of crossings) {
    if (assigned.has(seed.key)) continue
    const cluster = [seed]
    assigned.add(seed.key)
    for (const n of crossings) {
      if (assigned.has(n.key)) continue
      if (cluster.every((m) => distNm(m.point, n.point) <= limit)) {
        cluster.push(n)
        assigned.add(n.key)
      }
    }
    clusters.push(cluster)
  }
  const out: RawFinding[] = []
  for (const g of clusters) {
    if (g.length < 2) continue // a lone crossing node is a clean intersection
    const anchor = g.reduce((lo, n) => (n.point[0] < lo.point[0] || (n.point[0] === lo.point[0] && n.point[1] < lo.point[1]) ? n : lo))
    const extent = Math.max(...g.flatMap((a) => g.map((b) => distNm(a.point, b.point))))
    out.push({
      kind: 'compound-intersection',
      severity: 'medium',
      at: anchor.point,
      detail: `${g.length} crossing nodes within ${feet(extent).toFixed(0)} ft — a fillet-ring "diamond" where a chart shows one crossing`,
      suggestion: 'simplify the ring to a single crossing node (merge the crossings; keep the corner fillets as turn edges)',
      metric: g.length,
    })
  }
  return out
}

export interface TaxiAuditOptions {
  /** Legitimate dead-end points (runway ends + stand stop marks). Enables the dangling-node check;
   *  without them that check is skipped. */
  endpoints?: Point[]
}

/**
 * Audit a taxi graph's geometry, returning every rough spot ranked worst-first (severity, then the
 * measured metric). Pure and deterministic — same topology in, same report out.
 */
export function auditTaxiGraph(topology: TaxiTopology, opts: TaxiAuditOptions = {}): TaxiAuditReport {
  const raw: RawFinding[] = [
    ...findNearDuplicateNodes(topology.nodes),
    ...findEdgeDefects(topology.edges),
    ...findNodeAngles(topology),
    ...findKinks(topology.edges),
    ...findDisconnected(topology),
    ...findDangling(topology, opts.endpoints ?? []),
    ...findCompoundIntersections(topology.nodes),
  ]
  const findings: TaxiFinding[] = raw.map((f) => ({ ...f, category: CATEGORY_OF[f.kind] }))
  // Worst first: severity, then the sharper/closer/longer offender within a severity. Kind and
  // location break ties so the order is total and the report is byte-stable across runs.
  findings.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      severityMetric(a) - severityMetric(b) ||
      a.kind.localeCompare(b.kind) ||
      a.at[0] - b.at[0] ||
      a.at[1] - b.at[1],
  )
  const summary = { high: 0, medium: 0, low: 0, total: findings.length }
  for (const f of findings) summary[f.severity] += 1
  const byCategory: Record<TaxiCategory, number> = { connectivity: 0, redundancy: 0, intersections: 0, smoothness: 0 }
  for (const f of findings) byCategory[f.category] += 1
  return { findings, summary, graph: graphShape(topology), byCategory }
}

/** Node/edge count and connected-component count — the whole-graph shape the report opens with. */
function graphShape(topology: TaxiTopology): { nodes: number; edges: number; components: number } {
  const adj = new Map<string, string[]>()
  for (const n of topology.nodes) adj.set(n.key, [])
  for (const e of topology.edges) {
    if (e.a === e.b) continue
    adj.get(e.a)?.push(e.b)
    adj.get(e.b)?.push(e.a)
  }
  const seen = new Set<string>()
  let components = 0
  for (const n of topology.nodes) {
    if (seen.has(n.key)) continue
    components += 1
    const stack = [n.key]
    seen.add(n.key)
    while (stack.length) {
      const k = stack.pop()!
      for (const nb of adj.get(k) ?? []) if (!seen.has(nb)) { seen.add(nb); stack.push(nb) }
    }
  }
  return { nodes: topology.nodes.length, edges: topology.edges.length, components }
}

/** Rank an angle-based finding by how sharp it is (smaller angle = worse), and a size-based one by
 *  how extreme (smaller distance / shorter stub = worse; kinks: sharper = worse). Normalised so the
 *  sort is "worst first" regardless of whether the metric is an angle or a length. */
function severityMetric(f: RawFinding): number {
  switch (f.kind) {
    case 'cusp':
    case 'tight-turn':
      return f.metric // smaller angle first
    case 'kink':
      return -f.metric // larger bend first
    case 'near-duplicate-nodes':
    case 'stub-edge':
      return f.metric // closer / shorter first
    default:
      return -f.metric // bigger island / farther dangle / bigger cluster first
  }
}

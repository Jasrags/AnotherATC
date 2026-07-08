import type { AirportSurface, Point } from '../world/types'

type Key = string
interface Edge {
  to: Key
  w: number
  /** Taxiway designator this edge belongs to (e.g. "B7"), when the source feature is named. */
  ref?: string
}

/** OSM taxiway segments share vertices (identical rounded coords), so a vertex
 *  key doubles as the node identity and connectivity falls out for free. */
const keyOf = (p: Point): Key => `${p[0]},${p[1]}`

/** Undirected edge identity for two node keys — order-independent, so blocking
 *  it stops travel in either direction. */
export const edgeKey = (a: Key, b: Key): string => (a < b ? `${a}|${b}` : `${b}|${a}`)

/** A contracted taxiway edge: one run between two decision nodes, carrying its full
 *  polyline so aircraft still drive the real curve (weight is the polyline length, not
 *  the chord). {@link straight} flags a long dead-straight run to eyeball vs. the chart. */
export interface TopoEdge {
  a: Key
  b: Key
  ref?: string
  geom: Point[]
  length: number
  straight: boolean
}

/** A junction/endpoint/hold node kept after contraction, with its raw connectivity degree. */
export interface TopoNode {
  key: Key
  point: Point
  degree: number
}

/** The contracted routing topology: decision nodes + geometry-preserving edges. */
export interface TaxiTopology {
  nodes: TopoNode[]
  edges: TopoEdge[]
}

/** A contracted edge is a "review candidate" when it runs at least this far (nm)… */
const STRAIGHT_MIN_NM = 0.1
/** …in a nearly straight chord (chord ÷ polyline length above this): a real straight run,
 *  or an OSM digitization gap that cuts a corner across pavement. */
const STRAIGHT_CHORD_RATIO = 0.985

export interface TaxiGraph {
  readonly size: number
  nodePoint(key: Key): Point | undefined
  /** Nearest graph node to an arbitrary point, or null if the graph is empty. */
  nearestNode(p: Point): Key | null
  /** Nearest graph node whose point satisfies `ok`, or null. */
  nearestNodeWhere(p: Point, ok: (node: Point) => boolean): Key | null
  /** The graph-node key a point sits on (exact match), or null if it's not a node. */
  keyAt(p: Point): Key | null
  /** The taxiway designator of the edge between two adjacent nodes, or undefined. */
  refBetween(a: Key, b: Key): string | undefined
  /** Shortest path of node coordinates from start to goal, inclusive; [] if unreachable. */
  route(fromKey: Key, toKey: Key): Point[]
  /** Shortest path that avoids the given undirected edges (each an {@link edgeKey}),
   *  inclusive of endpoints; [] if blocking severs every route. */
  routeAvoiding(fromKey: Key, toKey: Key, blocked: ReadonlySet<string>): Point[]
  /** Shortest path from start to goal that traverses the given taxiways in order,
   *  inclusive of endpoints; [] if no such path exists (caller may fall back to {@link route}). */
  routeVia(fromKey: Key, toKey: Key, taxiways: readonly string[]): Point[]
  /** Contract pass-through vertices into geometry-preserving runs, leaving only decision
   *  nodes (junctions, endpoints, taxiway-name changes). See {@link TaxiTopology}. */
  topology(): TaxiTopology
}

/** A taxi edge that crosses a runway costs this many times its length, so shortest paths
 *  approach a runway threshold along the taxiway instead of cutting across mid-field.
 *  Crossings are still chosen when there's no reasonable alternative (a real crossing). */
const RUNWAY_CROSS_PENALTY = 40

const ccwSign = (a: Point, b: Point, c: Point): number =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])

/** Build a routable taxiway graph from an airport's taxiway/taxilane geometry. */
export function buildTaxiGraph(surface: AirportSurface): TaxiGraph {
  const nodes = new Map<Key, Point>()
  const adj = new Map<Key, Edge[]>()

  // Runway centerline segments, so we can surcharge taxi edges that cross them.
  const runwaySegs: [Point, Point][] = []
  for (const f of surface.features) {
    if (f.kind !== 'runway') continue
    for (let i = 1; i < f.points.length; i += 1) {
      const a = f.points[i - 1]
      const b = f.points[i]
      if (a && b) runwaySegs.push([a, b])
    }
  }
  const crossesRunway = (a: Point, b: Point): boolean =>
    runwaySegs.some(([r1, r2]) => {
      const d1 = ccwSign(r1, r2, a)
      const d2 = ccwSign(r1, r2, b)
      const d3 = ccwSign(a, b, r1)
      const d4 = ccwSign(a, b, r2)
      return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
    })

  const addNode = (p: Point): Key => {
    const k = keyOf(p)
    if (!nodes.has(k)) {
      nodes.set(k, p)
      adj.set(k, [])
    }
    return k
  }
  const addEdge = (a: Key, b: Key, w: number, ref?: string): void => {
    if (a === b) return
    const ab: Edge = ref === undefined ? { to: b, w } : { to: b, w, ref }
    const ba: Edge = ref === undefined ? { to: a, w } : { to: a, w, ref }
    adj.get(a)?.push(ab)
    adj.get(b)?.push(ba)
  }

  for (const f of surface.features) {
    if (f.kind !== 'taxiway' && f.kind !== 'taxilane') continue
    let prevKey: Key | null = null
    let prevPoint: Point | null = null
    for (const p of f.points) {
      if (!p) continue
      const k = addNode(p)
      if (prevKey && prevPoint) {
        const len = Math.hypot(p[0] - prevPoint[0], p[1] - prevPoint[1])
        const w = crossesRunway(prevPoint, p) ? len * RUNWAY_CROSS_PENALTY : len
        addEdge(prevKey, k, w, f.ref)
      }
      prevKey = k
      prevPoint = p
    }
  }

  const refBetween = (a: Key, b: Key): string | undefined => adj.get(a)?.find((e) => e.to === b)?.ref

  const nearestNodeWhere = (p: Point, ok: (node: Point) => boolean): Key | null => {
    let best: Key | null = null
    let bestDist = Infinity
    for (const [k, q] of nodes) {
      if (!ok(q)) continue
      const d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2
      if (d < bestDist) {
        bestDist = d
        best = k
      }
    }
    return best
  }
  const nearestNode = (p: Point): Key | null => nearestNodeWhere(p, () => true)

  /** Dijkstra (a few hundred nodes; linear-scan frontier is plenty). `blocked`, when
   *  given, skips any edge whose undirected {@link edgeKey} it contains. */
  const dijkstra = (fromKey: Key, toKey: Key, blocked?: ReadonlySet<string>): Point[] => {
    const start = nodes.get(fromKey)
    if (!start || !nodes.has(toKey)) return []
    if (fromKey === toKey) return [start]

    const dist = new Map<Key, number>([[fromKey, 0]])
    const prev = new Map<Key, Key>()
    const visited = new Set<Key>()
    const frontier = new Set<Key>([fromKey])

    while (frontier.size > 0) {
      let u: Key | null = null
      let ud = Infinity
      for (const k of frontier) {
        const d = dist.get(k) ?? Infinity
        if (d < ud) {
          ud = d
          u = k
        }
      }
      if (u === null) break
      frontier.delete(u)
      visited.add(u)
      if (u === toKey) break
      for (const e of adj.get(u) ?? []) {
        if (visited.has(e.to)) continue
        if (blocked && blocked.has(edgeKey(u, e.to))) continue
        const nd = ud + e.w
        if (nd < (dist.get(e.to) ?? Infinity)) {
          dist.set(e.to, nd)
          prev.set(e.to, u)
          frontier.add(e.to)
        }
      }
    }

    if (!prev.has(toKey)) return []
    const out: Point[] = []
    let cur: Key | undefined = toKey
    while (cur) {
      const p = nodes.get(cur)
      if (p) out.push(p)
      if (cur === fromKey) break
      cur = prev.get(cur)
    }
    return out.reverse()
  }

  /**
   * Contract the raw per-vertex graph into a decision-node topology. A vertex is a
   * decision node unless it is a pure pass-through (exactly two distinct neighbours joined
   * by a single taxiway name). Runs of pass-through vertices collapse into one edge that
   * retains the full polyline (so driving still follows the curve) and the true length.
   */
  const topology = (): TaxiTopology => {
    const neighboursOf = (k: Key): Key[] => [...new Set((adj.get(k) ?? []).map((e) => e.to))]
    const refsOf = (k: Key): Set<string> => new Set((adj.get(k) ?? []).map((e) => e.ref ?? ''))
    const isPassThrough = (k: Key): boolean => neighboursOf(k).length === 2 && refsOf(k).size === 1
    const pointOf = (k: Key): Point => nodes.get(k) ?? [0, 0]
    const refOf = (a: Key, b: Key): string | undefined => refBetween(a, b)

    const consumed = new Set<string>()
    const edges: TopoEdge[] = []
    /** Walk from a decision node `u` toward neighbour `v0` through pass-through vertices. */
    const walk = (u: Key, v0: Key): void => {
      if (consumed.has(edgeKey(u, v0))) return
      const geom: Point[] = [pointOf(u), pointOf(v0)]
      const ref = refOf(u, v0)
      let length = Math.hypot(pointOf(v0)[0] - pointOf(u)[0], pointOf(v0)[1] - pointOf(u)[1])
      consumed.add(edgeKey(u, v0))
      let prev = u
      let cur = v0
      while (isPassThrough(cur) && cur !== u) {
        const next = neighboursOf(cur).find((k) => k !== prev)
        if (!next || consumed.has(edgeKey(cur, next))) break
        consumed.add(edgeKey(cur, next))
        const cp = pointOf(cur)
        const np = pointOf(next)
        length += Math.hypot(np[0] - cp[0], np[1] - cp[1])
        geom.push(np)
        prev = cur
        cur = next
      }
      const chord = Math.hypot(pointOf(cur)[0] - pointOf(u)[0], pointOf(cur)[1] - pointOf(u)[1])
      const straight = length > STRAIGHT_MIN_NM && chord / length > STRAIGHT_CHORD_RATIO
      edges.push(ref === undefined ? { a: u, b: cur, geom, length, straight } : { a: u, b: cur, ref, geom, length, straight })
    }

    for (const k of nodes.keys()) {
      if (isPassThrough(k)) continue
      for (const v of neighboursOf(k)) walk(k, v)
    }
    // Any raw edge still unconsumed belongs to an all-pass-through loop (no decision node);
    // seed it from an arbitrary vertex so the loop still appears in the topology.
    for (const k of nodes.keys()) {
      for (const v of neighboursOf(k)) {
        if (!consumed.has(edgeKey(k, v))) walk(k, v)
      }
    }

    const kept = new Set<Key>()
    for (const e of edges) {
      kept.add(e.a)
      kept.add(e.b)
    }
    const topoNodes: TopoNode[] = [...kept].map((k) => ({ key: k, point: pointOf(k), degree: neighboursOf(k).length }))
    return { nodes: topoNodes, edges }
  }

  const route = (fromKey: Key, toKey: Key): Point[] => dijkstra(fromKey, toKey)
  const routeAvoiding = (fromKey: Key, toKey: Key, blocked: ReadonlySet<string>): Point[] =>
    dijkstra(fromKey, toKey, blocked)

  /**
   * Shortest path that traverses `taxiways` in order. Searches a product graph of
   * (node, k) where k = how many of the required taxiways have been entered so far;
   * traversing an edge whose ref matches taxiways[k] advances k. The goal is the
   * destination node with all taxiways consumed. [] if no such path exists.
   */
  const routeVia = (fromKey: Key, toKey: Key, taxiways: readonly string[]): Point[] => {
    if (!nodes.has(fromKey) || !nodes.has(toKey)) return []
    const seq = taxiways.filter((t) => t.length > 0)
    if (seq.length === 0) return route(fromKey, toKey)
    const K = seq.length
    const state = (nk: Key, k: number): string => `${nk}#${k}`
    const startState = state(fromKey, 0)
    const dist = new Map<string, number>([[startState, 0]])
    const prev = new Map<string, string>()
    const visited = new Set<string>()
    const frontier = new Set<string>([startState])
    let goalState: string | null = null

    while (frontier.size > 0) {
      let u: string | null = null
      let ud = Infinity
      for (const s of frontier) {
        const d = dist.get(s) ?? Infinity
        if (d < ud) {
          ud = d
          u = s
        }
      }
      if (u === null) break
      frontier.delete(u)
      visited.add(u)
      const hash = u.lastIndexOf('#')
      const nk = u.slice(0, hash)
      const k = Number(u.slice(hash + 1))
      if (nk === toKey && k === K) {
        goalState = u
        break
      }
      for (const e of adj.get(nk) ?? []) {
        const nextK = k < K && e.ref === seq[k] ? k + 1 : k
        const ns = state(e.to, nextK)
        if (visited.has(ns)) continue
        const nd = ud + e.w
        if (nd < (dist.get(ns) ?? Infinity)) {
          dist.set(ns, nd)
          prev.set(ns, u)
          frontier.add(ns)
        }
      }
    }

    if (!goalState) return []
    const out: Point[] = []
    let cur: string | undefined = goalState
    while (cur) {
      const p = nodes.get(cur.slice(0, cur.lastIndexOf('#')))
      if (p) out.push(p)
      if (cur === startState) break
      cur = prev.get(cur)
    }
    return out.reverse()
  }

  return {
    get size() {
      return nodes.size
    },
    nodePoint: (k) => nodes.get(k),
    nearestNode,
    nearestNodeWhere,
    keyAt: (p) => {
      const k = keyOf(p)
      return nodes.has(k) ? k : null
    },
    refBetween,
    route,
    routeAvoiding,
    routeVia,
    topology,
  }
}

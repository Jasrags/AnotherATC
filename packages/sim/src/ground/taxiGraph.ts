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
  /** Distinct nodes directly connected to `key` — the ways out of it. */
  neighbours(key: Key): Key[]
  /** Shortest path of node coordinates from start to goal, inclusive; [] if unreachable.
   *  `fromHeadingDeg` commits the aircraft to a direction it is already facing, so the route
   *  cannot begin with a turn it could not physically make (see {@link MAX_TURN_DEG}). */
  route(fromKey: Key, toKey: Key, fromHeadingDeg?: number): Point[]
  /** Shortest path that avoids the given undirected edges (each an {@link edgeKey}),
   *  inclusive of endpoints; [] if blocking severs every route. */
  routeAvoiding(fromKey: Key, toKey: Key, blocked: ReadonlySet<string>, fromHeadingDeg?: number): Point[]
  /** Shortest path from start to goal that traverses the given taxiways in order,
   *  inclusive of endpoints; [] if no such path exists (caller may fall back to {@link route}). */
  routeVia(fromKey: Key, toKey: Key, taxiways: readonly string[]): Point[]
  /** Contract pass-through vertices into geometry-preserving runs, leaving only decision
   *  nodes (junctions, endpoints, taxiway-name changes). See {@link TaxiTopology}. */
  topology(): TaxiTopology
}

/**
 * Sharpest turn (deg of deviation from straight ahead) an aircraft can make at a junction.
 *
 * Measured against the field before being chosen: across all 51 KSAN gate→runway routes the
 * turn distribution is 4,492 turns under 30°, one between 30° and 60°, and 8 between 150° and
 * 180°. The 150°+ group are near-reversals the router used to plan through Terminal 1 — turns
 * no aircraft can make. The gap between 60° and 150° is wide enough that the exact threshold
 * is not load-bearing; it only has to sit inside it.
 */
export const MAX_TURN_DEG = 120
/** Cost (nm) added for a turn, scaled by how sharp it is, so a route prefers the gentler of
 *  two otherwise-equal options rather than treating a hairpin as free. */
const TURN_COST_NM = 0.02

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
  const neighbours = (key: Key): Key[] => [...new Set((adj.get(key) ?? []).map((e) => e.to))]

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

  const bearingOf = (a: Point, b: Point): number =>
    ((Math.atan2(b[0] - a[0], b[1] - a[1]) * 180) / Math.PI + 360) % 360
  /** Deviation from straight ahead: 0 = carry straight on, 180 = double back. */
  const deviation = (inbound: number, outbound: number): number =>
    Math.abs((((outbound - inbound + 540) % 360) - 180))

  /**
   * Dijkstra over (arriving edge → node) states rather than bare nodes.
   *
   * A node-keyed search cannot see turns at all: the cost of reaching a junction says nothing
   * about which way you came into it, so the router will happily plan a route that arrives at a
   * junction and leaves back down the taxiway it came from. Carrying the arriving node in the
   * state makes the turn angle knowable, which is what lets an impossible one be refused and a
   * sharp one be charged for.
   *
   * `fromHeadingDeg` seeds the search with a direction the aircraft is already committed to —
   * after a pushback, or mid-taxi — so the *first* turn is constrained like every other one.
   */
  const dijkstra = (
    fromKey: Key,
    toKey: Key,
    blocked?: ReadonlySet<string>,
    fromHeadingDeg?: number,
  ): Point[] => {
    const start = nodes.get(fromKey)
    if (!start || !nodes.has(toKey)) return []
    if (fromKey === toKey) return [start]

    /** A state is "arrived at `at` from `via`"; `via` is null only for the start. */
    const stateKey = (via: Key | null, at: Key): string => `${via ?? ''}>${at}`
    const dist = new Map<string, number>()
    const prev = new Map<string, { via: Key | null; at: Key }>()
    const heap: { d: number; via: Key | null; at: Key }[] = []
    const push = (d: number, via: Key | null, at: Key): void => {
      heap.push({ d, via, at })
      let i = heap.length - 1
      while (i > 0) {
        const p = (i - 1) >> 1
        if (heap[p]!.d <= heap[i]!.d) break
        ;[heap[p], heap[i]] = [heap[i]!, heap[p]!]
        i = p
      }
    }
    const pop = (): { d: number; via: Key | null; at: Key } | undefined => {
      const top = heap[0]
      const last = heap.pop()
      if (heap.length > 0 && last) {
        heap[0] = last
        let i = 0
        for (;;) {
          const l = i * 2 + 1
          const r = l + 1
          let m = i
          if (l < heap.length && heap[l]!.d < heap[m]!.d) m = l
          if (r < heap.length && heap[r]!.d < heap[m]!.d) m = r
          if (m === i) break
          ;[heap[m], heap[i]] = [heap[i]!, heap[m]!]
          i = m
        }
      }
      return top
    }

    dist.set(stateKey(null, fromKey), 0)
    push(0, null, fromKey)
    let goal: { via: Key | null; at: Key } | null = null

    while (heap.length > 0) {
      const cur = pop()
      if (!cur) break
      const sk = stateKey(cur.via, cur.at)
      if (cur.d > (dist.get(sk) ?? Infinity)) continue
      if (cur.at === toKey) {
        goal = { via: cur.via, at: cur.at }
        break
      }
      const here = nodes.get(cur.at)
      if (!here) continue
      // Direction we arrived on: the previous leg, or the committed heading at the start.
      const inbound =
        cur.via !== null ? bearingOf(nodes.get(cur.via) as Point, here) : fromHeadingDeg
      for (const e of adj.get(cur.at) ?? []) {
        if (e.to === cur.via) continue // never immediately retrace the leg just flown
        if (blocked && blocked.has(edgeKey(cur.at, e.to))) continue
        const next = nodes.get(e.to)
        if (!next) continue
        let turn = 0
        if (inbound !== undefined) {
          turn = deviation(inbound, bearingOf(here, next))
          if (turn > MAX_TURN_DEG) continue // pavement no aircraft could turn onto
        }
        const nd = cur.d + e.w + (turn / 180) * TURN_COST_NM
        const nk = stateKey(cur.at, e.to)
        if (nd < (dist.get(nk) ?? Infinity)) {
          dist.set(nk, nd)
          prev.set(nk, { via: cur.via, at: cur.at })
          push(nd, cur.at, e.to)
        }
      }
    }

    if (!goal) return []
    const out: Point[] = []
    let cur: { via: Key | null; at: Key } | undefined = goal
    while (cur) {
      const p = nodes.get(cur.at)
      if (p) out.push(p)
      if (cur.at === fromKey && cur.via === null) break
      cur = prev.get(stateKey(cur.via, cur.at))
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

  const route = (fromKey: Key, toKey: Key, fromHeadingDeg?: number): Point[] =>
    dijkstra(fromKey, toKey, undefined, fromHeadingDeg)
  const routeAvoiding = (
    fromKey: Key,
    toKey: Key,
    blocked: ReadonlySet<string>,
    fromHeadingDeg?: number,
  ): Point[] => dijkstra(fromKey, toKey, blocked, fromHeadingDeg)

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
    neighbours,
    route,
    routeAvoiding,
    routeVia,
    topology,
  }
}

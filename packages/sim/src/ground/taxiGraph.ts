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

export interface TaxiGraph {
  readonly size: number
  nodePoint(key: Key): Point | undefined
  /** Nearest graph node to an arbitrary point, or null if the graph is empty. */
  nearestNode(p: Point): Key | null
  /** The graph-node key a point sits on (exact match), or null if it's not a node. */
  keyAt(p: Point): Key | null
  /** The taxiway designator of the edge between two adjacent nodes, or undefined. */
  refBetween(a: Key, b: Key): string | undefined
  /** Shortest path of node coordinates from start to goal, inclusive; [] if unreachable. */
  route(fromKey: Key, toKey: Key): Point[]
  /** Shortest path from start to goal that traverses the given taxiways in order,
   *  inclusive of endpoints; [] if no such path exists (caller may fall back to {@link route}). */
  routeVia(fromKey: Key, toKey: Key, taxiways: readonly string[]): Point[]
}

/** Build a routable taxiway graph from an airport's taxiway/taxilane geometry. */
export function buildTaxiGraph(surface: AirportSurface): TaxiGraph {
  const nodes = new Map<Key, Point>()
  const adj = new Map<Key, Edge[]>()

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
        addEdge(prevKey, k, Math.hypot(p[0] - prevPoint[0], p[1] - prevPoint[1]), f.ref)
      }
      prevKey = k
      prevPoint = p
    }
  }

  const refBetween = (a: Key, b: Key): string | undefined => adj.get(a)?.find((e) => e.to === b)?.ref

  const nearestNode = (p: Point): Key | null => {
    let best: Key | null = null
    let bestDist = Infinity
    for (const [k, q] of nodes) {
      const d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2
      if (d < bestDist) {
        bestDist = d
        best = k
      }
    }
    return best
  }

  const route = (fromKey: Key, toKey: Key): Point[] => {
    const start = nodes.get(fromKey)
    if (!start || !nodes.has(toKey)) return []
    if (fromKey === toKey) return [start]

    // Dijkstra (a few hundred nodes; linear-scan frontier is plenty).
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
    keyAt: (p) => {
      const k = keyOf(p)
      return nodes.has(k) ? k : null
    },
    refBetween,
    route,
    routeVia,
  }
}

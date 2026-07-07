import type { AirportSurface, Point } from '../world/types'

type Key = string
interface Edge {
  to: Key
  w: number
}

/** OSM taxiway segments share vertices (identical rounded coords), so a vertex
 *  key doubles as the node identity and connectivity falls out for free. */
const keyOf = (p: Point): Key => `${p[0]},${p[1]}`

export interface TaxiGraph {
  readonly size: number
  nodePoint(key: Key): Point | undefined
  /** Nearest graph node to an arbitrary point, or null if the graph is empty. */
  nearestNode(p: Point): Key | null
  /** Shortest path of node coordinates from start to goal, inclusive; [] if unreachable. */
  route(fromKey: Key, toKey: Key): Point[]
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
  const addEdge = (a: Key, b: Key, w: number): void => {
    if (a === b) return
    adj.get(a)?.push({ to: b, w })
    adj.get(b)?.push({ to: a, w })
  }

  for (const f of surface.features) {
    if (f.kind !== 'taxiway' && f.kind !== 'taxilane') continue
    let prevKey: Key | null = null
    let prevPoint: Point | null = null
    for (const p of f.points) {
      if (!p) continue
      const k = addNode(p)
      if (prevKey && prevPoint) {
        addEdge(prevKey, k, Math.hypot(p[0] - prevPoint[0], p[1] - prevPoint[1]))
      }
      prevKey = k
      prevPoint = p
    }
  }

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

  return {
    get size() {
      return nodes.size
    },
    nodePoint: (k) => nodes.get(k),
    nearestNode,
    route,
  }
}

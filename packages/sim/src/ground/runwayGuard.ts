import type { AirportSurface, Point } from '../world/types'

interface Seg {
  a: Point
  b: Point
  /** Which physical runway this segment belongs to — the surface feature's designator-pair ref
   *  (e.g. "09/27"). A field's own answer to "which runway is this", per docs/atc-multi-runway.md
   *  §1. A single-runway field has one value here for every segment. */
  runwayId: string
}

export interface RunwayGuard {
  segments: readonly Seg[]
  /** Perpendicular half-width (nm) of the protected zone around the centerline. */
  halfZoneNm: number
}

/** Just past the runway edge — small enough that the parallel taxiway (~400 ft off) never trips it. */
const HALF_ZONE_NM = 0.02

/** Runway centerline segments, used to detect when a taxi route crosses a runway. */
export function buildRunwayGuard(surface: AirportSurface): RunwayGuard {
  const segments: Seg[] = []
  let runwayIndex = 0
  for (const f of surface.features) {
    if (f.kind !== 'runway') continue
    // A runway feature should carry its designator ("09/27"); if a field omits it the runway
    // still guards, just under a stable synthetic id so onRunway coverage is never dropped.
    const runwayId = f.ref ?? `runway-${runwayIndex}`
    runwayIndex += 1
    for (let i = 1; i < f.points.length; i += 1) {
      const a = f.points[i - 1]
      const b = f.points[i]
      if (a && b) segments.push({ a, b, runwayId })
    }
  }
  return { segments, halfZoneNm: HALF_ZONE_NM }
}

/**
 * The physical runway a point lies on — the id of the nearest centerline segment within the
 * protected zone — or null if the point is off all runways. This is the primitive that lets
 * occupancy, line-up and wake reason about *which* runway, rather than treating the field as one
 * (docs/atc-multi-runway.md §1). `onRunway` answers "any runway"; this answers "which".
 */
export function runwayIdAt(p: Point, guard: RunwayGuard): string | null {
  let best: string | null = null
  let bestD = guard.halfZoneNm
  for (const s of guard.segments) {
    const d = distToSeg(p, s.a, s.b)
    if (d <= bestD) {
      bestD = d
      best = s.runwayId
    }
  }
  return best
}

function distToSeg(p: Point, a: Point, b: Point): number {
  const vx = b[0] - a[0]
  const vy = b[1] - a[1]
  const l2 = vx * vx + vy * vy
  let t = l2 > 0 ? ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / l2 : 0
  t = t < 0 ? 0 : t > 1 ? 1 : t
  return Math.hypot(p[0] - (a[0] + t * vx), p[1] - (a[1] + t * vy))
}

export function onRunway(p: Point, guard: RunwayGuard): boolean {
  for (const s of guard.segments) {
    if (distToSeg(p, s.a, s.b) <= guard.halfZoneNm) return true
  }
  return false
}

const ccw = (a: Point, b: Point, c: Point): number =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])

/** Do segments p1p2 and p3p4 properly cross (interiors intersect)? */
function segmentsCross(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
  const d1 = ccw(p3, p4, p1)
  const d2 = ccw(p3, p4, p2)
  const d3 = ccw(p1, p2, p3)
  const d4 = ccw(p1, p2, p4)
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
}

function crossesCenterline(a: Point, b: Point, guard: RunwayGuard): boolean {
  for (const s of guard.segments) {
    if (segmentsCross(a, b, s.a, s.b)) return true
  }
  return false
}

/**
 * Split a route where it first enters a runway. `drive` ends at the hold-short
 * vertex; `held` is the portion from that vertex onward (across the runway),
 * or null if the route never touches a runway.
 */
export function splitRouteAtRunway(
  route: readonly Point[],
  guard: RunwayGuard,
): { drive: Point[]; held: Point[] | null } {
  for (let i = 0; i < route.length - 1; i += 1) {
    const a = route[i]
    const b = route[i + 1]
    if (!a || !b) continue
    if (onRunway(a, guard)) continue // already at/past the runway
    if (onRunway(b, guard) || crossesCenterline(a, b, guard)) {
      return { drive: route.slice(0, i + 1), held: route.slice(i) }
    }
  }
  return { drive: [...route], held: null }
}

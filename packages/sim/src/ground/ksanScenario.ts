import { createRng } from '../random'
import { KSAN_SURFACE } from '../world/ksan'
import type { Point } from '../world/types'
import type { AircraftInit, } from './sim'
import type { WakeCategory } from './types'

const AIRLINES = ['AAL', 'UAL', 'DAL', 'SWA', 'ASA', 'NKS', 'JBU', 'SKW']
const TYPES: readonly [string, WakeCategory][] = [
  ['B738', 'M'],
  ['A320', 'M'],
  ['A321', 'M'],
  ['B739', 'M'],
  ['A20N', 'M'],
  ['E75L', 'M'],
  ['CRJ7', 'M'],
  ['B763', 'H'],
]

function pathLength(pts: readonly Point[]): number {
  let d = 0
  for (let i = 1; i < pts.length; i += 1) {
    const a = pts[i - 1]
    const b = pts[i]
    if (a && b) d += Math.hypot(b[0] - a[0], b[1] - a[1])
  }
  return d
}

/** ~15 ft tolerance — connected OSM taxiways share a node, so endpoints coincide. */
const JOINT_EPS = 1.5e-3
const near = (a: Point, b: Point): boolean =>
  Math.hypot(a[0] - b[0], a[1] - b[1]) < JOINT_EPS

interface Segment {
  pts: Point[]
  used: boolean
}

/** Greedily stitch connected taxiway segments into one continuous route. */
function stitchRoute(seed: Segment, segments: Segment[]): Point[] {
  seed.used = true
  const route: Point[] = [...seed.pts]

  let extended = true
  while (extended && route.length < 60) {
    const tail = route[route.length - 1]
    if (!tail) break
    extended = false
    for (const seg of segments) {
      if (seg.used) continue
      const head = seg.pts[0]
      const foot = seg.pts[seg.pts.length - 1]
      if (!head || !foot) continue
      if (near(head, tail)) {
        route.push(...seg.pts.slice(1))
      } else if (near(foot, tail)) {
        route.push(...[...seg.pts].reverse().slice(1))
      } else {
        continue
      }
      seg.used = true
      extended = true
      break
    }
  }
  return route
}

function midpoint(pts: readonly Point[]): Point {
  const m = pts[Math.floor(pts.length / 2)] ?? pts[0]
  return m ?? [0, 0]
}

function callsign(rng: ReturnType<typeof createRng>): string {
  const airline = AIRLINES[rng.int(0, AIRLINES.length - 1)] ?? 'AAL'
  return `${airline}${rng.int(100, 1899)}`
}

function aircraftType(rng: ReturnType<typeof createRng>): [string, WakeCategory] {
  return TYPES[rng.int(0, TYPES.length - 1)] ?? ['B738', 'M']
}

/**
 * Build a deterministic KSAN ground scenario: several aircraft taxiing along
 * real (stitched) taxiway routes, plus a few parked at stands. Same seed →
 * same fleet.
 */
export function buildKsanGroundScenario(seed = 1): AircraftInit[] {
  const rng = createRng(seed)

  const segments: Segment[] = KSAN_SURFACE.features
    .filter((f) => (f.kind === 'taxiway' || f.kind === 'taxilane') && f.points.length >= 2)
    .map((f) => ({ pts: [...f.points], used: false }))

  // Seed routes from the longest segments first so they span the field.
  const bySize = [...segments].sort((a, b) => pathLength(b.pts) - pathLength(a.pts))

  const fleet: AircraftInit[] = []
  for (const seg of bySize) {
    if (fleet.length >= 7) break
    if (seg.used) continue
    let route = stitchRoute(seg, segments)
    if (pathLength(route) < 0.18) continue // skip stubs (< ~1100 ft)
    if (rng.int(0, 1) === 1) route = [...route].reverse()
    const [type, wake] = aircraftType(rng)
    fleet.push({
      id: `t${fleet.length}`,
      callsign: callsign(rng),
      type,
      wake,
      path: route,
      targetSpeed: 10 + rng.int(0, 8), // 10–18 kt
    })
  }

  // A few parked aircraft at stands, for visual density.
  const stands = KSAN_SURFACE.features.filter(
    (f) => f.kind === 'parking_position' && f.points.length >= 2,
  )
  const parkedCount = Math.min(4, stands.length)
  const stride = Math.max(1, Math.floor(stands.length / (parkedCount || 1)))
  for (let i = 0; i < parkedCount; i += 1) {
    const stand = stands[i * stride]
    if (!stand) continue
    const a = stand.points[0]
    const b = stand.points[stand.points.length - 1]
    if (!a || !b) continue
    const heading = (Math.atan2(b[0] - a[0], b[1] - a[1]) * 180) / Math.PI
    const [type, wake] = aircraftType(rng)
    fleet.push({
      id: `p${i}`,
      callsign: callsign(rng),
      type,
      wake,
      path: [midpoint(stand.points)],
      targetSpeed: 0,
      heading,
    })
  }

  return fleet
}

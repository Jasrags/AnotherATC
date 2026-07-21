import type { Point } from '../world/types'
import type { TaxiTopology } from './taxiGraph'
import { onRunway, type RunwayGuard } from './runwayGuard'

/**
 * A charted runway turnoff, as usable by an aircraft landing in one particular direction.
 *
 * Real airports mix two kinds (FAA AC 150/5300-13, "Airport Design"):
 *  - a **rapid exit taxiway** (RET, a.k.a. high-speed exit / long-radius exit) meets the runway
 *    at an acute angle, so a jet can leave the runway at 30–50 kt;
 *  - a **standard exit** meets it at ~90°, which needs 10–15 kt to make the turn.
 *
 * The difference is the main lever on *runway occupancy time*, which is what actually limits
 * arrival throughput — so exits have to be real objects, not a by-product of where the braking
 * happens to end. See docs/atc-tower.md.
 */
export interface RunwayExit {
  /** Taxiway designator, e.g. "B6". */
  ref: string
  /** Where the turnoff leaves the runway. */
  point: Point
  /** First node clear of the runway along the turnoff — where the aircraft counts as vacated. */
  vacatePoint: Point
  /** Angle (deg, 0–180) between the landing direction and the turnoff. */
  angleDeg: number
  kind: 'rapid' | 'standard'
  /** Which way the aircraft turns off. */
  turn: 'left' | 'right'
  /** Distance (nm) from the landing threshold, measured along the runway. */
  distanceNm: number
  /** Highest speed (kt) the turn can be taken at. */
  speedKt: number
}

/** At or below this angle the turnoff is a rapid exit (real RETs are 25–45°; the ingested
 *  fillet geometry lands a little wider, so the bar is set to admit them). */
const RAPID_MAX_DEG = 60
/** Beyond this angle the taxiway is not a usable turnoff for this landing direction at all —
 *  it points back down the runway, i.e. it is an exit for the *opposite* direction. */
const EXIT_MAX_DEG = 100
/** Speed (kt) a rapid exit can be taken at. */
const RAPID_EXIT_KT = 40
/** Speed (kt) a right-angle turnoff can be taken at. */
const STANDARD_EXIT_KT = 12
/** Ignore turnoffs within this distance (nm) of either threshold — they are runway entrances,
 *  not landing exits, and nothing can slow down enough to use one that early anyway. */
const END_MARGIN_NM = 0.03

const dot = (ax: number, ay: number, bx: number, by: number): number => ax * bx + ay * by
const cross = (ax: number, ay: number, bx: number, by: number): number => ax * by - ay * bx

/**
 * Derive the turnoffs usable by an aircraft landing from `threshold` toward `farEnd`.
 *
 * Everything comes from geometry already in the surface data: a connector meets the runway
 * with several legs (an acute lead-in, a perpendicular, and the mirrored acute lead-in for the
 * opposite landing direction), so the leg that makes the shallowest angle *with the direction of
 * landing* is the one an arrival would actually use, and its angle says whether the turnoff is
 * rapid or standard. No new chart data is needed — but the result should still be eyeballed
 * against the airport diagram (docs/SAN/) before it is trusted.
 */
export function buildRunwayExits(
  topology: TaxiTopology,
  guard: RunwayGuard,
  threshold: Point,
  farEnd: Point,
): RunwayExit[] {
  const rx = farEnd[0] - threshold[0]
  const ry = farEnd[1] - threshold[1]
  const runLen = Math.hypot(rx, ry)
  if (runLen < 1e-6) return []
  const ux = rx / runLen
  const uy = ry / runLen

  const nodePoint = new Map(topology.nodes.map((n) => [n.key, n.point]))
  /** Best (shallowest) candidate per taxiway designator. */
  const best = new Map<string, RunwayExit>()

  for (const edge of topology.edges) {
    if (!edge.ref) continue
    const a = nodePoint.get(edge.a)
    const b = nodePoint.get(edge.b)
    if (!a || !b) continue
    const aOn = onRunway(a, guard)
    const bOn = onRunway(b, guard)
    if (aOn === bOn) continue // both on or both off — not a runway turnoff

    // Orient the polyline so it leaves the runway, and take its first step as the turn.
    const geom = aOn ? edge.geom : [...edge.geom].reverse()
    const from = geom[0]
    const step = geom[1]
    if (!from || !step) continue

    const dx = step[0] - from[0]
    const dy = step[1] - from[1]
    const stepLen = Math.hypot(dx, dy)
    if (stepLen < 1e-9) continue
    const cosA = dot(ux, uy, dx / stepLen, dy / stepLen)
    const angleDeg = (Math.acos(Math.max(-1, Math.min(1, cosA))) * 180) / Math.PI
    if (angleDeg > EXIT_MAX_DEG) continue

    const distanceNm = dot(from[0] - threshold[0], from[1] - threshold[1], ux, uy)
    if (distanceNm < END_MARGIN_NM || distanceNm > runLen - END_MARGIN_NM) continue

    const kind = angleDeg <= RAPID_MAX_DEG ? 'rapid' : 'standard'
    const candidate: RunwayExit = {
      ref: edge.ref,
      point: from,
      vacatePoint: aOn ? b : a,
      angleDeg,
      kind,
      turn: cross(ux, uy, dx, dy) > 0 ? 'left' : 'right',
      distanceNm,
      speedKt: kind === 'rapid' ? RAPID_EXIT_KT : STANDARD_EXIT_KT,
    }
    const prev = best.get(edge.ref)
    if (!prev || candidate.angleDeg < prev.angleDeg) best.set(edge.ref, candidate)
  }

  return [...best.values()].sort((p, q) => p.distanceNm - q.distanceNm)
}

// ─── Braking to make a turnoff ───────────────────────────────────────────────
/** Hardest deceleration (kt/s) on a landing rollout — heavy braking. */
export const MAX_BRAKE_KT_S = 5
/** Gentlest deceleration (kt/s) — an aircraft with a long way to the assigned exit still slows
 *  at least this much rather than coasting the runway at approach speed. */
export const MIN_BRAKE_KT_S = 1.5

/** Deceleration (kt/s) needed to arrive at `distanceNm` having slowed from `fromKt` to `toKt`.
 *  Derived from v² = v₀² + 2·a·x with speeds in kt and distance in nm (hence the 7200). */
export function brakeRateFor(fromKt: number, toKt: number, distanceNm: number): number {
  if (distanceNm <= 0) return Infinity
  return (fromKt * fromKt - toKt * toKt) / (7200 * distanceNm)
}

/** Seconds to roll `distanceNm` while slowing from `fromKt` to the exit speed at `rate`, then
 *  holding that speed for whatever distance is left. This is runway occupancy — the number the
 *  turnoff choice is really trading. */
export function rolloutSeconds(fromKt: number, exit: RunwayExit, rate: number): number {
  const braking = (fromKt - exit.speedKt) / rate
  const brakeDist = (fromKt * fromKt - exit.speedKt * exit.speedKt) / (7200 * rate)
  const coast = Math.max(0, exit.distanceNm - brakeDist)
  return braking + (coast / exit.speedKt) * 3600
}

/**
 * The turnoff an arrival would plan for: of the exits it can still make without exceeding
 * {@link MAX_BRAKE_KT_S}, the one that gets it off the runway soonest. That naturally prefers a
 * rapid exit over rolling to a distant right-angle one, which is exactly why RETs exist.
 */
export function chooseExit(
  exits: readonly RunwayExit[],
  fromKt: number,
  atDistanceNm: number,
): RunwayExit | null {
  let bestExit: RunwayExit | null = null
  let bestSec = Infinity
  for (const e of exits) {
    const remaining = e.distanceNm - atDistanceNm
    if (remaining <= 0) continue // already behind us
    const required = brakeRateFor(fromKt, e.speedKt, remaining)
    if (required > MAX_BRAKE_KT_S) continue // can't slow down enough to make this one
    const rate = Math.max(required, MIN_BRAKE_KT_S)
    const sec = rolloutSeconds(fromKt, { ...e, distanceNm: remaining }, rate)
    if (sec < bestSec) {
      bestSec = sec
      bestExit = e
    }
  }
  return bestExit
}

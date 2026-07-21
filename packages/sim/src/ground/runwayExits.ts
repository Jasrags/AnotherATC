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
  /** The turnoff's real polyline, from `point` to `vacatePoint`. An aircraft drives *this*, not
   *  the chord between the endpoints — a connector is a curve, and cutting it both looks wrong
   *  and hides the fact that the curve is what limits the speed. */
  geom: Point[]
  /** First node clear of the runway along the turnoff — where the aircraft counts as vacated. */
  vacatePoint: Point
  /** Angle (deg, 0–180) between the landing direction and the turnoff. */
  angleDeg: number
  kind: 'rapid' | 'standard'
  /** Which way the aircraft turns off. */
  turn: 'left' | 'right'
  /** Distance (nm) from the landing threshold, measured along the runway. */
  distanceNm: number
  /** Length (nm) of the turnoff itself — how far the aircraft still travels after leaving the
   *  runway before it is clear, which is part of the occupancy the turnoff choice trades. */
  lengthNm: number
  /** Highest speed (kt) the turn can be taken at. */
  speedKt: number
}

/** Beyond this angle the taxiway is not a usable turnoff for this landing direction at all —
 *  it points back down the runway, i.e. it is an exit for the *opposite* direction. */
const EXIT_MAX_DEG = 100
/** At or above this taken-at speed (kt) a turnoff is operationally a high-speed exit. */
const RAPID_MIN_KT = 25
/** Nothing is taken faster than this (kt) however gentle the surveyed curve looks. */
const MAX_EXIT_KT = 50
/** …nor slower than this: a tight fillet is still driveable at walking pace. */
const MIN_EXIT_KT = 10
/** Assumed fillet size (nm ≈ 180 ft) at the corner where a turnoff leaves the runway.
 *  Surveyed data very often digitizes a connector as a single straight line with no fillet at
 *  all, so the entry curve has to be inferred from the turn angle instead: radius =
 *  FILLET_NM / tan(δ/2). That yields ~18 kt for a 90° turnoff and ~34 kt for a 30° one, which
 *  is the right family of numbers for the geometries those angles imply. */
const FILLET_NM = 0.03

/**
 * Speed (kt) at which a turn of radius `radiusNm` can be taken, from the lateral acceleration
 * a transport aircraft will accept on the ground (~0.15 g).
 *
 *   a = v²/R  with v in kt (×1.68781 ft/s) and R in nm (×6076.12 ft)
 *   ⇒ v[kt] = √(a[ft/s²] · R[nm] / 4.688e-4) = 101.5·√R  for a = 0.15 g
 *
 * Sanity check against real design values: a 1,500 ft (0.25 nm) high-speed exit radius gives
 * ~50 kt, and a tight 300 ft fillet gives ~23 kt — which is what those geometries are built for.
 */
const TURN_KT_PER_SQRT_NM = 101.5
export function turnSpeedFor(radiusNm: number): number {
  return TURN_KT_PER_SQRT_NM * Math.sqrt(Math.max(0, radiusNm))
}

/** Arc length (nm ≈ 120 ft) either side of a vertex used to measure how sharply the path is
 *  turning there. Real connector polylines are digitized at wildly different densities — some
 *  are two points, some are twenty — so curvature has to be measured over a fixed *distance*
 *  rather than between adjacent vertices, where a few feet of survey jitter reads as a 60 ft
 *  radius and would slow every aircraft to walking pace. */
const CURVE_WINDOW_NM = 0.02
/** Distance (nm ≈ 300 ft) over which the turnoff's angle to the runway is measured, for the
 *  same reason: the first millimetre of a fillet is parallel to the runway on every exit. */
const ENTRY_WINDOW_NM = 0.05

/** Walk `windowNm` along `geom` from `i` in direction `step`; returns the point reached (or the
 *  end of the line) and the arc length actually covered. */
function walk(geom: readonly Point[], i: number, step: 1 | -1, windowNm: number): { at: Point; arc: number } {
  let arc = 0
  let j = i
  let at = geom[i] as Point
  while (arc < windowNm) {
    const next = geom[j + step]
    if (!next) break
    const cur = geom[j] as Point
    arc += Math.hypot(next[0] - cur[0], next[1] - cur[1])
    at = next
    j += step
  }
  return { at, arc }
}

const headingOf = (a: Point, b: Point): number => Math.atan2(b[1] - a[1], b[0] - a[0])
const angleBetween = (h1: number, h2: number): number => Math.abs(Math.atan2(Math.sin(h2 - h1), Math.cos(h2 - h1)))

/**
 * Per-vertex speed limits (kt) along a polyline: at each vertex, how sharply the path turns
 * over {@link CURVE_WINDOW_NM} either side gives a radius (R = arc / Δθ), and that radius bounds
 * the speed through it. Endpoints and straight runs are unconstrained.
 *
 * This is what stops an aircraft taking a 90° turnoff at high-speed-exit speed: the limit comes
 * from the surveyed shape of the pavement, not from a label attached to it.
 */
export function turnSpeedLimits(geom: readonly Point[]): number[] {
  const limits = geom.map(() => Infinity)
  for (let i = 1; i < geom.length - 1; i += 1) {
    const here = geom[i]
    if (!here) continue
    const back = walk(geom, i, -1, CURVE_WINDOW_NM)
    const fwd = walk(geom, i, 1, CURVE_WINDOW_NM)
    const arc = back.arc + fwd.arc
    if (arc < 1e-9) continue
    const turn = angleBetween(headingOf(back.at, here), headingOf(here, fwd.at))
    if (turn < 1e-4) continue
    limits[i] = turnSpeedFor(arc / turn)
  }
  return limits
}

/** The turnoff's angle (deg) to the landing direction, measured over {@link ENTRY_WINDOW_NM} of
 *  the connector rather than its first vertex — on a densely surveyed fillet the first step is
 *  almost parallel to the runway and says nothing about the turn. */
function entryAngleDeg(geom: readonly Point[], ux: number, uy: number): number | null {
  const from = geom[0]
  if (!from) return null
  const { at } = walk(geom, 0, 1, ENTRY_WINDOW_NM)
  const dx = at[0] - from[0]
  const dy = at[1] - from[1]
  const len = Math.hypot(dx, dy)
  if (len < 1e-9) return null
  const cosA = ux * (dx / len) + uy * (dy / len)
  return (Math.acos(Math.max(-1, Math.min(1, cosA))) * 180) / Math.PI
}

/** How far (nm ≈ 240 ft) from the runway centerline the turnoff must actually take the aircraft
 *  before it counts as an exit. Some contracted edges end at a fillet node barely a hundred feet
 *  off the centerline — reaching that is not "clear of the runway", and treating it as such both
 *  releases the runway too early and makes a stub look like the cheapest turnoff on the field. */
const VACATE_CLEARANCE_NM = 0.04
/** Ignore turnoffs within this distance (nm) of either threshold — they are runway entrances,
 *  not landing exits, and nothing can slow down enough to use one that early anyway. */
const END_MARGIN_NM = 0.03

const dot = (ax: number, ay: number, bx: number, by: number): number => ax * bx + ay * by
const cross = (ax: number, ay: number, bx: number, by: number): number => ax * by - ay * bx

/**
 * Trim or extend a turnoff's polyline so it ends exactly where the aircraft becomes clear of
 * the runway.
 *
 * Neither end of the raw geometry is the right place to stop. A contracted edge often ends at a
 * fillet junction only a hundred feet off the centerline — reaching that is not "clear" — while
 * a long connector runs well past the point where it is. So: cut at the first surveyed point
 * beyond the clearance line, or, if the whole run stays inside it, carry on along the last
 * segment's heading until it crosses. Returns null when the connector never gets clear at all
 * (it turns parallel to the runway first), which is not a usable landing exit.
 */
function toClearance(
  geom: readonly Point[],
  threshold: Point,
  ux: number,
  uy: number,
  clearance: number,
): Point[] | null {
  const off = (p: Point): number => Math.abs(cross(ux, uy, p[0] - threshold[0], p[1] - threshold[1]))
  for (let i = 1; i < geom.length; i += 1) {
    const p = geom[i]
    if (p && off(p) >= clearance) return geom.slice(0, i + 1) as Point[]
  }
  const last = geom[geom.length - 1]
  const prev = geom[geom.length - 2]
  if (!last || !prev) return null
  const dx = last[0] - prev[0]
  const dy = last[1] - prev[1]
  const len = Math.hypot(dx, dy)
  if (len < 1e-9) return null
  // Clearance gained per nm travelled along the current heading.
  const rate = Math.abs(cross(ux, uy, dx / len, dy / len))
  if (rate < 1e-3) return null
  const need = (clearance - off(last)) / rate
  return [...geom, [last[0] + (dx / len) * need, last[1] + (dy / len) * need]] as Point[]
}

/**
 * Derive the turnoffs usable by an aircraft landing from `threshold` toward `farEnd`.
 *
 * Everything comes from geometry already in the surface data: a connector meets the runway
 * with several legs (an acute lead-in, a perpendicular, and the mirrored acute lead-in for the
 * opposite landing direction), so the leg that makes the shallowest angle *with the direction of
 * landing* is the one an arrival would actually use, and its angle says whether the turnoff is
 * rapid or standard. No new chart data is needed — but the result should still be eyeballed
 * against the airport diagram (docs/SAN/) before it is trusted.
 *
 * SINGLE-RUNWAY ASSUMPTION: `guard` covers every runway on the field, so with a second runway a
 * taxiway bridging the two would look like a turnoff whose `vacatePoint` sits on the *other*
 * runway's pavement — and the aircraft would be reported clear while sitting on it. KSAN is
 * single-runway (9/27); scope the guard to the landing runway before modelling a second one.
 * Likewise `best` dedupes by designator, which assumes a ref touches the runway in one place.
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

    // Orient the polyline so it leaves the runway, then measure the turn over a fixed distance.
    const geom: Point[] = aOn ? [...edge.geom] : [...edge.geom].reverse()
    const from = geom[0]
    if (!from) continue
    const angleDeg = entryAngleDeg(geom, ux, uy)
    if (angleDeg === null || angleDeg > EXIT_MAX_DEG) continue
    const turnPoint = walk(geom, 0, 1, ENTRY_WINDOW_NM).at
    const dx = turnPoint[0] - from[0]
    const dy = turnPoint[1] - from[1]

    const distanceNm = dot(from[0] - threshold[0], from[1] - threshold[1], ux, uy)
    if (distanceNm < END_MARGIN_NM || distanceNm > runLen - END_MARGIN_NM) continue

    // End the turnoff where the aircraft is genuinely clear of *this* runway's centerline —
    // which keeps the check correct on a field with more than one runway, even though `guard`
    // covers them all.
    const roll = toClearance(geom, threshold, ux, uy, VACATE_CLEARANCE_NM)
    if (!roll) continue
    const vacatePoint = roll[roll.length - 1] as Point

    // `speedKt` is the speed *crossing the runway edge* — how fast the aircraft can turn off —
    // inferred from the entry angle, because the fillet there is usually not surveyed. It is
    // deliberately NOT the minimum anywhere on the connector: an aircraft leaves the runway at
    // this speed and then slows through the curve beyond it, which is the whole point of a
    // rapid exit. The rest of the connector constrains the rollout through turnSpeedLimits().
    const entryKt = turnSpeedFor(FILLET_NM / Math.tan(Math.max(1e-3, (angleDeg * Math.PI) / 180) / 2))
    const speedKt = Math.max(MIN_EXIT_KT, Math.min(MAX_EXIT_KT, entryKt))
    const candidate: RunwayExit = {
      ref: edge.ref,
      point: from,
      geom: roll,
      vacatePoint,
      angleDeg,
      kind: speedKt >= RAPID_MIN_KT ? 'rapid' : 'standard',
      turn: cross(ux, uy, dx, dy) > 0 ? 'left' : 'right',
      distanceNm,
      lengthNm: roll.reduce(
        (sum, q, k) => (k === 0 ? 0 : sum + Math.hypot(q[0] - roll[k - 1]![0], q[1] - roll[k - 1]![1])),
        0,
      ),
      speedKt,
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

/**
 * Runway occupancy (s) for a turnoff: the roll down the runway slowing from `fromKt` to the
 * turnoff's speed, plus the time to travel the turnoff itself and actually be clear.
 *
 * Including that second term is what makes a rapid exit win for the right reason. Judged only
 * on reaching the turnoff, a nearer slow one always looks better; judged on being *clear*, the
 * one you can take at 39 kt beats the one you have to crawl off at 18.
 */
export function rolloutSeconds(fromKt: number, exit: RunwayExit, rate: number): number {
  const braking = Math.max(0, (fromKt - exit.speedKt) / rate)
  const brakeDist = Math.max(0, (fromKt * fromKt - exit.speedKt * exit.speedKt) / (7200 * rate))
  const coast = Math.max(0, exit.distanceNm - brakeDist)
  const clearing = exit.lengthNm / exit.speedKt
  return braking + (coast / exit.speedKt) * 3600 + clearing * 3600
}

/** Two turnoffs within this many seconds of each other are operationally equivalent, so the
 *  choice between them is broken on how fast they can be taken rather than on the arithmetic:
 *  a high-speed exit means less braking, a smoother turn, and more margin if the aircraft
 *  floats. Without this the model will send a jet to a 70° turnoff over a 23° one to save a
 *  second and a half, which no one would actually do. */
const ROT_TIE_SEC = 5

/**
 * The turnoff an arrival would plan for: of the exits it can still make without exceeding
 * {@link MAX_BRAKE_KT_S}, the one that gets it off the runway soonest — and among those that
 * are effectively tied, the one it can take fastest. That naturally prefers a rapid exit over
 * rolling to a distant right-angle one, which is exactly why RETs exist.
 */
export function chooseExit(
  exits: readonly RunwayExit[],
  fromKt: number,
  atDistanceNm: number,
): RunwayExit | null {
  const scored: { exit: RunwayExit; sec: number }[] = []
  for (const e of exits) {
    const remaining = e.distanceNm - atDistanceNm
    if (remaining <= 0) continue // already behind us
    const required = brakeRateFor(fromKt, e.speedKt, remaining)
    if (required > MAX_BRAKE_KT_S) continue // can't slow down enough to make this one
    const rate = Math.max(required, MIN_BRAKE_KT_S)
    scored.push({ exit: e, sec: rolloutSeconds(fromKt, { ...e, distanceNm: remaining }, rate) })
  }
  if (scored.length === 0) return null
  const fastest = Math.min(...scored.map((s) => s.sec))
  const tied = scored.filter((s) => s.sec <= fastest + ROT_TIE_SEC)
  // Deterministic ordering: fastest turn, then earliest on the runway, then by designator.
  tied.sort(
    (p, q) =>
      q.exit.speedKt - p.exit.speedKt ||
      p.exit.distanceNm - q.exit.distanceNm ||
      (p.exit.ref < q.exit.ref ? -1 : 1),
  )
  return tied[0]?.exit ?? null
}

// ─── Rollout speed profile ───────────────────────────────────────────────────
/** Cumulative distance (nm) from `pos` to each subsequent vertex of `path`. */
function distancesFrom(pos: Point, path: readonly Point[], leg: number): number[] {
  const out: number[] = []
  let d = 0
  let px = pos[0]
  let py = pos[1]
  for (let i = leg + 1; i < path.length; i += 1) {
    const q = path[i]
    if (!q) break
    d += Math.hypot(q[0] - px, q[1] - py)
    px = q[0]
    py = q[1]
    out.push(d)
  }
  return out
}

/**
 * The deceleration (kt/s) needed to respect *every* speed limit still ahead — not just the one
 * at the turnoff. A connector that kinks halfway along constrains the roll earlier than its
 * entrance does, and this is what finds that.
 *
 * Returns 0 when nothing ahead requires slowing (a limit above the current speed is not a
 * constraint — a turn rated for 40 kt is perfectly happy to be taken at 15).
 */
export function requiredBrakeRate(
  fromKt: number,
  pos: Point,
  path: readonly Point[],
  limits: readonly number[],
  leg = 0,
): number {
  const dists = distancesFrom(pos, path, leg)
  let worst = 0
  for (let k = 0; k < dists.length; k += 1) {
    const limit = limits[leg + 1 + k]
    const d = dists[k]
    if (limit === undefined || d === undefined || !Number.isFinite(limit)) continue
    if (limit >= fromKt) continue // already slow enough for this corner
    const need = brakeRateFor(fromKt, limit, d)
    if (need > worst) worst = need
  }
  return worst
}

/**
 * Would the aircraft still arrive at some limit ahead too fast to take it, even braking as hard
 * as it can? Phrased as a speed comparison rather than a required-rate one on purpose: the rate
 * form divides by the remaining distance, so a hair of residual overspeed a few feet from a
 * corner blows up to an infinite "required" deceleration and the aircraft declines a turnoff it
 * was in fact making perfectly well. `tolerance` absorbs that last-few-feet settling.
 */
export function cannotMake(
  fromKt: number,
  pos: Point,
  path: readonly Point[],
  limits: readonly number[],
  leg: number,
  maxBrake: number,
  tolerance = 0.1,
): boolean {
  const dists = distancesFrom(pos, path, leg)
  for (let k = 0; k < dists.length; k += 1) {
    const limit = limits[leg + 1 + k]
    const d = dists[k]
    // A limit of zero is the stop at the end of the roll. Coming to a stop is always
    // achievable — worst case it overruns a little — whereas taking a *turn* too fast is the
    // dangerous thing this guards, so a pending stop must never trigger a decline.
    if (limit === undefined || d === undefined || !Number.isFinite(limit) || limit <= 0) continue
    const arrival = Math.sqrt(Math.max(0, fromKt * fromKt - 7200 * maxBrake * d))
    if (arrival > limit * (1 + tolerance)) return true
  }
  return false
}

/**
 * Highest speed (kt) permissible right now so that, braking at `rate`, every limit still ahead
 * is met when it is reached. This is what actually drives the aircraft down the rollout: it
 * arrives at each corner at that corner's speed instead of braking blindly and then wrenching
 * around it.
 */
export function profileCap(
  pos: Point,
  path: readonly Point[],
  limits: readonly number[],
  leg: number,
  rate: number,
): number {
  const dists = distancesFrom(pos, path, leg)
  let cap = Infinity
  for (let k = 0; k < dists.length; k += 1) {
    const limit = limits[leg + 1 + k]
    const d = dists[k]
    if (limit === undefined || d === undefined || !Number.isFinite(limit)) continue
    const allowed = Math.sqrt(limit * limit + 7200 * rate * d)
    if (allowed < cap) cap = allowed
  }
  return cap
}

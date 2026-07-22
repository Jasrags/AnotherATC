/**
 * Converging-traffic prediction.
 *
 * The proximity call answers "are these two too close", which is a report rather than a
 * warning: by the time two aircraft are ninety feet apart the decision that mattered was made
 * some time ago. This answers "are these two going to be too close, and how soon" — the same
 * developing → happening ladder the runway incursions already have, for the taxiways.
 *
 * The prediction runs on the aircraft's *actual remaining route*, not on a straight line out of
 * its nose. The sim knows exactly where each aircraft has been cleared to, and a taxiway network
 * is nothing but corners: a straight-line projection would invent conflicts at every bend and
 * miss the ones that happen around them.
 *
 * What it deliberately does not report:
 *
 * - **Traffic ahead on your own track, going your way.** That is a queue, and following
 *   separation already caps the aircraft behind. Reporting it would mean reporting every taxi
 *   queue on the field, which is most of a busy field.
 * - **A pair the junction reservation has already resolved.** The lower-priority aircraft is
 *   being stopped short of the contested edge as we speak; saying so as well would fire at
 *   every junction meeting and teach the controller to ignore the one that matters.
 *
 * Both exclusions are about *predicting*. An aircraft that has actually closed to nose-to-nose
 * is always reported, whatever it was doing on the way there — that is the separation floor
 * having failed, which is exactly when nobody should be filtering anything.
 *
 * Pure and total over its input, so it is deterministic and testable without a sim.
 */
import type { Point } from '../world/types'
import { HOTSPOT_CONFLICT_FACTOR } from './hotspot'

export type ConflictSeverity = 'advisory' | 'alert'

export interface TrafficConflict {
  /** The pair, by id, in a stable order that does not depend on fleet order. */
  aircraftIds: [string, string]
  severity: ConflictSeverity
  /** Seconds until they are predicted within {@link CONFLICT_NM}; 0 when they already are. */
  secondsToConflict: number
  /** The charted hot spot this happens in, or null. */
  hotspot: string | null
  /**
   * Controller-facing one-liner, e.g. "AAL12 and DAL8 converging at HS1".
   *
   * Deliberately free of anything that ticks — same discipline as `RunwayIncursion.message`.
   * The countdown is in {@link secondsToConflict} for a consumer to *display*; a sentence that
   * changes every second is one an assistive technology announces every second.
   */
  message: string
}

/** The per-aircraft facts prediction needs. */
export interface ConflictView {
  id: string
  callsign: string
  /** Where it is now. */
  at: Point
  /** Its remaining route from `at` onward, `at` first. A stationary aircraft may be a single
   *  point: it then simply stays where it is, which is the honest prediction for one that has
   *  nothing to run. */
  path: readonly Point[]
  /** Direction of travel, degrees true. Used only to tell a queue from a convergence. */
  headingDeg: number
  /** Current groundspeed (kt) — what it is doing, not what it was cleared to do. An aircraft
   *  held by traffic is predicted to stay held; that is what makes the hold visible as the
   *  resolution it is, rather than as a conflict that never happens. */
  speedKt: number
  /** The charted hot spot it is inside, or null. */
  hotspot: string | null
  /** The aircraft this one is already being held for — a junction reservation's contender, or
   *  a give-way target. Named rather than a bare flag: a hold resolves the pair it is *for*,
   *  and says nothing about the third aircraft this one may also be closing on. */
  yieldingTo: readonly string[]
}

/** Two aircraft closer than this (nm ≈ 90 ft) are in conflict. The proximity call and the
 *  prediction share it: they are the same event, seen at different times. */
export const CONFLICT_NM = 0.015

/** The conflict distance for a pair, widened inside a shared hot spot exactly as the plain
 *  proximity call has always widened it — the charted warning is about distance as well as
 *  about time, and this is the one place both now live. */
function limitFor(hotspot: string | null): number {
  return hotspot === null ? CONFLICT_NM : CONFLICT_NM * HOTSPOT_CONFLICT_FACTOR
}
/** How far ahead (s) to look. Long enough to be a warning at taxi speed, short enough that it
 *  is still about the situation in front of you: at 15 kt this is about 500 ft of closure. */
export const CONVERGE_HORIZON_SEC = 20
/** Inside a charted hot spot, look this much further ahead — the field's own diagram says to
 *  watch harder there, and watching harder is all the sim can do with that. */
export const HOTSPOT_HORIZON_FACTOR = 2
/** Coarsest projection sample (s). At taxi speed one second is ~25 ft, comfortably finer than
 *  the conflict distance — but a landing rollout is in this list too, and at 140 kt a second is
 *  236 ft, several times the distance being looked for. {@link sampleStepFor} shortens the step
 *  by closing speed so a fast pair can never step clean over the moment they meet. */
const SAMPLE_SEC = 1
/** Floor on that step (s), so a hypothetical very fast pair cannot ask for unbounded work. */
const MIN_SAMPLE_SEC = 0.05

/** Sample step (s) for a pair: short enough that they close at most half the conflict distance
 *  between two samples, so the window can never fall entirely between them. Straight-line
 *  closure bounds the real closure — a curved route covers less ground, never more. */
function sampleStepFor(closingKt: number, limitNm: number): number {
  if (closingKt <= 0) return SAMPLE_SEC
  const step = (limitNm / 2) * (3600 / closingKt)
  return Math.max(MIN_SAMPLE_SEC, Math.min(SAMPLE_SEC, step))
}
/** Heading difference (deg) under which two aircraft count as going the same way. Matches the
 *  separation model's own idea of a leader, so a queue is a queue to both. */
const SAME_DIR_DEG = 60
/** Half-width (nm) of the corridor in which traffic counts as "directly ahead". */
const CORRIDOR_HALF_NM = 0.012

const dist = (a: Point, b: Point): number => Math.hypot(a[0] - b[0], a[1] - b[1])

const angleDelta = (a: number, b: number): number => {
  const d = Math.abs(((a - b) % 360) + 360) % 360
  return d > 180 ? 360 - d : d
}

/** Where this aircraft will be `sec` from now if it keeps doing what it is doing: `distNm`
 *  along its remaining route, stopping at the end of it. */
function positionAfter(path: readonly Point[], distNm: number): Point {
  let remaining = distNm
  for (let i = 1; i < path.length; i += 1) {
    const from = path[i - 1] as Point
    const to = path[i] as Point
    const leg = dist(from, to)
    if (leg <= 0) continue
    if (remaining <= leg) {
      const f = remaining / leg
      return [from[0] + (to[0] - from[0]) * f, from[1] + (to[1] - from[1]) * f]
    }
    remaining -= leg
  }
  return (path[path.length - 1] ?? path[0]) as Point
}

/**
 * Whether `b` is a leader for `a`: directly ahead in a's corridor, and going a's way.
 *
 * Judged where the two are *now*, not across the horizon — so a pair that is a queue at this
 * instant and forks a few seconds later is skipped for this tick. That resolves itself on the
 * next one (this runs every tick, and they stop reading as a queue the moment the leader turns
 * off), so the cost is a tick or two of quiet right at a fork rather than a missed conflict.
 */
function isFollowing(a: ConflictView, b: ConflictView): boolean {
  if (angleDelta(a.headingDeg, b.headingDeg) >= SAME_DIR_DEG) return false
  const rad = (a.headingDeg * Math.PI) / 180
  const dx = b.at[0] - a.at[0]
  const dy = b.at[1] - a.at[1]
  const forward = dx * Math.sin(rad) + dy * Math.cos(rad)
  if (forward <= 0) return false
  const cross = Math.sin(rad) * dy - Math.cos(rad) * dx
  return Math.abs(cross) <= CORRIDOR_HALF_NM
}

const SEVERITY_RANK: Record<ConflictSeverity, number> = { alert: 0, advisory: 1 }

/**
 * Every converging pair in the fleet, worst first: what is happening now ahead of what is
 * developing, then soonest first, then by id so the order never depends on fleet order.
 *
 * Callers pass only surface aircraft that can be in a taxi conflict — an aircraft on final or
 * rolling for takeoff is not one, and the caller knows which those are.
 */
export function detectConverging(fleet: readonly ConflictView[]): TrafficConflict[] {
  const found: TrafficConflict[] = []

  for (let i = 0; i < fleet.length; i += 1) {
    for (let j = i + 1; j < fleet.length; j += 1) {
      const a = fleet[i] as ConflictView
      const b = fleet[j] as ConflictView
      const [first, second] = a.id < b.id ? [a, b] : [b, a]
      const hotspot = a.hotspot !== null && a.hotspot === b.hotspot ? a.hotspot : null
      const limit = limitFor(hotspot)

      // Happening now. Reported before any exclusion applies: whatever the pair was doing on
      // the way here, they are on top of each other, and that is not the moment to be quiet.
      if (dist(a.at, b.at) < limit) {
        found.push(conflict(first, second, 'alert', 0, hotspot))
        continue
      }
      if (a.yieldingTo.includes(b.id) || b.yieldingTo.includes(a.id)) continue
      if (isFollowing(a, b) || isFollowing(b, a)) continue
      if (a.speedKt <= 0 && b.speedKt <= 0) continue // neither is going anywhere

      const horizon = hotspot === null ? CONVERGE_HORIZON_SEC : CONVERGE_HORIZON_SEC * HOTSPOT_HORIZON_FACTOR
      // Cheap reject: not even both running flat at each other closes this gap in time.
      if (dist(a.at, b.at) - (a.speedKt + b.speedKt) * (horizon / 3600) > limit) continue

      const step = sampleStepFor(a.speedKt + b.speedKt, limit)
      for (let t = step; t <= horizon; t += step) {
        const pa = positionAfter(a.path, (a.speedKt * t) / 3600)
        const pb = positionAfter(b.path, (b.speedKt * t) / 3600)
        if (dist(pa, pb) < limit) {
          found.push(conflict(first, second, 'advisory', t, hotspot))
          break
        }
      }
    }
  }

  found.sort(
    (p, q) =>
      SEVERITY_RANK[p.severity] - SEVERITY_RANK[q.severity] ||
      p.secondsToConflict - q.secondsToConflict ||
      (p.aircraftIds[0] < q.aircraftIds[0] ? -1 : p.aircraftIds[0] > q.aircraftIds[0] ? 1 : 0),
  )
  return found
}

function conflict(
  first: ConflictView,
  second: ConflictView,
  severity: ConflictSeverity,
  secondsToConflict: number,
  hotspot: string | null,
): TrafficConflict {
  const where = hotspot === null ? '' : ` at ${hotspot}`
  return {
    aircraftIds: [first.id, second.id],
    severity,
    secondsToConflict,
    hotspot,
    message: `${first.callsign} and ${second.callsign} converging${where}`,
  }
}

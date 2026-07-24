import type { Point } from '../world/types'

/** Feet in a nautical mile. */
export const FT_PER_NM = 6076.12

/** Length (nm) of the straight-in final arrivals are established on. */
export const FINAL_APPROACH_NM = 4

/**
 * Inside this distance (nm) from the threshold, an arrival on final owns the runway: nothing
 * may be cleared onto the surface underneath it (7110.65 "anticipated separation" has limits).
 *
 * It lives here, in the module neither the sim nor incursion detection can do without, because
 * both need it and neither may import the other. It is the band the clearance gates refuse on
 * *and* the band an occupied-runway advisory escalates to an alert at — the same line drawn
 * twice, which is exactly the kind of pair that drifts apart when it is written down twice.
 */
export const SHORT_FINAL_NM = 1.5

/**
 * The runway direction currently in use — the airport's *configuration*.
 *
 * A single-runway field has one of these active at a time and **both arrivals and departures use
 * it**. Landing one way while departing the other is not a thing you can do; it was possible in
 * this sim for a while and it was simply a bug.
 *
 * The three points are deliberately distinct, because a displaced threshold makes them so:
 *
 * ```
 *  departureStart                 threshold                                    farEnd
 *   |                                |                                            |
 *   ├────── displaced (unusable ─────┤                                            │
 *   │        for landing)            │                                            │
 *   ├───────────────────── TORA: takeoff run available ──────────────────────────►│
 *                                    ├──────── LDA: landing distance ────────────►│
 * ```
 *
 * A departure may use the pavement before the threshold for its takeoff run; an arrival may use
 * it for rollout, but may not touch down on it. See docs/SAN/runway-9-27.md — at KSAN the
 * displacement is 1,000 ft on 09 and 1,810 ft on 27, which is not a rounding error.
 */
export interface ActiveRunway {
  /** Designator in use, e.g. "27". */
  ident: string
  /** Landing threshold. Arrivals touch down here, and exit distances are measured from it. */
  threshold: Point
  /** Physical end of pavement behind the threshold — where a takeoff roll may begin. */
  departureStart: Point
  /** The opposite end of the pavement: where a takeoff lifts off and a landing rolls toward. */
  farEnd: Point
  /** Takeoff run available (ft), as *declared* — not as measured between the points above.
   *  The two do not always agree: KSAN's RWY 09 declares 8,280 ft against 9,401 ft of pavement,
   *  so over a thousand feet at the far end is not usable in that direction even though it is
   *  physically there. Geometry drives motion; declared distances drive the rules. */
  toraFt: number
  /** Landing distance available (ft), declared. Likewise not simply threshold→farEnd: on 09 the
   *  LDA ends ~1,100 ft before the pavement does. */
  ldaFt: number
  /** Glide path angle (deg) for the approach to this end — 3.3° to KSAN 09, 3.5° to 27. */
  glidePathDeg: number
  /** Traffic pattern side, for departures turning out. */
  pattern: 'left' | 'right'
}

/**
 * Why one runway's traffic is being weighed against another's — the reason a field couples two
 * runways (docs/atc-multi-runway.md §6). A field can couple a pair for one reason and not another:
 * close parallels are `wake`- and `landing`-dependent (staggered approaches) but not
 * `occupancy`-coupled, while a crossing is `occupancy`-coupled.
 */
export type RunwayInteractionKind = 'occupancy' | 'landing' | 'wake'

/**
 * Whether traffic committed to runway `other` is relevant to a clearance protecting runway `mine`,
 * for the given reason. This is the seam a multi-runway field plugs its inter-runway rules into;
 * the engine owns the *shape* (this signature, and the gates that consult it), the field owns the
 * *which-runways-and-how*. The default is independent — every runway minds only its own traffic.
 */
export type RunwaysInteract = (mine: string, other: string, kind: RunwayInteractionKind) => boolean

/**
 * Where two physical runways physically cross (an intersecting field like KBUR). The boolean
 * {@link RunwaysInteract} seam says two runways are occupancy-coupled at all; this adds *where*, so
 * the sim can refine that coupling by position — a departure or rollout on one runway stops holding
 * the other once it is past the intersection, rather than for its whole roll (docs/atc-multi-runway.md).
 * It is field geometry (the intersection of the field's own runways), so it rides the airport bundle.
 */
export interface RunwayCrossing {
  /** The two physical runway ids that cross, e.g. `['08/26', '15/33']`. Symmetric. */
  runways: readonly [string, string]
  /** Where their centrelines intersect, in the field's local nm frame. */
  point: Point
}

/**
 * The designator of the opposite direction: 09 ↔ 27. Runway numbers are the magnetic heading in
 * tens, so the reciprocal is 18 away, wrapping at 36.
 */
export function reciprocalIdent(ident: string): string {
  const n = Number.parseInt(ident.replace(/\D/g, ''), 10)
  if (!Number.isFinite(n)) return ident
  const other = ((n + 17) % 36) + 1
  const suffix = ident.replace(/[\d]/g, '')
  return `${String(other).padStart(2, '0')}${suffix}`
}

/** Landing distance available (nm), from the declared figure. */
export function landingDistanceNm(r: ActiveRunway): number {
  return r.ldaFt / FT_PER_NM
}

/** Takeoff run available (nm), from the declared figure. */
export function takeoffRunNm(r: ActiveRunway): number {
  return r.toraFt / FT_PER_NM
}

/** Unit vector along the runway in the direction of use. */
function heading(r: ActiveRunway): [number, number] {
  const dx = r.farEnd[0] - r.departureStart[0]
  const dy = r.farEnd[1] - r.departureStart[1]
  const len = Math.hypot(dx, dy) || 1
  return [dx / len, dy / len]
}

/** Where the takeoff run runs out — `toraFt` from the departure end, which is *not* always the
 *  end of the pavement (KSAN 09 declares 8,280 ft of a 9,401 ft runway). */
export function takeoffEnd(r: ActiveRunway): Point {
  const [ux, uy] = heading(r)
  const tora = takeoffRunNm(r)
  return [r.departureStart[0] + ux * tora, r.departureStart[1] + uy * tora]
}

/** Where the landing distance runs out — `ldaFt` from the threshold. Turnoffs beyond this are
 *  past the declared landing distance even though the pavement continues. */
export function landingEnd(r: ActiveRunway): Point {
  const [ux, uy] = heading(r)
  const lda = landingDistanceNm(r)
  return [r.threshold[0] + ux * lda, r.threshold[1] + uy * lda]
}

/** Distance (nm) of pavement actually between the threshold and the far end. Exceeds the LDA
 *  where the declared distance stops short of the physical end. */
export function pavementAfterThresholdNm(r: ActiveRunway): number {
  return Math.hypot(r.farEnd[0] - r.threshold[0], r.farEnd[1] - r.threshold[1])
}

/**
 * The final approach fix: `distanceNm` out from the threshold on the runway centerline extended,
 * on the approach side. Straight-in only — TRACON owns anything more interesting.
 */
export function finalFix(r: ActiveRunway, distanceNm: number): Point {
  const dx = r.threshold[0] - r.farEnd[0]
  const dy = r.threshold[1] - r.farEnd[1]
  const len = Math.hypot(dx, dy) || 1
  return [r.threshold[0] + (dx / len) * distanceNm, r.threshold[1] + (dy / len) * distanceNm]
}

/** Height (ft) on the glide path `distanceNm` from the threshold. */
export function glideAltitudeFt(glidePathDeg: number, distanceNm: number): number {
  return distanceNm * FT_PER_NM * Math.tan((glidePathDeg * Math.PI) / 180)
}

/**
 * The physical markings at one end of the runway, for rendering and for rules about which
 * pavement is usable. Keyed by the designator painted at that end.
 */
export interface RunwayEndLayout {
  /** Designator painted here, e.g. "27". */
  ident: string
  /** Physical end of the pavement. */
  pavementEnd: Point
  /** Landing threshold — equal to `pavementEnd` when nothing is displaced. */
  threshold: Point
  /**
   * Engineered Materials Arresting System beyond this end of the pavement, or null. A bed of
   * crushable concrete that decelerates an aircraft that has overrun. Passive: no ATC action,
   * and nothing may ever be taxied onto it.
   */
  emas: { lengthFt: number; widthFt: number } | null
}

/** Both ends of a runway, as painted. */
export interface RunwayLayout {
  /** Runway designation, e.g. "09/27". */
  ident: string
  widthFt: number
  ends: readonly [RunwayEndLayout, RunwayEndLayout]
}

/** Displacement (nm) of an end's threshold from its pavement end; 0 when not displaced. */
export function displacedNm(end: RunwayEndLayout): number {
  return Math.hypot(end.threshold[0] - end.pavementEnd[0], end.threshold[1] - end.pavementEnd[1])
}

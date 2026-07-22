/**
 * Runway incursion detection.
 *
 * The sim already *refuses* the clearances that would put two aircraft on one runway, so the
 * situations this finds are the ones no single clearance is wrong for: a crossing issued while
 * the inbound was still four miles out and still on the pavement when it isn't; an aircraft
 * placed on the runway by the dev sandbox; a rollout that has not cleared before the next
 * movement starts. Detection is separate from prevention on purpose — the controller is meant
 * to see the developing conflict and act, not be told afterwards it was impossible.
 *
 * Pure and total over its input, so it is deterministic and testable without a sim.
 */
import { SHORT_FINAL_NM } from './runway'

/** How an aircraft on the runway surface came to be there. */
export type RunwayUse =
  /** Rolling for takeoff, or taxiing into position under a takeoff clearance. */
  | 'takeoff'
  /** Lined up on the centerline awaiting a takeoff clearance. */
  | 'lineUp'
  /** Decelerating after touchdown, still clearing the pavement. */
  | 'rollout'
  /** Transiting under a crossing clearance. */
  | 'crossing'
  /** On the runway holding no clearance to be there at all. */
  | 'unauthorized'

export type IncursionSeverity = 'advisory' | 'alert'

export type IncursionKind =
  /** An occupant with no clearance to be on the runway. */
  | 'unauthorized'
  /** An occupant under an arrival that is cleared to land on top of it. */
  | 'occupiedVsLanding'
  /** Two aircraft on the runway surface at once, at least one of them using it. */
  | 'sharedRunway'

export interface RunwayIncursion {
  kind: IncursionKind
  severity: IncursionSeverity
  /** The aircraft on the runway — the intruder, where one of the pair is one. */
  occupantId: string
  /** The traffic it conflicts with; null when the occupant is simply uncleared. */
  conflictId: string | null
  /** Controller-facing one-liner, e.g. "SWA12 on the runway — DAL8 landing". Deliberately
   *  free of anything that ticks: this string changes only when the *situation* changes, which
   *  is what lets a consumer announce it once instead of once per frame. */
  message: string
  /** How far out the conflicting arrival is, or null when no arrival is involved. Kept out of
   *  {@link message} because it changes continuously — display it, don't re-announce it. */
  finalNm: number | null
}

/** The per-aircraft facts incursion detection needs. */
export interface IncursionView {
  id: string
  callsign: string
  /** How it is using the runway surface, or null when it is not on it. */
  use: RunwayUse | null
  airborne: boolean
  clearedToLand: boolean
  /** Distance (nm) still to fly to the threshold; only meaningful while airborne. */
  finalNm: number
}

/** An inbound inside the short-final band over an occupied runway is an alert, not an advisory:
 *  it is past the point where the sim would let anything be cleared onto the surface, so it is
 *  also past the point where the occupant clearing normally can be assumed. Imported rather
 *  than restated so the two can never drift. */
const ALERT_FINAL_NM = SHORT_FINAL_NM
/** Beyond this distance (nm) an inbound is far enough out that the occupant is expected to
 *  clear normally, and saying so every time would train the controller to ignore the alert. */
const ADVISORY_FINAL_NM = 3

/** Uses that mean the aircraft holds a clearance for the runway itself, rather than merely
 *  permission to be across it. Two of these at once is always an alert. */
const RUNWAY_USER: readonly RunwayUse[] = ['takeoff', 'lineUp', 'rollout']

const SEVERITY_RANK: Record<IncursionSeverity, number> = { alert: 0, advisory: 1 }

/** Find every runway conflict in the fleet, most severe first. */
export function detectIncursions(fleet: readonly IncursionView[]): RunwayIncursion[] {
  const occupants = fleet.filter((a) => a.use !== null)
  if (occupants.length === 0) return []

  const found: RunwayIncursion[] = []
  const inbound = fleet.filter((a) => a.airborne && a.clearedToLand && a.finalNm <= ADVISORY_FINAL_NM)

  for (const occ of occupants) {
    if (occ.use === 'unauthorized') {
      found.push({
        kind: 'unauthorized',
        severity: 'alert',
        occupantId: occ.id,
        conflictId: null,
        message: `${occ.callsign} on the runway without a clearance`,
        finalNm: null,
      })
    }

    for (const inb of inbound) {
      if (inb.id === occ.id) continue
      found.push({
        kind: 'occupiedVsLanding',
        severity: inb.finalNm <= ALERT_FINAL_NM ? 'alert' : 'advisory',
        occupantId: occ.id,
        conflictId: inb.id,
        message: `${occ.callsign} on the runway — ${inb.callsign} landing`,
        finalNm: inb.finalNm,
      })
    }
  }

  // Ground-on-ground: every unordered pair sharing the pavement where at least one holds a
  // clearance for the runway itself. Emitted once, with the aircraft that does *not* hold one
  // named as the occupant — that is the intruder the controller has to move.
  for (let i = 0; i < occupants.length; i += 1) {
    for (let j = i + 1; j < occupants.length; j += 1) {
      const a = occupants[i]!
      const b = occupants[j]!
      const aUser = RUNWAY_USER.includes(a.use!)
      const bUser = RUNWAY_USER.includes(b.use!)
      // Neither holds a clearance for the runway itself. Two crossings at different points is
      // genuinely not a conflict; a pair involving an *unauthorized* occupant is, but it is
      // already reported — every uncleared occupant raises its own alert naming itself, which
      // is the aircraft to move. Pairing them as well would say the same thing a second time,
      // and the HUD shows one sentence and a count.
      if (!aUser && !bUser) continue
      const [occ, other] = aUser === bUser ? (a.id < b.id ? [a, b] : [b, a]) : aUser ? [b, a] : [a, b]
      found.push({
        kind: 'sharedRunway',
        severity: 'alert',
        occupantId: occ.id,
        conflictId: other.id,
        message: `${occ.callsign} on the runway with ${other.callsign}`,
        finalNm: null,
      })
    }
  }

  // Deterministic order: worst first, then a stable key. Never position in `fleet`, which is
  // spawn order and would reshuffle the HUD as unrelated traffic comes and goes.
  return found.sort(
    (x, y) =>
      SEVERITY_RANK[x.severity] - SEVERITY_RANK[y.severity] ||
      x.occupantId.localeCompare(y.occupantId) ||
      x.kind.localeCompare(y.kind) ||
      (x.conflictId ?? '').localeCompare(y.conflictId ?? ''),
  )
}

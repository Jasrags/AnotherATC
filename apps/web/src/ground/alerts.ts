import type { IncursionSeverity, RunwayIncursion } from '@anotheratc/sim'

export interface IncursionAlert {
  /** Severity glyph, rendered decoratively (aria-hidden) so it is not read out as "no entry
   *  sign" in front of every announcement. */
  mark: string
  /** What the controller reads, and — because the banner is a button — its accessible name.
   *  Carries the live range, so it changes constantly; that is fine for a name read on demand
   *  when the control is focused, and is what keeps the visible label and the name the same
   *  string (WCAG 2.5.3). It is *not* what gets announced; see below. */
  text: string
  /** What a screen reader is told. Deliberately excludes the range: `role="alert"` interrupts
   *  whatever is being announced, and a sentence that re-renders every time the arrival closes
   *  another tenth of a mile would interrupt on a loop for the whole approach — turning the one
   *  alert that must not be tuned out into the one that certainly will be. */
  announcement: string
  /** Severity of the leading incursion, or null when there is none. */
  severity: IncursionSeverity | null
  /** The aircraft to act on — the intruder of the leading incursion, or null when there is
   *  none. Naming an aircraft and not taking you to it is half an alert. */
  focusId: string | null
}

const EMPTY: IncursionAlert = { mark: '', text: '', announcement: '', severity: null, focusId: null }

/**
 * The runway-incursion HUD line.
 *
 * One sentence, not a list: an incursion is read under time pressure, and three stacked
 * messages take longer to parse than the situation gives you. The sim already sorts worst
 * first, so the head of the list is the one to act on and the rest is a count.
 */
export function incursionAlert(incursions: readonly RunwayIncursion[]): IncursionAlert {
  const worst = incursions[0]
  if (!worst) return EMPTY
  const rest = incursions.length > 1 ? ` · +${incursions.length - 1} more` : ''
  const range = worst.finalNm === null ? '' : `, ${worst.finalNm.toFixed(1)} nm final`
  const isAlert = worst.severity === 'alert'
  return {
    mark: isAlert ? '⛔' : '⚠',
    text: `RUNWAY — ${worst.message}${range}${rest}`,
    announcement: `Runway ${isAlert ? 'alert' : 'advisory'}. ${worst.message}${rest}`,
    severity: worst.severity,
    focusId: worst.occupantId,
  }
}

/**
 * How long (s) an aircraft may sit with nothing to do before the scope says so.
 *
 * Long enough that it is not nagging you about an aircraft you are already turning to, short
 * enough to catch one that has genuinely dropped off your scan. An arrival that has checked in
 * holds its turnoff for the whole of this, so the number is a capacity decision as much as an
 * attention one.
 */
export const AWAITING_ADVISORY_SEC = 30

/** The two things this line needs from an aircraft. Structurally a subset of `StripItem`, so
 *  the caller passes strips straight in without building anything. */
export interface AwaitingItem {
  callsign: string
  awaitingSec: number
}

/** How many are named before the rest become a count. */
const AWAITING_NAMED = 3

/** m:ss — a wait is read as a duration, and "2:10" is a duration in a way "130s" is not.
 *  Exported so the strip's clock and this line are the same clock. */
export function awaitingClock(sec: number): string {
  return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`
}

/**
 * The "waiting on you" HUD line: who has been left with no clearance to run, longest first.
 *
 * Quieter than a conflict and quieter than a gate warning, because nothing is wrong yet — an
 * ignored aircraft is a mistake in the making rather than one that has happened. It says the
 * instruction it is missing ("awaiting taxi") only once: the repeat for each further aircraft
 * would treble the length of a line whose whole job is to be read in a glance.
 */
export function awaitingAlert(aircraft: readonly AwaitingItem[]): string {
  const waiting = aircraft
    .filter((a) => a.awaitingSec >= AWAITING_ADVISORY_SEC)
    .sort((p, q) => q.awaitingSec - p.awaitingSec || (p.callsign < q.callsign ? -1 : 1))
  if (waiting.length === 0) return ''
  const named = waiting.slice(0, AWAITING_NAMED)
  const head = `${named[0]!.callsign} AWAITING TAXI ${awaitingClock(named[0]!.awaitingSec)}`
  const rest = named.slice(1).map((a) => `${a.callsign} ${awaitingClock(a.awaitingSec)}`)
  const more = waiting.length > named.length ? [`+${waiting.length - named.length} more`] : []
  return `⧗ ${[head, ...rest, ...more].join(' · ')}`
}

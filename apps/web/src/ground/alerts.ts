import type {
  ConflictSeverity,
  ControllerPosition,
  IncursionSeverity,
  RunwayIncursion,
  TrafficConflict,
} from '@anotheratc/sim'

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
  /** Which position owes it something — and therefore *what* it is owed. */
  controlledBy: ControllerPosition
}

/** What this aircraft is waiting to be told. Tower's job with a landed arrival that has stopped
 *  clear of the runway is the frequency change; everything else is waiting to be taxied. */
export function awaitingLabel(item: AwaitingItem): string {
  return item.controlledBy === 'tower' ? 'AWAITING HANDOFF' : 'AWAITING TAXI'
}

export interface AwaitingAlert {
  /** What the controller reads. Carries the running clocks, so it changes every second. */
  text: string
  /**
   * What a screen reader is told — the same news without the clocks.
   *
   * Same reasoning as {@link IncursionAlert.announcement}, and the same trap: a live region is
   * re-announced whenever its text changes, so announcing the visible line would speak once a
   * second for as long as anyone was waiting. This changes only when *who* is waiting does,
   * which is the part that is news. Empty when there is nothing to say.
   */
  announcement: string
}

const NOTHING: AwaitingAlert = { text: '', announcement: '' }

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
export function awaitingAlert(aircraft: readonly AwaitingItem[]): AwaitingAlert {
  const waiting = aircraft
    .filter((a) => a.awaitingSec >= AWAITING_ADVISORY_SEC)
    .sort((p, q) => q.awaitingSec - p.awaitingSec || (p.callsign < q.callsign ? -1 : 1))
  const lead = waiting[0]
  if (!lead) return NOTHING
  const named = waiting.slice(0, AWAITING_NAMED)
  const head = `${lead.callsign} ${awaitingLabel(lead)} ${awaitingClock(lead.awaitingSec)}`
  const rest = named.slice(1).map((a) => `${a.callsign} ${awaitingClock(a.awaitingSec)}`)
  const more = waiting.length > named.length ? [`+${waiting.length - named.length} more`] : []
  const others = waiting.length - 1
  return {
    text: `⧗ ${[head, ...rest, ...more].join(' · ')}`,
    // Named, not counted, for the one you should answer first — and a plain count for the rest,
    // because a list of callsigns read aloud is not something anyone acts on.
    announcement: `${lead.callsign} ${awaitingLabel(lead).toLowerCase()}${others > 0 ? `, and ${others} other aircraft waiting` : ''}.`,
  }
}

export interface ConflictAlert {
  /** What the controller reads. Carries the countdown, so it changes every second. */
  text: string
  /** What a screen reader is told — the situation without the countdown, for the same reason
   *  {@link IncursionAlert.announcement} drops the range. */
  announcement: string
  severity: ConflictSeverity | null
}

const NO_CONFLICT: ConflictAlert = { text: '', announcement: '', severity: null }

/**
 * The taxi-conflict line: one sentence and a count, worst first.
 *
 * Two voices, because the sim now distinguishes two things. CONFLICT is two aircraft too close
 * *now* — the line this has always been. CONVERGING is the new half: they are not too close
 * yet, and here is how long you have. A warning you can still act on is worth more than a
 * report you cannot, and wording them the same would waste the distinction.
 */
export function conflictAlert(conflicts: readonly TrafficConflict[]): ConflictAlert {
  const worst = conflicts[0]
  if (!worst) return NO_CONFLICT
  const rest = conflicts.length > 1 ? ` · +${conflicts.length - 1} more` : ''
  const happening = worst.severity === 'alert'
  // The countdown is display-only: it ticks, and an announcement that ticks is one nobody hears.
  const when = happening ? '' : ` in ${worst.secondsToConflict}s`
  return {
    text: `⚠ ${happening ? 'CONFLICT' : 'CONVERGING'} — ${worst.message}${when}${rest}`,
    announcement: `${happening ? 'Traffic conflict' : 'Traffic advisory'}. ${worst.message}${rest}`,
    severity: worst.severity,
  }
}

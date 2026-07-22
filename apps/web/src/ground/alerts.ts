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

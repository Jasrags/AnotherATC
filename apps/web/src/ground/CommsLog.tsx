import { memo, useEffect, useRef } from 'react'
import type { ControllerPosition, Transmission } from '@anotheratc/sim'

/** How many calls the panel renders. The sim keeps more; this is what fits a scrollback. */
const PANEL_LIMIT = 60

/** Simulated seconds as a controller would read the clock: mm:ss, counting past 60 minutes
 *  rather than wrapping (a session's elapsed time, not a wall clock). */
export function clock(seconds: number): string {
  const total = Math.floor(seconds)
  const mm = Math.floor(total / 60)
  const ss = total % 60
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
}

/** The calls made on one frequency, most recent `limit`, still oldest-first so the newest
 *  sits at the bottom where a transcript is read. */
export function visibleComms(
  comms: readonly Transmission[],
  position: ControllerPosition,
  limit: number = PANEL_LIMIT,
): Transmission[] {
  const onFrequency = comms.filter((c) => c.position === position)
  return onFrequency.slice(Math.max(0, onFrequency.length - limit))
}

/**
 * The radio transcript for the active position. Read-only: every line here was produced by the
 * sim when a clearance actually took effect, so it can never claim something the simulation
 * didn't do. Clicking a line selects that aircraft.
 */
function CommsLogPanel({
  comms,
  position,
  selectedId,
  onSelect,
}: {
  comms: readonly Transmission[]
  position: ControllerPosition
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  const listRef = useRef<HTMLOListElement>(null)
  const shown = visibleComms(comms, position)
  const latest = shown[shown.length - 1]?.seq ?? 0

  // Follow the conversation: a new call scrolls the panel to the bottom.
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [latest])

  return (
    <section className="comms" aria-label={`${position === 'tower' ? 'Tower' : 'Ground'} communications`}>
      {/* The section is already named, so the visible header is decoration — an <h2> here
          would be the only heading in the app and would start its outline at level 2. */}
      <p className="comms-title" aria-hidden="true">
        COMMS
      </p>
      {/* A live region: a transmission is an operationally meaningful event, and the transcript
          is the only place it appears. Polite, so it never cuts across what is being read. */}
      <ol className="comms-list" ref={listRef} aria-live="polite">
        {shown.length === 0 && <li className="comms-empty">frequency quiet</li>}
        {shown.map((c) => (
          <li key={c.seq} className={`comms-line comms-${c.from}`}>
            <button
              type="button"
              className={`comms-entry${c.aircraftId === selectedId ? ' comms-entry-selected' : ''}`}
              onClick={() => onSelect(c.aircraftId)}
              title={`Select ${c.callsign}`}
            >
              <span className="comms-time">{clock(c.time)}</span>
              <span className="comms-text">{c.text}</span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  )
}

/** Memoized: the strip-bay signature also changes on per-second countdowns that have nothing
 *  to do with the transcript, and this list is up to `PANEL_LIMIT` buttons. `onSelect` must be
 *  a stable reference for this to bite — pass a controller method, not an inline closure. */
export const CommsLog = memo(CommsLogPanel)

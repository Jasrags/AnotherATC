import { memo, useEffect, useRef, useState } from 'react'
import type { ControllerPosition, Transmission } from '@anotheratc/sim'

/** How many calls the panel renders. The sim keeps more; this is what fits a scrollback. */
const PANEL_LIMIT = 60

/** Which frequency the panel is showing. `all` is the default: running combined positions, the
 *  point of the transcript is hearing both — the filter is for cutting one out deliberately. */
export type CommsFilter = 'all' | ControllerPosition

/** Short label for a frequency, as it appears against each call. */
export const CHANNEL_LABEL: Record<ControllerPosition, string> = {
  ground: 'GND',
  tower: 'TWR',
}

/** Simulated seconds as a controller would read the clock: mm:ss, counting past 60 minutes
 *  rather than wrapping (a session's elapsed time, not a wall clock). */
export function clock(seconds: number): string {
  const total = Math.floor(seconds)
  const mm = Math.floor(total / 60)
  const ss = total % 60
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
}

/** The calls on the selected frequency (or all of them), most recent `limit`, still oldest-first
 *  so the newest sits at the bottom where a transcript is read. */
export function visibleComms(
  comms: readonly Transmission[],
  filter: CommsFilter,
  limit: number = PANEL_LIMIT,
): Transmission[] {
  const onFrequency = filter === 'all' ? [...comms] : comms.filter((c) => c.position === filter)
  return onFrequency.slice(Math.max(0, onFrequency.length - limit))
}

const FILTERS: { key: CommsFilter; label: string; title: string }[] = [
  { key: 'all', label: 'ALL', title: 'Every frequency' },
  { key: 'ground', label: 'GND', title: 'Ground / Clearance only' },
  { key: 'tower', label: 'TWR', title: 'Tower / Local Control only' },
]

/**
 * The radio transcript. Read-only: every line here was produced by the sim when a clearance
 * actually took effect, so it can never claim something the simulation didn't do.
 *
 * Every call is labelled with the frequency it went out on. Working combined positions, that is
 * the thing the panel has to answer — a transcript that silently mixes two frequencies, or shows
 * only the bay you happen to have selected, hides which controller was talking. The filter is
 * deliberately independent of the strip bay: reading one frequency while working the other is a
 * normal thing to want.
 *
 * Clicking a line selects that aircraft.
 */
function CommsLogPanel({
  comms,
  selectedId,
  onSelect,
}: {
  comms: readonly Transmission[]
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  const listRef = useRef<HTMLOListElement>(null)
  const [filter, setFilter] = useState<CommsFilter>('all')
  const shown = visibleComms(comms, filter)
  const latest = shown[shown.length - 1]?.seq ?? 0

  // Follow the conversation: a new call scrolls the panel to the bottom. Also runs when the
  // filter changes, so switching frequency lands on that frequency's latest call rather than
  // wherever the previous list happened to be scrolled to.
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [latest, filter])

  return (
    <section className="comms" aria-label="Communications">
      <div className="comms-head">
        <p className="comms-title" aria-hidden="true">
          COMMS
        </p>
        <div className="comms-filters" role="group" aria-label="Frequency filter">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              className={`comms-filter${filter === f.key ? ' comms-filter-on' : ''}`}
              aria-pressed={filter === f.key}
              title={f.title}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>
      {/* A live region: a transmission is an operationally meaningful event, and the transcript
          is the only place it appears. Polite, so it never cuts across what is being read. */}
      <ol className="comms-list" ref={listRef} aria-live="polite">
        {shown.length === 0 && <li className="comms-empty">frequency quiet</li>}
        {shown.map((c) => (
          <li key={c.seq} className={`comms-line comms-${c.from} comms-on-${c.position}`}>
            <button
              type="button"
              className={`comms-entry${c.aircraftId === selectedId ? ' comms-entry-selected' : ''}`}
              onClick={() => onSelect(c.aircraftId)}
              title={`Select ${c.callsign}`}
            >
              <span className="comms-chan">{CHANNEL_LABEL[c.position]}</span>
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

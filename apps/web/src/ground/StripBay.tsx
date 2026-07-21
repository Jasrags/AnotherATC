import { useRef, useSyncExternalStore } from 'react'
import type { ControllerPosition, GroundIntent, GroundStatus, Point } from '@anotheratc/sim'
import type { GroundController, RouteDraft, StripItem } from './controller'
import { StripCommandMenu } from './StripCommandMenu'
import { CommsLog } from './CommsLog'

/** Takeoff-queue sequence numbers: rank the departures awaiting takeoff (Tower-owned, holding
 *  short or lined up) in fleet order, so each strip can show its place in line. Deterministic. */
export function takeoffSequence(aircraft: StripItem[]): Map<string, number> {
  const seq = new Map<string, number>()
  let n = 0
  for (const a of aircraft) {
    if (a.controlledBy === 'tower' && a.intent === 'departure' && (a.status === 'holdShort' || a.status === 'lineUpWait')) {
      n += 1
      seq.set(a.id, n)
    }
  }
  return seq
}

const STATUS_LABEL: Record<GroundStatus, string> = {
  parked: 'PARKED',
  pushback: 'PUSHBACK',
  taxi: 'TAXI',
  holding: 'HOLD',
  holdShort: 'HOLD SHORT',
  lineUpWait: 'LUAW',
  departing: 'TAKEOFF',
  onFinal: 'FINAL',
  landing: 'CLR LAND',
  rollout: 'ROLLOUT',
}

function intentLabel(intent: GroundIntent): string {
  return intent === 'departure' ? 'DEP' : 'ARR'
}

/** Route-building mode: pick a taxiway sequence on the scope, then a destination here
 *  issues the assembled "taxi via …". Chips remove a taxiway. */
function RouteBuilderRow({
  controller,
  item,
  draft,
}: {
  controller: GroundController
  item: StripItem
  draft: RouteDraft
}) {
  const stop = (e: React.MouseEvent) => e.stopPropagation()
  const lastVia = draft.via[draft.via.length - 1]
  const holdShort = lastVia ? controller.holdShortSpots().find((s) => s.label === `RWY @ ${lastVia}`) : undefined
  const issueVia = (dest: Point) => (e: React.MouseEvent) => {
    stop(e)
    controller.dispatch({ type: 'taxiVia', aircraftId: item.id, taxiways: draft.via, dest, exact: true })
    controller.clearRoute()
  }
  const issueViaGoal = (e: React.MouseEvent) => {
    stop(e)
    controller.dispatch({ type: 'taxiViaGoal', aircraftId: item.id, taxiways: draft.via })
    controller.clearRoute()
  }
  return (
    <div className="clearance">
      <span className="clearance-label">
        ROUTE{draft.via.length ? ' · VIA' : ' · click taxiways in order'}
      </span>
      {draft.via.map((t, i) => (
        <button
          key={`${t}-${i}`}
          className="strip-btn btn-via-chip"
          title="Remove from route"
          onClick={(e) => {
            stop(e)
            controller.removeViaAt(i)
          }}
        >
          {t} ✕
        </button>
      ))}
      {controller.destinations.map((d) => (
        <button key={d.id} className="strip-btn btn-taxi" onClick={issueVia(d.point)}>
          {d.label}
        </button>
      ))}
      {item.intent === 'arrival' && item.gate && (
        <button className="strip-btn btn-taxi" onClick={issueViaGoal}>
          Gate {item.gate}
        </button>
      )}
      {/* Where the last taxiway picked meets the runway — the destination for an intersection
          departure, which is otherwise unreachable: a via-route has to *end* somewhere, and the
          thresholds are the wrong end of the field. */}
      {holdShort && (
        <button className="strip-btn btn-taxi" onClick={issueVia(holdShort.point)}>
          Hold short {holdShort.label.replace('RWY @ ', '@ ')}
        </button>
      )}
      <button className="strip-btn" onClick={(e) => { stop(e); controller.clearRoute() }}>
        Cancel
      </button>
    </div>
  )
}

/** The two controller positions and their strip-bay labels. */
const POSITIONS: { key: ControllerPosition; label: string; title: string }[] = [
  { key: 'ground', label: 'GND', title: 'Ground / Clearance' },
  { key: 'tower', label: 'TWR', title: 'Tower / Local Control' },
]

export function StripBay({ controller }: { controller: GroundController }) {
  const snap = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const position = snap.position
  const tablistRef = useRef<HTMLDivElement>(null)

  // WAI-ARIA tabs pattern: Left/Right move selection + focus between the two positions.
  const onTabKey = (e: React.KeyboardEvent, index: number): void => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    e.preventDefault()
    const dir = e.key === 'ArrowRight' ? 1 : -1
    const next = (index + dir + POSITIONS.length) % POSITIONS.length
    controller.setPosition(POSITIONS[next]!.key)
    tablistRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
  }

  // One flight object, mode-specific projections: each position sees only the aircraft it
  // controls. Handoffs move a strip from one bay to the other (see docs/atc-tower.md).
  const counts: Record<ControllerPosition, number> = { ground: 0, tower: 0 }
  for (const a of snap.aircraft) counts[a.controlledBy] += 1
  const visible = snap.aircraft.filter((a) => a.controlledBy === position)
  const seq = takeoffSequence(snap.aircraft)

  return (
    <aside className="strip-bay">
      <div className="strip-tabs" role="tablist" aria-label="Controller position" ref={tablistRef}>
        {POSITIONS.map((p, i) => (
          <button
            key={p.key}
            type="button"
            role="tab"
            id={`strip-tab-${p.key}`}
            aria-selected={position === p.key}
            aria-controls="strip-list"
            tabIndex={position === p.key ? 0 : -1}
            className={`strip-tab${position === p.key ? ' strip-tab-active' : ''}`}
            title={p.title}
            onClick={() => controller.setPosition(p.key)}
            onKeyDown={(e) => onTabKey(e, i)}
          >
            {p.label}
            <span className="strip-tab-count">{counts[p.key]}</span>
          </button>
        ))}
      </div>
      <div className="strip-list" id="strip-list" role="tabpanel" aria-labelledby={`strip-tab-${position}`}>
        {visible.length === 0 && <div className="strip-empty">no traffic</div>}
        {visible.map((a) => {
          const wake = a.wake === 'H' ? ' H' : a.wake === 'J' ? ' J' : ''
          const selected = a.id === snap.selectedId
          return (
            <div
              key={a.id}
              className={`strip strip-${a.status}${selected ? ' strip-selected' : ''}`}
            >
              <button
                type="button"
                className="strip-summary"
                aria-pressed={selected}
                onClick={() => controller.select(a.id)}
              >
                <div className="strip-row1">
                  <span className="strip-cs">
                    {seq.has(a.id) && <span className="strip-seq">{seq.get(a.id)}</span>}
                    {a.callsign}
                    {wake}
                  </span>
                  <span className={`strip-badge badge-${a.status}`}>{STATUS_LABEL[a.status]}</span>
                </div>
                <div className="strip-row2">
                  <span className="strip-meta">
                    <span className={`intent intent-${a.intent}`}>{intentLabel(a.intent)}</span>
                    {a.type}
                    {/* A departure's gate is its origin; an arrival's is its destination, and it
                        gets its own line below — so only show it here for a departure. */}
                    {a.gate && a.intent === 'departure' ? ` · ${a.gate}` : ''}
                  </span>
                  {a.squawk && <span className="strip-squawk">{a.squawk}</span>}
                </div>
                {a.intent === 'arrival' && a.gate && a.status !== 'parked' && (
                  <div className={`strip-dest${a.destStandOccupied ? ' strip-dest-conflict' : ''}`}>
                    → GATE {a.gate}
                    {a.destStandOccupied ? ' ⚠ OCCUPIED' : ''}
                  </div>
                )}
                {a.altitude > 0 && (
                  <div className="strip-final">
                    ▼ {a.finalNm.toFixed(1)} NM · {a.altitude} FT
                    {a.exitRef ? ` · EXIT ${a.exitRef}` : ''}
                  </div>
                )}
                {a.status === 'rollout' && (
                  <div className="strip-final">
                    {a.exitRef ? `EXIT ${a.exitRef}` : 'ROLLING OUT'}
                    {a.vacated ? ' · CLEAR OF RWY' : ''}
                    {a.handoffPending ? ' · → GND' : ''}
                  </div>
                )}
                {a.via.length > 0 && <div className="strip-route">VIA {a.via.join(' · ')}</div>}
                {a.giveWayTo && <div className="strip-giveway">◁ GIVE WAY {a.giveWayTo}</div>}
                {a.waitingForStand && (
                  <div className="strip-giveway">⧗ GATE {a.waitingForStand} OCCUPIED</div>
                )}
                {a.wakeHoldSec > 0 && <div className="strip-wake">⚠ WAKE HOLD {a.wakeHoldSec}s</div>}
                {a.serviceSec > 0 && (
                  <div className="strip-svc">
                    <span className="svc-label">SVC {a.serviceSec}s</span>
                    <span className="svc-bars">
                      {a.services.map((s) => (
                        <span
                          key={s.kind}
                          className="svc-bar"
                          title={`${s.kind} · ${Math.ceil(s.remaining)}s`}
                        >
                          <span
                            className="svc-fill"
                            style={{ transform: `scaleX(${s.total > 0 ? 1 - s.remaining / s.total : 1})` }}
                          />
                        </span>
                      ))}
                    </span>
                  </div>
                )}
              </button>
              {selected &&
                (snap.draft && snap.draft.id === a.id ? (
                  <RouteBuilderRow controller={controller} item={a} draft={snap.draft} />
                ) : (
                  <StripCommandMenu controller={controller} item={a} aircraft={snap.aircraft} />
                ))}
            </div>
          )
        })}
      </div>
      <CommsLog
        comms={snap.comms}
        position={position}
        selectedId={snap.selectedId}
        onSelect={controller.select}
      />
    </aside>
  )
}

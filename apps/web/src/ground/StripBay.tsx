import { useSyncExternalStore } from 'react'
import type { GroundIntent, GroundStatus, Point } from '@anotheratc/sim'
import type { GroundController, RouteDraft, StripItem } from './controller'

const STATUS_LABEL: Record<GroundStatus, string> = {
  parked: 'PARKED',
  taxi: 'TAXI',
  holding: 'HOLD',
  holdShort: 'HOLD SHORT',
}

function intentLabel(intent: GroundIntent): string {
  return intent === 'departure' ? 'DEP' : 'ARR'
}

/** The clearance vocabulary for the selected aircraft — named destinations plus
 *  phase-gated actions. Mirrors the strip state machine. When a route draft is
 *  active for this aircraft, destinations issue the assembled "taxi via …" instead. */
function ClearanceRow({
  controller,
  item,
  draft,
}: {
  controller: GroundController
  item: StripItem
  draft: RouteDraft | null
}) {
  const stop = (e: React.MouseEvent) => e.stopPropagation()
  const send = (cmd: Parameters<GroundController['dispatch']>[0]) => (e: React.MouseEvent) => {
    stop(e)
    controller.dispatch(cmd)
  }

  if (item.status === 'holdShort') {
    return (
      <div className="clearance">
        <span className="clearance-label">HOLDING SHORT</span>
        <button className="strip-btn btn-cross" onClick={send({ type: 'crossRunway', aircraftId: item.id })}>
          Cross RWY
        </button>
      </div>
    )
  }

  // Route-building mode: destinations become the "issue" trigger for the via-sequence.
  if (draft && draft.id === item.id) {
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
        <button className="strip-btn" onClick={(e) => { stop(e); controller.clearRoute() }}>
          Cancel
        </button>
      </div>
    )
  }

  return (
    <div className="clearance">
      <span className="clearance-label">TAXI TO</span>
      {controller.destinations.map((d) => (
        <button
          key={d.id}
          className="strip-btn btn-taxi"
          onClick={send({ type: 'taxiTo', aircraftId: item.id, dest: d.point, exact: true })}
        >
          {d.label}
        </button>
      ))}
      {item.intent === 'arrival' && item.gate && (
        <button className="strip-btn btn-taxi" onClick={send({ type: 'taxiToGoal', aircraftId: item.id })}>
          Gate {item.gate}
        </button>
      )}
      {item.status === 'taxi' && (
        <button className="strip-btn" onClick={send({ type: 'hold', aircraftId: item.id })}>
          Hold
        </button>
      )}
      <button className="strip-btn btn-route" onClick={(e) => { stop(e); controller.beginRoute(item.id) }}>
        Route ▸
      </button>
    </div>
  )
}

export function StripBay({ controller }: { controller: GroundController }) {
  const snap = useSyncExternalStore(controller.subscribe, controller.getSnapshot)

  return (
    <aside className="strip-bay">
      <div className="strip-bay-title">FLIGHT STRIPS · GND</div>
      <div className="strip-list">
        {snap.aircraft.length === 0 && <div className="strip-empty">no traffic</div>}
        {snap.aircraft.map((a) => {
          const wake = a.wake === 'H' ? ' H' : a.wake === 'J' ? ' J' : ''
          const selected = a.id === snap.selectedId
          return (
            <div
              key={a.id}
              className={`strip strip-${a.status}${selected ? ' strip-selected' : ''}`}
              onClick={() => controller.select(a.id)}
            >
              <div className="strip-row1">
                <span className="strip-cs">
                  {a.callsign}
                  {wake}
                </span>
                <span className={`strip-badge badge-${a.status}`}>{STATUS_LABEL[a.status]}</span>
              </div>
              <div className="strip-row2">
                <span className="strip-meta">
                  <span className={`intent intent-${a.intent}`}>{intentLabel(a.intent)}</span>
                  {a.type}
                  {a.gate ? ` · ${a.gate}` : ''}
                </span>
              </div>
              {a.via.length > 0 && <div className="strip-route">VIA {a.via.join(' · ')}</div>}
              {selected && <ClearanceRow controller={controller} item={a} draft={snap.draft} />}
            </div>
          )
        })}
      </div>
    </aside>
  )
}

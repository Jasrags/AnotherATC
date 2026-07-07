import { useSyncExternalStore } from 'react'
import type { GroundIntent, GroundStatus, Point } from '@anotheratc/sim'
import type { GroundController, RouteDraft, StripItem } from './controller'
import { StripCommandMenu } from './StripCommandMenu'

const STATUS_LABEL: Record<GroundStatus, string> = {
  parked: 'PARKED',
  pushback: 'PUSHBACK',
  taxi: 'TAXI',
  holding: 'HOLD',
  holdShort: 'HOLD SHORT',
  departing: 'TAKEOFF',
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
                {a.squawk && <span className="strip-squawk">{a.squawk}</span>}
              </div>
              {a.via.length > 0 && <div className="strip-route">VIA {a.via.join(' · ')}</div>}
              {a.giveWayTo && <div className="strip-giveway">◁ GIVE WAY {a.giveWayTo}</div>}
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
    </aside>
  )
}

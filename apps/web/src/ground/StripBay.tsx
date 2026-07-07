import { useSyncExternalStore } from 'react'
import type { GroundIntent, GroundStatus } from '@anotheratc/sim'
import type { GroundController, StripItem } from './controller'

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
 *  phase-gated actions. Mirrors the strip state machine. */
function ClearanceRow({ controller, item }: { controller: GroundController; item: StripItem }) {
  const send = (cmd: Parameters<GroundController['dispatch']>[0]) => (e: React.MouseEvent) => {
    e.stopPropagation()
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
              {selected && <ClearanceRow controller={controller} item={a} />}
            </div>
          )
        })}
      </div>
    </aside>
  )
}

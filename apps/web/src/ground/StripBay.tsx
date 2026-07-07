import { useSyncExternalStore } from 'react'
import type { GroundIntent, GroundStatus } from '@anotheratc/sim'
import type { GroundController, StripItem } from './controller'

const STATUS_LABEL: Record<GroundStatus, string> = {
  parked: 'PARKED',
  taxi: 'TAXI',
  holding: 'HOLD',
  holdShort: 'HOLD SHORT',
}

/** Phase- and intent-gated action for a strip — mirrors the strip state machine. */
function StripAction({ controller, item }: { controller: GroundController; item: StripItem }) {
  const act = (cmd: Parameters<GroundController['dispatch']>[0]) => (e: React.MouseEvent) => {
    e.stopPropagation()
    controller.dispatch(cmd)
  }
  if (item.status === 'holdShort') {
    return (
      <button className="strip-btn btn-cross" onClick={act({ type: 'crossRunway', aircraftId: item.id })}>
        Cross RWY
      </button>
    )
  }
  if (item.status === 'taxi') {
    return (
      <button className="strip-btn" onClick={act({ type: 'hold', aircraftId: item.id })}>
        Hold
      </button>
    )
  }
  // parked or holding — send it to its goal
  const label = item.intent === 'departure' ? 'Taxi ▸ RWY' : 'Taxi ▸ Gate'
  return (
    <button className="strip-btn btn-taxi" onClick={act({ type: 'taxiToGoal', aircraftId: item.id })}>
      {label}
    </button>
  )
}

function intentLabel(intent: GroundIntent): string {
  return intent === 'departure' ? 'DEP' : 'ARR'
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
                <StripAction controller={controller} item={a} />
              </div>
            </div>
          )
        })}
      </div>
    </aside>
  )
}

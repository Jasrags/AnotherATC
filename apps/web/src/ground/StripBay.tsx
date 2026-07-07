import { useSyncExternalStore } from 'react'
import type { GroundStatus } from '@anotheratc/sim'
import type { GroundController } from './controller'

const STATUS_LABEL: Record<GroundStatus, string> = {
  parked: 'PARKED',
  taxi: 'TAXI',
  holding: 'HOLD',
  holdShort: 'HOLD SHORT',
}

/** Phase-gated action for a strip — mirrors the strip state machine. */
function StripAction({
  controller,
  id,
  status,
}: {
  controller: GroundController
  id: string
  status: GroundStatus
}) {
  const act = (cmd: Parameters<GroundController['dispatch']>[0]) => (e: React.MouseEvent) => {
    e.stopPropagation()
    controller.dispatch(cmd)
  }
  switch (status) {
    case 'taxi':
      return (
        <button className="strip-btn" onClick={act({ type: 'hold', aircraftId: id })}>
          Hold
        </button>
      )
    case 'holding':
      return (
        <button className="strip-btn" onClick={act({ type: 'resume', aircraftId: id })}>
          Resume
        </button>
      )
    case 'holdShort':
      return (
        <button className="strip-btn btn-cross" onClick={act({ type: 'crossRunway', aircraftId: id })}>
          Cross RWY
        </button>
      )
    default:
      return <span className="strip-hint">select → taxi</span>
  }
}

export function StripBay({ controller }: { controller: GroundController }) {
  const snap = useSyncExternalStore(controller.subscribe, controller.getSnapshot)

  return (
    <aside className="strip-bay">
      <div className="strip-bay-title">FLIGHT STRIPS · GND</div>
      <div className="strip-list">
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
                <span className="strip-type">{a.type}</span>
                <StripAction controller={controller} id={a.id} status={a.status} />
              </div>
            </div>
          )
        })}
      </div>
    </aside>
  )
}

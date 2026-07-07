import { useEffect, useRef, useState } from 'react'
import type { GroundController, StripItem } from './controller'

/** A leaf action inside a submenu (a concrete target for a parameterized command). */
interface MenuLeaf {
  label: string
  run: () => void
}

/** What activating a command does. `soon` = part of the vocabulary but not yet built. */
type MenuAction =
  | { kind: 'run'; run: () => void }
  | { kind: 'submenu'; items: MenuLeaf[] }
  | { kind: 'soon' }

interface MenuCommand {
  label: string
  action: MenuAction
}

/**
 * The phase-gated ground-command vocabulary for one aircraft. Only actions valid for
 * the current status/intent are listed; commands whose backend isn't built yet appear
 * as `soon` (disabled) so the menu still communicates the intended flow. Mirrors the
 * strip state machine — see `docs/atc-flight-strips.md`.
 */
function commandsFor(controller: GroundController, item: StripItem, aircraft: StripItem[]): MenuCommand[] {
  const id = item.id
  const send = controller.dispatch

  if (item.status === 'holdShort') {
    // A departure at its runway is done with Ground — hand it to Tower for takeoff.
    // Anything else holding short is transiting the runway — clear it across.
    if (item.intent === 'departure') {
      return [
        { label: 'Contact tower', action: { kind: 'run', run: () => send({ type: 'contactTower', aircraftId: id }) } },
        { label: 'Hold position', action: { kind: 'soon' } },
      ]
    }
    return [
      { label: 'Cross runway', action: { kind: 'run', run: () => send({ type: 'crossRunway', aircraftId: id }) } },
      { label: 'Hold position', action: { kind: 'soon' } },
    ]
  }

  // A departure at the gate must push back before it can taxi.
  if (item.status === 'parked' && item.intent === 'departure') {
    return [
      { label: 'Pushback approved', action: { kind: 'run', run: () => send({ type: 'pushback', aircraftId: id }) } },
      { label: 'Contact tower', action: { kind: 'soon' } },
    ]
  }
  if (item.status === 'pushback') {
    return [{ label: 'Contact tower', action: { kind: 'soon' } }]
  }

  const dests: MenuLeaf[] = controller.destinations.map((d) => ({
    label: d.label,
    run: () => send({ type: 'taxiTo', aircraftId: id, dest: d.point, exact: true }),
  }))
  if (item.intent === 'arrival' && item.gate) {
    dests.push({ label: `Gate ${item.gate}`, run: () => send({ type: 'taxiToGoal', aircraftId: id }) })
  }

  const cmds: MenuCommand[] = []
  cmds.push({ label: 'Taxi to…', action: { kind: 'submenu', items: dests } })
  cmds.push({ label: 'Route via…', action: { kind: 'run', run: () => controller.beginRoute(id) } })
  if (item.status === 'taxi') {
    cmds.push({ label: 'Hold position', action: { kind: 'run', run: () => send({ type: 'hold', aircraftId: id }) } })
    const targets = aircraft.filter((o) => o.id !== id && o.status !== 'parked')
    cmds.push(
      targets.length > 0
        ? {
            label: 'Give way to…',
            action: {
              kind: 'submenu',
              items: targets.map((o) => ({
                label: o.callsign,
                run: () => send({ type: 'giveWay', aircraftId: id, toId: o.id }),
              })),
            },
          }
        : { label: 'Give way to…', action: { kind: 'soon' } },
    )
  }
  if (item.status === 'holding' || item.giveWayTo) {
    cmds.push({ label: 'Continue taxi', action: { kind: 'run', run: () => send({ type: 'resume', aircraftId: id }) } })
  }
  cmds.push({ label: 'Contact tower', action: { kind: 'soon' } })
  return cmds
}

/** Numbered, state-dependent command menu for the selected flight strip. */
export function StripCommandMenu({
  controller,
  item,
  aircraft,
}: {
  controller: GroundController
  item: StripItem
  aircraft: StripItem[]
}) {
  const [openSub, setOpenSub] = useState<number | null>(null)
  const commands = commandsFor(controller, item, aircraft)

  const stop = (e: React.MouseEvent) => e.stopPropagation()
  const activate = (i: number): void => {
    const action = commands[i]?.action
    if (!action) return
    if (action.kind === 'run') {
      action.run()
      setOpenSub(null)
    } else if (action.kind === 'submenu') {
      setOpenSub((s) => (s === i ? null : i))
    }
  }

  // Number-key shortcuts (1–9, 0) for the selected aircraft. Registered once while the
  // menu is mounted (i.e. while this strip is selected and not route-building); reads the
  // current commands via a ref so it never needs to re-subscribe.
  const commandsRef = useRef(commands)
  commandsRef.current = commands
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const cmds = commandsRef.current
      const n = e.key === '0' ? 10 : /^[1-9]$/.test(e.key) ? Number(e.key) : 0
      if (n < 1 || n > cmds.length) return
      const action = cmds[n - 1]?.action
      if (!action || action.kind === 'soon') return
      e.preventDefault()
      if (action.kind === 'run') {
        action.run()
        setOpenSub(null)
      } else {
        setOpenSub((s) => (s === n - 1 ? null : n - 1))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="cmd-menu" onClick={stop}>
      {commands.map((c, i) => {
        const num = i + 1 >= 10 ? 0 : i + 1
        const disabled = c.action.kind === 'soon'
        const isSub = c.action.kind === 'submenu'
        return (
          <div key={c.label}>
            <button
              type="button"
              className={`cmd-item${disabled ? ' cmd-disabled' : ''}${openSub === i ? ' cmd-open' : ''}`}
              disabled={disabled}
              onClick={(e) => {
                stop(e)
                activate(i)
              }}
            >
              <span className="cmd-num">{num}</span>
              <span className="cmd-label">{c.label}</span>
              {isSub && <span className="cmd-caret">›</span>}
              {disabled && <span className="cmd-soon">soon</span>}
            </button>
            {c.action.kind === 'submenu' && openSub === i && (
              <div className="cmd-sub">
                {c.action.items.map((leaf) => (
                  <button
                    type="button"
                    key={leaf.label}
                    className="cmd-item cmd-sub-item"
                    onClick={(e) => {
                      stop(e)
                      leaf.run()
                      setOpenSub(null)
                    }}
                  >
                    {leaf.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

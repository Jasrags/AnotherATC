import type { GroundController, StripItem } from './controller'

/** A leaf action inside a submenu (a concrete target for a parameterized command). */
export interface MenuLeaf {
  label: string
  run: () => void
}

/** What activating a command does. `soon` = part of the vocabulary but not yet built. */
export type MenuAction =
  | { kind: 'run'; run: () => void }
  | { kind: 'submenu'; items: MenuLeaf[] }
  | { kind: 'soon' }

export interface MenuCommand {
  label: string
  action: MenuAction
}

/**
 * The phase-gated ground-command vocabulary for one aircraft. Only actions valid for
 * the current status/intent are listed; commands whose backend isn't built yet appear
 * as `soon` (disabled) so the menu still communicates the intended flow. Mirrors the
 * strip state machine — see `docs/atc-flight-strips.md`.
 */
export function commandsFor(controller: GroundController, item: StripItem, aircraft: StripItem[]): MenuCommand[] {
  const id = item.id
  const send = controller.dispatch

  if (item.status === 'departing') {
    return [{ label: 'Rolling — with tower', action: { kind: 'soon' } }]
  }

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

  // Gate departure: deliver the IFR clearance (assigns a squawk), then push back.
  if (item.status === 'parked' && item.intent === 'departure') {
    if (!item.squawk) {
      return [
        { label: 'Deliver clearance', action: { kind: 'run', run: () => send({ type: 'clearance', aircraftId: id }) } },
        { label: 'Contact tower', action: { kind: 'soon' } },
      ]
    }
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

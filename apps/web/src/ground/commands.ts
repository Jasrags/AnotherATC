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
  /** Stable identity for React keying, for commands whose label changes with state (e.g. a
   *  takeoff gated to "— runway busy"). Defaults to the label when omitted. */
  key?: string
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

  // Tower-owned (handed off from Ground): Local Control's runway actions. Gate the runway
  // clearances with a visible reason (wake / runway busy) rather than a silent refusal.
  if (item.controlledBy === 'tower') {
    // Arrivals: the runway-clear predicate (surface occupants + anyone on short final) is
    // what the sim gates the landing clearance on, so mirror it in the disabled label.
    if (item.intent === 'arrival') {
      if (item.status === 'onFinal') {
        const runwayBusy = aircraft.some((o) => o.id !== id && (o.blocksTakeoff || o.onShortFinal))
        return [
          runwayBusy
            ? { key: 'land', label: 'Cleared to land — runway busy', action: { kind: 'soon' } }
            : {
                key: 'land',
                label: 'Cleared to land',
                action: { kind: 'run', run: () => send({ type: 'clearedToLand', aircraftId: id }) },
              },
          { label: 'Go around', action: { kind: 'soon' } },
        ]
      }
      if (item.status === 'landing') return [{ label: 'Go around', action: { kind: 'soon' } }]
      if (item.status === 'rollout') return [{ label: 'Rolling out — exiting the runway', action: { kind: 'soon' } }]
    }

    // A stationary occupant (lined up or crossing) blocks a line-up; a rolling departure doesn't.
    // Traffic on short final blocks both — you can't put anything under a landing aircraft.
    const runwayBlockedForLineup = aircraft.some(
      (o) => o.id !== id && ((o.onRunway && o.status !== 'departing') || o.onShortFinal),
    )
    // A takeoff needs the runway clear of anything not yet rotated (self excluded).
    const runwayBlockedForTakeoff = aircraft.some((o) => o.id !== id && (o.blocksTakeoff || o.onShortFinal))

    // Reason order mirrors the sim's dispatch guards (runway-occupied is checked before wake),
    // so the disabled label names the reason the sim would actually refuse with. `key` stays
    // stable across the label changes so the button doesn't remount (and lose focus) when gated.
    const takeoff: MenuCommand = runwayBlockedForTakeoff
      ? { key: 'takeoff', label: 'Cleared for takeoff — runway busy', action: { kind: 'soon' } }
      : item.wakeHoldSec > 0
        ? { key: 'takeoff', label: `Cleared for takeoff — wake ${item.wakeHoldSec}s`, action: { kind: 'soon' } }
        : { key: 'takeoff', label: 'Cleared for takeoff', action: { kind: 'run', run: () => send({ type: 'clearedForTakeoff', aircraftId: id }) } }

    if (item.status === 'lineUpWait') {
      return [takeoff, { label: 'Hold position', action: { kind: 'soon' } }]
    }
    if (item.status === 'holdShort') {
      const lineup: MenuCommand = runwayBlockedForLineup
        ? { key: 'lineup', label: 'Line up and wait — runway busy', action: { kind: 'soon' } }
        : { key: 'lineup', label: 'Line up and wait', action: { kind: 'run', run: () => send({ type: 'lineUpAndWait', aircraftId: id }) } }
      return [lineup, takeoff, { label: 'Hold position', action: { kind: 'soon' } }]
    }
    // Defensive net: today a Tower-owned aircraft is only ever holdShort / lineUpWait /
    // departing (departing is handled above), so this is unreachable — but if the sim grows a
    // new tower-owned status it degrades to a harmless disabled item instead of an empty menu.
    return [{ label: 'With tower', action: { kind: 'soon' } }]
  }

  if (item.status === 'holdShort') {
    // Holding short of its own departure runway → done with Ground, hand to Tower for takeoff.
    // Holding short to transit (a crossing, incl. a departure whose route continues past the
    // runway) → clear it across, never a takeoff.
    if (item.holdingForTakeoff) {
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
      ]
    }
    // Cleared, but pushback stays gated until ground servicing (fuel/cargo/…) finishes.
    const pushback: MenuCommand =
      item.serviceSec > 0
        ? { label: `Pushback — servicing ${item.serviceSec}s`, action: { kind: 'soon' } }
        : { label: 'Pushback approved', action: { kind: 'run', run: () => send({ type: 'pushback', aircraftId: id }) } }
    return [pushback]
  }
  // Pushback is an automatic maneuver — nothing for the controller to do until it's holding.
  if (item.status === 'pushback') {
    return []
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
  // Contact tower is deliberately not offered here: it becomes available only once the
  // aircraft is holding short of its runway (the 'holdShort' branch above).
  return cmds
}

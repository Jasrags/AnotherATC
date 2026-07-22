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
/** "Gate 22" — send an arrival somewhere else. Offered in every phase before it parks, on both
 *  frequencies, because the gate conflict is usually spotted while it is still on final and the
 *  answer to a blocked gate is not always to wait for it. Labelled with the conflict when there
 *  is one, so the reason to open the menu is on the menu. */
function reassignStand(controller: GroundController, item: StripItem): MenuCommand | null {
  if (item.intent !== 'arrival' || item.status === 'parked') return null
  const label = item.destStandOccupied ? 'Reassign gate… (occupied)' : 'Reassign gate…'
  if (item.standOptions.length === 0) return { key: 'stand', label, action: { kind: 'soon' } }
  return {
    key: 'stand',
    label,
    action: {
      kind: 'submenu',
      items: item.standOptions.map((s) => ({
        label: `Gate ${s.ref}`,
        run: () => controller.dispatch({ type: 'assignStand', aircraftId: item.id, ref: s.ref }),
      })),
    },
  }
}

/** "Go around" — the half of the runway-incursion answer that moves the aircraft in the air.
 *  Labelled with the reason when this arrival is the one being landed on top of something, so
 *  the reason to open the menu is on the menu (as with the gate conflict above). */
function goAround(controller: GroundController, item: StripItem): MenuCommand {
  return {
    key: 'goAround',
    label: item.incursion ? 'Go around — runway occupied' : 'Go around',
    action: { kind: 'run', run: () => controller.dispatch({ type: 'goAround', aircraftId: item.id }) },
  }
}

/** "Expedite" — the other half: move the aircraft on the ground instead. Offered wherever there
 *  is a clearance left to run, and named for the job when the aircraft is the one on the runway;
 *  disabled (rather than hidden) when it cannot be hurried, because "this aircraft cannot get out
 *  of the way" is exactly what tells you to send the other one around. */
function expedite(controller: GroundController, item: StripItem): MenuCommand {
  if (item.expedite) return { key: 'expedite', label: 'Expediting', action: { kind: 'soon' } }
  if (!item.canExpedite) return { key: 'expedite', label: 'Expedite — nothing to run', action: { kind: 'soon' } }
  return {
    key: 'expedite',
    label: item.incursion ? 'Expedite — clear the runway' : 'Expedite',
    action: { kind: 'run', run: () => controller.dispatch({ type: 'expedite', aircraftId: item.id }) },
  }
}

/** "Hold short of runway 27" — the other half of the crossing exchange. At the line it is the
 *  answer to a crossing request; before it, a confirmation; and after a crossing clearance the
 *  aircraft has not acted on, it takes that clearance back. Falls back to the old disabled
 *  "Hold position" where there is no runway ahead to hold short of, which is the only place the
 *  placeholder was ever the right words. */
function holdShort(controller: GroundController, item: StripItem): MenuCommand {
  if (!item.canHoldShort) return { key: 'holdshort', label: 'Hold position', action: { kind: 'soon' } }
  return {
    key: 'holdshort',
    label: 'Hold short of runway',
    action: { kind: 'run', run: () => controller.dispatch({ type: 'holdShort', aircraftId: item.id }) },
  }
}

/** "Cross runway 27" — gated on the same runway-clear predicate the sim refuses with, and
 *  labelled with the reason when it is closed, exactly like the line-up and takeoff beside it.
 *  Tower's version says "no delay" on the air; that distinction lives in the phraseology, not
 *  here, so both positions offer the same button. */
function crossRunway(controller: GroundController, item: StripItem, runwayBusy: boolean): MenuCommand {
  if (runwayBusy) return { key: 'cross', label: 'Cross runway — runway busy', action: { kind: 'soon' } }
  return {
    key: 'cross',
    label: 'Cross runway',
    action: { kind: 'run', run: () => controller.dispatch({ type: 'crossRunway', aircraftId: item.id }) },
  }
}

/** m:ss — a wait is read as a duration. Shared with the strip's own EDCT line. */
export function clock(sec: number): string {
  return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`
}

export function commandsFor(controller: GroundController, item: StripItem, aircraft: StripItem[]): MenuCommand[] {
  const cmds = [...phaseCommandsFor(controller, item, aircraft)]
  const stand = reassignStand(controller, item)
  if (stand) cmds.push(stand)
  // "Say again" applies in every phase once anything has been said, and is deliberately offered
  // whether or not the read-back was wrong — an always-available correction is a judgement; one
  // that appears only when needed is a prompt.
  if (!item.hasInstruction) return cmds
  return [
    ...cmds,
    {
      key: 'sayAgain',
      label: 'Say again',
      action: { kind: 'run', run: () => controller.dispatch({ type: 'sayAgain', aircraftId: item.id }) },
    },
  ]
}

function phaseCommandsFor(controller: GroundController, item: StripItem, aircraft: StripItem[]): MenuCommand[] {
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
      // "Turn left at Bravo Five" — the turnoff the aircraft will take. Only the exits it can
      // still slow down for are listed, so an unmakeable one is never offered. These come off
      // the published snapshot, not a live sim query, so the menu and the strip above it are
      // always the same instant.
      const exits = item.exitOptions
      const exitMenu: MenuCommand =
        exits.length > 0
          ? {
              key: 'exit',
              label: item.exitRef ? `Exit at… (${item.exitRef})` : 'Exit at…',
              action: {
                kind: 'submenu',
                items: exits.map((e) => ({
                  label: `${e.ref} — ${e.turn} ${e.kind === 'rapid' ? 'high-speed' : '90°'} · ${e.distanceNm.toFixed(1)} nm`,
                  run: () => send({ type: 'assignExit', aircraftId: id, ref: e.ref }),
                })),
              },
            }
          : { key: 'exit', label: 'Exit at…', action: { kind: 'soon' } }

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
          exitMenu,
          goAround(controller, item),
        ]
      }
      if (item.status === 'landing') return [exitMenu, goAround(controller, item)]
      if (item.status === 'rollout') {
        // The pilot never switches frequency unprompted. Issued before the aircraft is clear,
        // this is the real "when vacated, contact ground" — it applies the moment it vacates.
        const handoff: MenuCommand = item.handoffPending
          ? { key: 'gnd', label: 'Sent to ground — awaiting vacate', action: { kind: 'soon' } }
          : {
              key: 'gnd',
              label: item.vacated ? 'Contact ground' : 'When vacated, contact ground',
              action: { kind: 'run', run: () => send({ type: 'contactGround', aircraftId: id }) },
            }
        return item.vacated ? [handoff] : [exitMenu, handoff]
      }
    }

    // Still a placeholder for an aircraft *on* the runway, where "hold short" is meaningless and
    // "hold position" is the right words — the one place the stub was never the wrong idea.
    const holdPosition: MenuCommand = { label: 'Hold position', action: { kind: 'soon' } }
    // A stationary occupant (lined up or crossing) blocks a line-up; traffic *leaving* down the
    // runway does not — a rolling departure or a landing rolling out is what the instruction
    // exists to be issued behind (docs/atc-operations.md §6). Traffic on short final blocks it
    // either way: nothing goes under an aircraft about to touch down. Mirrors the sim's own
    // predicate, so the menu never disables a clearance the sim would accept.
    const leaving = (o: StripItem) => o.status === 'departing' || o.status === 'rollout'
    const runwayBlockedForLineup = aircraft.some(
      (o) => o.id !== id && ((o.onRunway && !leaving(o)) || o.onShortFinal),
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
        : // The wheels-up window, in the same voice as the wake hold beside it: the sim would
          // refuse this clearance, so the menu names the reason rather than offering a button
          // that fails. It goes last because it is the only one of the three the controller
          // cannot do anything about — the aircraft is ready, the runway is free, and it waits.
          item.edctSec !== null && item.edctInSec > 0
          ? { key: 'takeoff', label: `Cleared for takeoff — EDCT ${clock(item.edctInSec)}`, action: { kind: 'soon' } }
          : { key: 'takeoff', label: 'Cleared for takeoff', action: { kind: 'run', run: () => send({ type: 'clearedForTakeoff', aircraftId: id }) } }

    if (item.status === 'lineUpWait') {
      return [takeoff, holdPosition]
    }
    if (item.status === 'holdShort') {
      // A transit is holding short to *cross*, not to depart: Local Control owns the runway for
      // both, but they are different operations and it gets the crossing vocabulary only.
      // Anything else here would offer to line it up on a runway it has no business using.
      if (!item.holdingForTakeoff) {
        return [crossRunway(controller, item, runwayBlockedForLineup), holdShort(controller, item)]
      }
      // Named for what it is when there is something to line up behind: an aircraft being sent
      // onto an occupied runway should be able to read why from the button.
      const behindLanding = aircraft.some((o) => o.id !== id && o.status === 'rollout' && o.onRunway)
      const lineup: MenuCommand = item.lineUpBehind
        ? // Already issued, conditionally. Saying what it is waiting for beats offering it
          // again: the clearance exists, it simply has not happened yet, and "hold short"
          // below is how it is taken back.
          { key: 'lineup', label: `Lining up behind ${item.lineUpBehind} — issued`, action: { kind: 'soon' } }
        : runwayBlockedForLineup
          ? { key: 'lineup', label: 'Line up and wait — runway busy', action: { kind: 'soon' } }
          : {
              key: 'lineup',
              label: behindLanding ? 'Line up and wait — behind landing traffic' : 'Line up and wait',
              action: { kind: 'run', run: () => send({ type: 'lineUpAndWait', aircraftId: id }) },
            }

      // "Behind the landing 737, line up and wait, behind" — offered only against traffic that
      // is actually landing, because that is the only condition this clearance can name and the
      // only one the sim will accept. Not offered once one is armed: a second would replace a
      // commitment already made, silently.
      const inbound = aircraft.filter((o) => o.id !== id && o.status === 'landing')
      const lineupBehind: MenuCommand | null =
        item.lineUpBehind || inbound.length === 0
          ? null
          : {
              key: 'lineupBehind',
              label: 'Line up and wait behind…',
              action: {
                kind: 'submenu',
                items: inbound.map((o) => ({
                  label: `${o.callsign} — landing`,
                  run: () => send({ type: 'lineUpAndWait', aircraftId: id, behind: o.id }),
                })),
              },
            }
      return [lineup, ...(lineupBehind ? [lineupBehind] : []), takeoff, holdShort(controller, item)]
    }
    // Tower-owned and no longer holding short: a crossing it cleared and now has to give back.
    // Offered while the aircraft is still on the runway too — that is the real "when clear of
    // the runway, contact ground", and issuing it early is what keeps the crossing moving.
    //
    // Deliberately not restricted to departures. An arrival crosses to reach its gate, and the
    // arrival branch above has already returned for every airborne and rollout phase, so an
    // arrival reaching here is a surface transit like any other — gating this on intent left it
    // stranded on Tower's frequency with no command that gave it back.
    return [
      item.handoffPending
        ? { key: 'gnd', label: 'Sent to ground — awaiting clear', action: { kind: 'soon' } }
        : {
            key: 'gnd',
            label: item.onRunway ? 'When clear of the runway, contact ground' : 'Contact ground',
            action: { kind: 'run', run: () => send({ type: 'contactGround', aircraftId: id }) },
          },
      expedite(controller, item),
    ]
  }

  if (item.status === 'holdShort') {
    // Holding short of its own departure runway → done with Ground, hand to Tower for takeoff.
    // Holding short to transit (a crossing, incl. a departure whose route continues past the
    // runway) → clear it across, never a takeoff.
    if (item.holdingForTakeoff) {
      return [
        { label: 'Contact tower', action: { kind: 'run', run: () => send({ type: 'contactTower', aircraftId: id }) } },
        holdShort(controller, item),
      ]
    }
    // Both real options, and the choice is the controller's: clear it across on this frequency,
    // or hand it to Local Control for the crossing (docs/atc-runway-crossing.md §5).
    const runwayBusy = aircraft.some((o) => o.id !== id && (o.blocksTakeoff || o.onShortFinal))
    return [
      crossRunway(controller, item, runwayBusy),
      {
        key: 'twr',
        label: 'Contact tower for crossing',
        action: { kind: 'run', run: () => send({ type: 'contactTower', aircraftId: id }) },
      },
      holdShort(controller, item),
    ]
  }

  // Gate departure: deliver the IFR clearance (assigns a squawk), then push back. Only an
  // aircraft actually on a stand goes through this — one placed out on a taxiway by the dev
  // sandbox has nothing to be pushed back off, so it starts at the taxi vocabulary instead.
  if (item.status === 'parked' && item.intent === 'departure' && item.gate) {
    if (!item.squawk) {
      return [
        { label: 'Deliver clearance', action: { kind: 'run', run: () => send({ type: 'clearance', aircraftId: id }) } },
      ]
    }
    // Cleared, but pushback stays gated until ground servicing (fuel/cargo/…) finishes.
    if (item.serviceSec > 0) {
      return [{ label: `Pushback — servicing ${item.serviceSec}s`, action: { kind: 'soon' } }]
    }
    // Which way it faces coming off the stand is a real decision: the alley runs two ways and
    // the aircraft cannot turn round on it, so this picks which way it can then taxi. The
    // taxiway each direction faces down is named, since that is the consequence.
    const ways = item.pushbackOptions
    const pushback: MenuCommand =
      ways.length > 1
        ? {
            key: 'push',
            label: 'Pushback approved…',
            action: {
              kind: 'submenu',
              items: ways.map((w) => ({
                label: w.ref ? `Facing ${w.facing} (${w.ref})` : `Facing ${w.facing}`,
                run: () => send({ type: 'pushback', aircraftId: id, facing: w.facing }),
              })),
            },
          }
        : { key: 'push', label: 'Pushback approved', action: { kind: 'run', run: () => send({ type: 'pushback', aircraftId: id }) } }
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
  // Every taxiway/runway intersection, so a departure can be sent to hold short partway down
  // the runway for an intersection departure rather than only to a threshold.
  if (item.intent === 'departure') {
    for (const spot of controller.holdShortSpots()) {
      dests.push({
        label: spot.label,
        run: () => send({ type: 'taxiTo', aircraftId: id, dest: spot.point, exact: true }),
      })
    }
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
  // Only when there is a clearance to continue. `canExpedite` is the sim's own "route left to
  // run" predicate, which is exactly what `resume` acts on — an arrival stopped clear of the
  // runway awaiting its first taxi instruction has none, and offering it "Continue taxi" there
  // is what made the handoff read as though it had already been sent somewhere. A give-way hold
  // is separate: continuing lifts it whether or not the route is spent.
  if ((item.status === 'holding' && item.canExpedite) || item.giveWayTo) {
    cmds.push({ label: 'Continue taxi', action: { kind: 'run', run: () => send({ type: 'resume', aircraftId: id }) } })
  }
  // Offered from every phase that has a route under way, not only when it has gone wrong: an
  // expedite is an ordinary instruction, and one that only appears during an alert is a prompt.
  if (item.status === 'taxi' || item.status === 'holding' || item.giveWayTo) {
    cmds.push(expedite(controller, item))
  }
  // A crossing clearance can be taken back right up until the aircraft is on the pavement —
  // which is exactly the window an arrival turning up on final lands in. (Aircraft already at
  // the line returned from the hold-short branch above and never reach here.)
  if (item.canHoldShort) cmds.push(holdShort(controller, item))
  // Contact tower is deliberately not offered here: it becomes available only once the
  // aircraft is holding short of its runway (the 'holdShort' branch above).
  return cmds
}

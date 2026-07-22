import { describe, it, expect } from 'vitest'
import type { GroundCommand, RunwayExit } from '@anotheratc/sim'
import { commandsFor } from './commands'
import type { GroundController, StripItem } from './controller'

function strip(over: Partial<StripItem> = {}): StripItem {
  return {
    id: 'a',
    callsign: 'AAL1',
    type: 'B738',
    wake: 'M',
    status: 'taxi',
    controlledBy: 'ground',
    intent: 'departure',
    gate: null,
    holdingForTakeoff: false,
    onRunway: false,
    blocksTakeoff: false,
    onShortFinal: false,
    exitRef: null,
    exitOptions: [],
    vacated: false,
    handoffPending: false,
    altitude: 0,
    finalNm: 0,
    via: [],
    giveWayTo: null,
    incursion: false,
    expedite: false,
    canExpedite: true,
    waitingForStand: null,
    destStandOccupied: false,
    standOptions: [],
    squawk: null,
    hasInstruction: false,
    pushbackOptions: [],
    wakeHoldSec: 0,
    services: [],
    serviceSec: 0,
    ...over,
  }
}

// Deliberately has no `exitOptions` method: the command menu must build itself from the
// published StripItem, never from a live sim query during render. A regression would throw here.
function fakeController() {
  const dispatched: GroundCommand[] = []
  const beganRoute: string[] = []
  const controller = {
    dispatch: (cmd: GroundCommand) => dispatched.push(cmd),
    beginRoute: (id: string) => beganRoute.push(id),
    holdShortSpots: () => [
      { id: 'hs-B4', label: 'RWY @ B4', kind: 'spot', point: [0.5, 0] },
      { id: 'hs-B2', label: 'RWY @ B2', kind: 'spot', point: [0.9, 0] },
    ],
    destinations: [
      { id: 'rwy27', label: 'RWY 27', kind: 'runway', point: [1, 0] },
      { id: 'rwy09', label: 'RWY 9', kind: 'runway', point: [-1, 0] },
    ],
  } as unknown as GroundController
  return { controller, dispatched, beganRoute }
}

const labels = (c: ReturnType<typeof commandsFor>): string[] => c.map((x) => x.label)

describe('commandsFor (strip state machine)', () => {
  it('departing → only a disabled "rolling" note', () => {
    const { controller } = fakeController()
    const cmds = commandsFor(controller, strip({ status: 'departing' }), [])
    expect(labels(cmds)).toEqual(['Rolling — with tower'])
    expect(cmds[0]!.action.kind).toBe('soon')
  })

  it('holdShort for takeoff (own departure runway) → contact tower (runs), hold position (soon)', () => {
    const { controller, dispatched } = fakeController()
    const cmds = commandsFor(controller, strip({ status: 'holdShort', intent: 'departure', holdingForTakeoff: true }), [])
    expect(labels(cmds)).toEqual(['Contact tower', 'Hold position'])
    const contact = cmds[0]!.action
    if (contact.kind === 'run') contact.run()
    expect(dispatched).toEqual([{ type: 'contactTower', aircraftId: 'a' }])
    expect(cmds[1]!.action.kind).toBe('soon')
  })

  it('tower-owned holdShort → line up and wait (runs), cleared for takeoff (runs), hold (soon)', () => {
    const { controller, dispatched } = fakeController()
    const cmds = commandsFor(
      controller,
      strip({ status: 'holdShort', controlledBy: 'tower', holdingForTakeoff: true }),
      [],
    )
    expect(labels(cmds)).toEqual(['Line up and wait', 'Cleared for takeoff', 'Hold position'])
    const luaw = cmds[0]!.action
    if (luaw.kind === 'run') luaw.run()
    const cto = cmds[1]!.action
    if (cto.kind === 'run') cto.run()
    expect(dispatched).toEqual([
      { type: 'lineUpAndWait', aircraftId: 'a' },
      { type: 'clearedForTakeoff', aircraftId: 'a' },
    ])
    expect(cmds[2]!.action.kind).toBe('soon')
  })

  it('tower-owned lineUpWait → cleared for takeoff (runs), hold position (soon)', () => {
    const { controller, dispatched } = fakeController()
    const cmds = commandsFor(controller, strip({ status: 'lineUpWait', controlledBy: 'tower' }), [])
    expect(labels(cmds)).toEqual(['Cleared for takeoff', 'Hold position'])
    const cto = cmds[0]!.action
    if (cto.kind === 'run') cto.run()
    expect(dispatched).toEqual([{ type: 'clearedForTakeoff', aircraftId: 'a' }])
    expect(cmds[1]!.action.kind).toBe('soon')
  })

  it('tower takeoff is gated (soon) with a reason when the runway is busy', () => {
    const { controller } = fakeController()
    const self = strip({ id: 'a', status: 'lineUpWait', controlledBy: 'tower', onRunway: true })
    const blocker = strip({ id: 'b', status: 'departing', controlledBy: 'tower', onRunway: true, blocksTakeoff: true })
    const cmds = commandsFor(controller, self, [self, blocker])
    expect(cmds[0]!.label).toBe('Cleared for takeoff — runway busy')
    expect(cmds[0]!.action.kind).toBe('soon')
  })

  it('a lined-up aircraft does not gate its own takeoff (self-exclusion)', () => {
    // A lineUpWait aircraft is itself onRunway + blocksTakeoff; the o.id !== id guard must
    // exclude it so it can be cleared when the runway is otherwise clear.
    const { controller, dispatched } = fakeController()
    const self = strip({ id: 'a', status: 'lineUpWait', controlledBy: 'tower', onRunway: true, blocksTakeoff: true })
    const cmds = commandsFor(controller, self, [self])
    expect(cmds[0]!.label).toBe('Cleared for takeoff')
    const cto = cmds[0]!.action
    if (cto.kind === 'run') cto.run()
    expect(dispatched).toEqual([{ type: 'clearedForTakeoff', aircraftId: 'a' }])
  })

  it('a rotated departure (blocksTakeoff false) does not gate the next takeoff', () => {
    const { controller } = fakeController()
    const self = strip({ id: 'a', status: 'lineUpWait', controlledBy: 'tower', onRunway: true })
    const rotated = strip({ id: 'b', status: 'departing', controlledBy: 'tower', onRunway: true, blocksTakeoff: false })
    const cmds = commandsFor(controller, self, [self, rotated])
    expect(cmds[0]!.label).toBe('Cleared for takeoff')
    expect(cmds[0]!.action.kind).toBe('run')
  })

  it('tower takeoff is gated (soon) with a wake countdown when wake separation is owed', () => {
    const { controller } = fakeController()
    const cmds = commandsFor(controller, strip({ status: 'holdShort', controlledBy: 'tower', wakeHoldSec: 90 }), [])
    const takeoff = cmds.find((c) => c.label.startsWith('Cleared for takeoff'))!
    expect(takeoff.label).toBe('Cleared for takeoff — wake 90s')
    expect(takeoff.action.kind).toBe('soon')
  })

  it('line up and wait is gated (soon) when a stationary aircraft occupies the runway', () => {
    const { controller } = fakeController()
    const self = strip({ id: 'a', status: 'holdShort', controlledBy: 'tower' })
    const linedUp = strip({ id: 'b', status: 'lineUpWait', controlledBy: 'tower', onRunway: true })
    const cmds = commandsFor(controller, self, [self, linedUp])
    expect(cmds[0]!.label).toBe('Line up and wait — runway busy')
    expect(cmds[0]!.action.kind).toBe('soon')
  })

  it('line up and wait is allowed behind a rolling (departing) aircraft', () => {
    const { controller } = fakeController()
    const self = strip({ id: 'a', status: 'holdShort', controlledBy: 'tower' })
    const rolling = strip({ id: 'b', status: 'departing', controlledBy: 'tower', onRunway: true, blocksTakeoff: true })
    const cmds = commandsFor(controller, self, [self, rolling])
    expect(cmds[0]!.label).toBe('Line up and wait')
    expect(cmds[0]!.action.kind).toBe('run')
  })

  it('holdShort + arrival → cross runway (runs), hold position (soon)', () => {
    const { controller, dispatched } = fakeController()
    const cmds = commandsFor(controller, strip({ status: 'holdShort', intent: 'arrival' }), [])
    // An arrival can always be sent to a different gate, whatever phase it is in.
    expect(labels(cmds)).toEqual(['Cross runway', 'Hold position', 'Reassign gate…'])
    const cross = cmds[0]!.action
    if (cross.kind === 'run') cross.run()
    expect(dispatched).toEqual([{ type: 'crossRunway', aircraftId: 'a' }])
  })

  it('holdShort + departure that is only crossing (not its runway) → cross runway, not contact tower', () => {
    const { controller, dispatched } = fakeController()
    // a departure whose route crosses the runway: holdingForTakeoff is false
    const cmds = commandsFor(controller, strip({ status: 'holdShort', intent: 'departure', holdingForTakeoff: false }), [])
    expect(labels(cmds)).toEqual(['Cross runway', 'Hold position'])
    const cross = cmds[0]!.action
    if (cross.kind === 'run') cross.run()
    expect(dispatched).toEqual([{ type: 'crossRunway', aircraftId: 'a' }])
  })

  it('parked departure without a squawk → deliver clearance', () => {
    const { controller, dispatched } = fakeController()
    const cmds = commandsFor(controller, strip({ status: 'parked', intent: 'departure', gate: '41', squawk: null }), [])
    expect(labels(cmds)).toEqual(['Deliver clearance'])
    const clr = cmds[0]!.action
    if (clr.kind === 'run') clr.run()
    expect(dispatched).toEqual([{ type: 'clearance', aircraftId: 'a' }])
  })

  it('cleared departure, servicing done → pushback approved (enabled)', () => {
    const { controller, dispatched } = fakeController()
    const cmds = commandsFor(controller, strip({ status: 'parked', intent: 'departure', gate: '41', squawk: '4231', serviceSec: 0 }), [])
    expect(labels(cmds)).toEqual(['Pushback approved'])
    const push = cmds[0]!.action
    if (push.kind === 'run') push.run()
    expect(dispatched).toEqual([{ type: 'pushback', aircraftId: 'a' }])
  })

  it('offers a direction to push into when the alley runs both ways', () => {
    const { controller, dispatched } = fakeController()
    const cmds = commandsFor(
      controller,
      strip({
        status: 'parked',
        intent: 'departure',
        gate: '41',
        squawk: '4231',
        serviceSec: 0,
        pushbackOptions: [
          { facing: 'E', headingDeg: 90, ref: 'P' },
          { facing: 'W', headingDeg: 270, ref: 'P' },
        ],
      }),
      [],
    )
    expect(labels(cmds)).toEqual(['Pushback approved…'])
    const menu = cmds[0]!.action
    expect(menu.kind).toBe('submenu')
    if (menu.kind !== 'submenu') return
    // The taxiway each way faces down is named: that is the consequence of the choice.
    expect(menu.items.map((i) => i.label)).toEqual(['Facing E (P)', 'Facing W (P)'])
    menu.items[1]!.run()
    expect(dispatched).toEqual([{ type: 'pushback', aircraftId: 'a', facing: 'W' }])
  })

  it('cleared departure still servicing → pushback disabled with a countdown', () => {
    const { controller } = fakeController()
    const cmds = commandsFor(controller, strip({ status: 'parked', intent: 'departure', gate: '41', squawk: '4231', serviceSec: 30 }), [])
    expect(labels(cmds)).toEqual(['Pushback — servicing 30s'])
    expect(cmds[0]!.action.kind).toBe('soon') // gated until services complete
  })

  it('pushback → no actions (an automatic maneuver)', () => {
    const { controller } = fakeController()
    const cmds = commandsFor(controller, strip({ status: 'pushback' }), [])
    expect(cmds).toEqual([])
  })

  it('taxi departure → taxi-to submenu of destinations, route via, hold, give way, expedite (no contact tower until hold short)', () => {
    const { controller, dispatched } = fakeController()
    const cmds = commandsFor(controller, strip({ status: 'taxi' }), [strip({ status: 'taxi' })])
    expect(labels(cmds)).toEqual(['Taxi to…', 'Route via…', 'Hold position', 'Give way to…', 'Expedite'])

    const taxiTo = cmds[0]!.action
    expect(taxiTo.kind).toBe('submenu')
    if (taxiTo.kind === 'submenu') {
      // Thresholds first, then every runway intersection a departure could hold short at.
      expect(taxiTo.items.map((l) => l.label)).toEqual(['RWY 27', 'RWY 9', 'RWY @ B4', 'RWY @ B2'])
      taxiTo.items[0]!.run()
      expect(dispatched).toContainEqual({ type: 'taxiTo', aircraftId: 'a', dest: [1, 0], exact: true })
    }

    const hold = cmds[2]!.action
    if (hold.kind === 'run') hold.run()
    expect(dispatched).toContainEqual({ type: 'hold', aircraftId: 'a' })
  })

  it('route via… begins a route draft on the controller', () => {
    const { controller, beganRoute } = fakeController()
    const cmds = commandsFor(controller, strip({ status: 'taxi' }), [])
    const via = cmds[1]!.action
    if (via.kind === 'run') via.run()
    expect(beganRoute).toEqual(['a'])
  })

  it('give way is a submenu of other moving traffic, dispatching giveWay', () => {
    const { controller, dispatched } = fakeController()
    const other = strip({ id: 'b', callsign: 'UAL2', status: 'taxi' })
    const cmds = commandsFor(controller, strip({ status: 'taxi' }), [strip({ status: 'taxi' }), other])
    const give = cmds.find((c) => c.label === 'Give way to…')!.action
    expect(give.kind).toBe('submenu')
    if (give.kind === 'submenu') {
      expect(give.items.map((l) => l.label)).toEqual(['UAL2'])
      give.items[0]!.run()
      expect(dispatched).toContainEqual({ type: 'giveWay', aircraftId: 'a', toId: 'b' })
    }
  })

  it('give way falls back to soon when there is no other moving traffic', () => {
    const { controller } = fakeController()
    // only self + a parked aircraft → no valid give-way targets
    const cmds = commandsFor(controller, strip({ status: 'taxi' }), [strip({ status: 'taxi' }), strip({ id: 'p', status: 'parked' })])
    const give = cmds.find((c) => c.label === 'Give way to…')!
    expect(give.action.kind).toBe('soon')
  })

  it('arrival at taxi with a gate adds a "Gate N" destination that taxis to goal', () => {
    const { controller, dispatched } = fakeController()
    const cmds = commandsFor(controller, strip({ status: 'taxi', intent: 'arrival', gate: '22' }), [])
    const taxiTo = cmds[0]!.action
    expect(taxiTo.kind).toBe('submenu')
    if (taxiTo.kind === 'submenu') {
      expect(taxiTo.items.map((l) => l.label)).toContain('Gate 22')
      taxiTo.items.find((l) => l.label === 'Gate 22')!.run()
      expect(dispatched).toContainEqual({ type: 'taxiToGoal', aircraftId: 'a' })
    }
    // an arrival is not offered give-way/hold gating specific to departures, but taxi still applies
    expect(labels(cmds)).toContain('Route via…')
  })

  it('holding → offers continue taxi (resume)', () => {
    const { controller, dispatched } = fakeController()
    const cmds = commandsFor(controller, strip({ status: 'holding' }), [])
    expect(labels(cmds)).toContain('Continue taxi')
    const cont = cmds.find((c) => c.label === 'Continue taxi')!.action
    if (cont.kind === 'run') cont.run()
    expect(dispatched).toEqual([{ type: 'resume', aircraftId: 'a' }])
  })

  it('a give-way hold (giveWayTo set) also offers continue taxi', () => {
    const { controller } = fakeController()
    const cmds = commandsFor(controller, strip({ status: 'taxi', giveWayTo: 'UAL2' }), [])
    expect(labels(cmds)).toContain('Continue taxi')
  })
})

describe('commandsFor — expedite', () => {
  const running = (over: Partial<StripItem> = {}) => strip({ status: 'taxi', ...over })

  it('dispatches an expedite for an aircraft with a clearance still to run', () => {
    const { controller, dispatched } = fakeController()
    const cmd = commandsFor(controller, running(), []).find((c) => c.key === 'expedite')!
    expect(cmd.label).toBe('Expedite')
    if (cmd.action.kind === 'run') cmd.action.run()
    expect(dispatched).toEqual([{ type: 'expedite', aircraftId: 'a' }])
  })

  it('names the job when this is the aircraft sitting on the runway', () => {
    const { controller } = fakeController()
    const cmd = commandsFor(controller, running({ incursion: true }), []).find((c) => c.key === 'expedite')!
    expect(cmd.label).toBe('Expedite — clear the runway')
  })

  it('says so rather than vanishing when the aircraft cannot be hurried', () => {
    // "This one cannot get out of the way" is exactly what tells you to send the other one
    // around, so it has to be visible — a missing item says nothing.
    const { controller } = fakeController()
    const cmd = commandsFor(controller, running({ canExpedite: false }), []).find((c) => c.key === 'expedite')!
    expect(cmd.label).toBe('Expedite — nothing to run')
    expect(cmd.action.kind).toBe('soon')
  })

  it('does not offer to expedite an aircraft that already is', () => {
    const { controller } = fakeController()
    const cmd = commandsFor(controller, running({ expedite: true }), []).find((c) => c.key === 'expedite')!
    expect(cmd.label).toBe('Expediting')
    expect(cmd.action.kind).toBe('soon')
  })

  it('is not offered to a parked aircraft, which has no clearance under way', () => {
    const { controller } = fakeController()
    const cmds = commandsFor(controller, strip({ status: 'parked', gate: null }), [])
    expect(cmds.find((c) => c.key === 'expedite')).toBeUndefined()
  })
})

describe('commandsFor — Tower arrivals', () => {
  const onFinal = (over: Partial<StripItem> = {}) =>
    strip({ status: 'onFinal', controlledBy: 'tower', intent: 'arrival', altitude: 1250, finalNm: 4, ...over })

  it('on final → cleared to land, exit assignment, and a go-around that really goes around', () => {
    const { controller, dispatched } = fakeController()
    const cmds = commandsFor(controller, onFinal(), [])
    expect(labels(cmds)).toEqual(['Cleared to land', 'Exit at…', 'Go around', 'Reassign gate…'])
    const land = cmds[0]!.action
    if (land.kind === 'run') land.run()
    expect(dispatched).toEqual([{ type: 'clearedToLand', aircraftId: 'a' }])
    const around = cmds[2]!.action
    expect(around.kind).toBe('run')
    if (around.kind === 'run') around.run()
    expect(dispatched.at(-1)).toEqual({ type: 'goAround', aircraftId: 'a' })
  })

  it('names the reason on the go-around when this arrival is the one being landed on top', () => {
    // The reason to open the menu belongs on the menu, as with the gate conflict.
    const { controller } = fakeController()
    const cmds = commandsFor(controller, onFinal({ incursion: true }), [])
    expect(labels(cmds)[2]).toBe('Go around — runway occupied')
  })

  it('lists only the turnoffs the sim says are still makeable', () => {
    const { controller, dispatched } = fakeController()
    const exitOptions: RunwayExit[] = [
      { ref: 'B6', point: [0, 0], geom: [[0, 0], [0, -0.1]], vacatePoint: [0, -0.1], angleDeg: 30, kind: 'rapid', turn: 'left', distanceNm: 0.7, lengthNm: 0.1, speedKt: 40 },
      { ref: 'C2', point: [1, 0], geom: [[1, 0], [1, -0.1]], vacatePoint: [1, -0.1], angleDeg: 90, kind: 'standard', turn: 'right', distanceNm: 1.4, lengthNm: 0.1, speedKt: 12 },
    ]
    const cmds = commandsFor(controller, onFinal({ exitOptions }), [])
    const exit = cmds.find((c) => c.key === 'exit')!.action
    expect(exit.kind).toBe('submenu')
    if (exit.kind !== 'submenu') return
    expect(exit.items.map((i) => i.label)).toEqual([
      'B6 — left high-speed · 0.7 nm',
      'C2 — right 90° · 1.4 nm',
    ])
    exit.items[0]!.run()
    expect(dispatched).toEqual([{ type: 'assignExit', aircraftId: 'a', ref: 'B6' }])
  })

  it('gates the landing clearance while another aircraft occupies the runway', () => {
    const { controller } = fakeController()
    const other = strip({ id: 'b', callsign: 'UAL2', status: 'lineUpWait', blocksTakeoff: true })
    const cmds = commandsFor(controller, onFinal(), [other])
    expect(labels(cmds)[0]).toBe('Cleared to land — runway busy')
    expect(cmds[0]!.action.kind).toBe('soon')
  })

  it('never offers a landing clearance twice — cleared traffic can still be re-assigned an exit', () => {
    const { controller } = fakeController()
    const cmds = commandsFor(controller, onFinal({ status: 'landing' }), [])
    expect(labels(cmds)).toEqual(['Exit at…', 'Go around', 'Reassign gate…'])
  })

  it('on the roll, Tower issues the frequency change — the pilot never self-initiates', () => {
    const { controller, dispatched } = fakeController()
    const rolling = onFinal({ status: 'rollout', altitude: 0, finalNm: 0, exitRef: 'B6' })
    const cmds = commandsFor(controller, rolling, [])
    // Not clear of the runway yet → the deferred phraseology.
    const gnd = cmds.find((c) => c.key === 'gnd')!
    expect(gnd.label).toBe('When vacated, contact ground')
    if (gnd.action.kind === 'run') gnd.action.run()
    expect(dispatched).toEqual([{ type: 'contactGround', aircraftId: 'a' }])
  })

  it('once clear of the runway the handoff is immediate, and the exit menu is gone', () => {
    const { controller } = fakeController()
    const cmds = commandsFor(controller, onFinal({ status: 'rollout', altitude: 0, finalNm: 0, vacated: true }), [])
    expect(labels(cmds)).toEqual(['Contact ground', 'Reassign gate…'])
  })

  it('an already-issued handoff is shown as pending, not offered again', () => {
    const { controller } = fakeController()
    const cmds = commandsFor(
      controller,
      onFinal({ status: 'rollout', altitude: 0, finalNm: 0, handoffPending: true }),
      [],
    )
    const gnd = cmds.find((c) => c.key === 'gnd')!
    expect(gnd.label).toBe('Sent to ground — awaiting vacate')
    expect(gnd.action.kind).toBe('soon')
  })

  it('blocks a departure line-up and takeoff under traffic on short final', () => {
    const { controller } = fakeController()
    const inbound = strip({ id: 'b', callsign: 'UAL2', status: 'landing', controlledBy: 'tower', intent: 'arrival', altitude: 300, finalNm: 1, onShortFinal: true })
    const dep = strip({ status: 'holdShort', controlledBy: 'tower', holdingForTakeoff: true })
    const cmds = commandsFor(controller, dep, [inbound])
    expect(labels(cmds)).toEqual([
      'Line up and wait — runway busy',
      'Cleared for takeoff — runway busy',
      'Hold position',
    ])
  })

  it('leaves a departure alone when the arrival is still well outside short final', () => {
    const { controller } = fakeController()
    const inbound = strip({ id: 'b', callsign: 'UAL2', status: 'landing', controlledBy: 'tower', intent: 'arrival', altitude: 1200, finalNm: 3.8 })
    const dep = strip({ status: 'holdShort', controlledBy: 'tower', holdingForTakeoff: true })
    const cmds = commandsFor(controller, dep, [inbound])
    expect(labels(cmds)).toEqual(['Line up and wait', 'Cleared for takeoff', 'Hold position'])
  })
})

describe('commandsFor — an aircraft parked away from a stand', () => {
  it('skips clearance and pushback for a departure with no gate', () => {
    // The dev sandbox can drop a test aircraft anywhere on the surface. There is no stand to
    // push it off, so offering "Deliver clearance" then "Pushback approved" is a dead end.
    const { controller } = fakeController()
    const cmds = commandsFor(controller, strip({ status: 'parked', intent: 'departure', gate: null }), [])
    expect(labels(cmds)).not.toContain('Deliver clearance')
    expect(labels(cmds)).not.toContain('Pushback approved')
    expect(labels(cmds)).toContain('Taxi to…')
  })

  it('still runs the full flow for one on a stand', () => {
    const { controller } = fakeController()
    const cmds = commandsFor(controller, strip({ status: 'parked', intent: 'departure', gate: '41' }), [])
    expect(labels(cmds)).toEqual(['Deliver clearance'])
  })
})

describe('commandsFor — intersection departures', () => {
  it('offers every runway intersection as a taxi destination for a departure', () => {
    const { controller, dispatched } = fakeController()
    const cmds = commandsFor(controller, strip({ status: 'holding', intent: 'departure' }), [])
    const taxi = cmds.find((c) => c.label === 'Taxi to…')!.action
    expect(taxi.kind).toBe('submenu')
    if (taxi.kind !== 'submenu') return
    const labels = taxi.items.map((i) => i.label)
    expect(labels).toContain('RWY @ B4')
    expect(labels).toContain('RWY @ B2')
    taxi.items.find((i) => i.label === 'RWY @ B4')!.run()
    expect(dispatched).toEqual([
      { type: 'taxiTo', aircraftId: 'a', dest: [0.5, 0], exact: true },
    ])
  })

  it('does not offer them to an arrival, which has no reason to hold short mid-runway', () => {
    const { controller } = fakeController()
    const cmds = commandsFor(controller, strip({ status: 'holding', intent: 'arrival', gate: '41' }), [])
    const taxi = cmds.find((c) => c.label === 'Taxi to…')!.action
    if (taxi.kind !== 'submenu') throw new Error('expected a submenu')
    expect(taxi.items.map((i) => i.label)).not.toContain('RWY @ B4')
  })
})

describe('say again', () => {
  it('is not offered until something has been transmitted', () => {
    const { controller } = fakeController()
    expect(labels(commandsFor(controller, strip({ hasInstruction: false }), []))).not.toContain('Say again')
  })

  it('is offered in every phase once a clearance has been issued', () => {
    for (const status of ['parked', 'taxi', 'holding', 'holdShort', 'lineUpWait'] as const) {
      const item = strip({ status, hasInstruction: true, controlledBy: status === 'lineUpWait' ? 'tower' : 'ground' })
      const { controller } = fakeController()
      expect(labels(commandsFor(controller, item, []))).toContain('Say again')
    }
  })

  it('dispatches the correction for the selected aircraft', () => {
    const { controller, dispatched } = fakeController()
    const cmd = commandsFor(controller, strip({ hasInstruction: true }), []).find((x) => x.label === 'Say again')!
    expect(cmd.action.kind).toBe('run')
    if (cmd.action.kind === 'run') cmd.action.run()
    expect(dispatched).toEqual([{ type: 'sayAgain', aircraftId: 'a' }])
  })
})

describe('reassign gate', () => {
  const inbound = (over: Partial<StripItem> = {}) =>
    strip({
      status: 'onFinal',
      intent: 'arrival',
      controlledBy: 'tower',
      gate: '41',
      altitude: 1200,
      standOptions: [
        { ref: '42', distanceNm: 0.02 },
        { ref: '43', distanceNm: 0.05 },
      ],
      ...over,
    })

  it('lists the offered stands and dispatches the chosen one', () => {
    const { controller, dispatched } = fakeController()
    const cmd = commandsFor(controller, inbound(), []).find((c) => c.key === 'stand')!
    expect(cmd.action.kind).toBe('submenu')
    if (cmd.action.kind !== 'submenu') return
    expect(cmd.action.items.map((i) => i.label)).toEqual(['Gate 42', 'Gate 43'])
    cmd.action.items[1]!.run()
    expect(dispatched).toEqual([{ type: 'assignStand', aircraftId: 'a', ref: '43' }])
  })

  it('says why the menu is worth opening when the assigned gate is taken', () => {
    const { controller } = fakeController()
    const clear = commandsFor(controller, inbound(), []).find((c) => c.key === 'stand')!
    expect(clear.label).toBe('Reassign gate…')
    const blocked = commandsFor(controller, inbound({ destStandOccupied: true }), []).find(
      (c) => c.key === 'stand',
    )!
    expect(blocked.label).toContain('occupied')
  })

  it('is disabled rather than empty when the field has nowhere to put it', () => {
    const { controller } = fakeController()
    const cmd = commandsFor(controller, inbound({ standOptions: [] }), []).find((c) => c.key === 'stand')!
    expect(cmd.action.kind).toBe('soon')
  })

  it('is not offered to a departure, or to an arrival already parked', () => {
    const { controller } = fakeController()
    const dep = commandsFor(controller, strip({ intent: 'departure', status: 'taxi' }), [])
    expect(dep.find((c) => c.key === 'stand')).toBeUndefined()
    const parked = commandsFor(controller, inbound({ status: 'parked', altitude: 0 }), [])
    expect(parked.find((c) => c.key === 'stand')).toBeUndefined()
  })
})

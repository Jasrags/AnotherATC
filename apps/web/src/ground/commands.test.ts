import { describe, it, expect } from 'vitest'
import type { GroundCommand } from '@anotheratc/sim'
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
    altitude: 0,
    finalNm: 0,
    via: [],
    giveWayTo: null,
    squawk: null,
    wakeHoldSec: 0,
    services: [],
    serviceSec: 0,
    ...over,
  }
}

function fakeController() {
  const dispatched: GroundCommand[] = []
  const beganRoute: string[] = []
  const controller = {
    dispatch: (cmd: GroundCommand) => dispatched.push(cmd),
    beginRoute: (id: string) => beganRoute.push(id),
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
    expect(labels(cmds)).toEqual(['Cross runway', 'Hold position'])
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
    const cmds = commandsFor(controller, strip({ status: 'parked', intent: 'departure', squawk: null }), [])
    expect(labels(cmds)).toEqual(['Deliver clearance'])
    const clr = cmds[0]!.action
    if (clr.kind === 'run') clr.run()
    expect(dispatched).toEqual([{ type: 'clearance', aircraftId: 'a' }])
  })

  it('cleared departure, servicing done → pushback approved (enabled)', () => {
    const { controller, dispatched } = fakeController()
    const cmds = commandsFor(controller, strip({ status: 'parked', intent: 'departure', squawk: '4231', serviceSec: 0 }), [])
    expect(labels(cmds)).toEqual(['Pushback approved'])
    const push = cmds[0]!.action
    if (push.kind === 'run') push.run()
    expect(dispatched).toEqual([{ type: 'pushback', aircraftId: 'a' }])
  })

  it('cleared departure still servicing → pushback disabled with a countdown', () => {
    const { controller } = fakeController()
    const cmds = commandsFor(controller, strip({ status: 'parked', intent: 'departure', squawk: '4231', serviceSec: 30 }), [])
    expect(labels(cmds)).toEqual(['Pushback — servicing 30s'])
    expect(cmds[0]!.action.kind).toBe('soon') // gated until services complete
  })

  it('pushback → no actions (an automatic maneuver)', () => {
    const { controller } = fakeController()
    const cmds = commandsFor(controller, strip({ status: 'pushback' }), [])
    expect(cmds).toEqual([])
  })

  it('taxi departure → taxi-to submenu of destinations, route via, hold, give way (no contact tower until hold short)', () => {
    const { controller, dispatched } = fakeController()
    const cmds = commandsFor(controller, strip({ status: 'taxi' }), [strip({ status: 'taxi' })])
    expect(labels(cmds)).toEqual(['Taxi to…', 'Route via…', 'Hold position', 'Give way to…'])

    const taxiTo = cmds[0]!.action
    expect(taxiTo.kind).toBe('submenu')
    if (taxiTo.kind === 'submenu') {
      expect(taxiTo.items.map((l) => l.label)).toEqual(['RWY 27', 'RWY 9'])
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

describe('commandsFor — Tower arrivals', () => {
  const onFinal = (over: Partial<StripItem> = {}) =>
    strip({ status: 'onFinal', controlledBy: 'tower', intent: 'arrival', altitude: 1250, finalNm: 4, ...over })

  it('on final → cleared to land (runs) and go around (soon)', () => {
    const { controller, dispatched } = fakeController()
    const cmds = commandsFor(controller, onFinal(), [])
    expect(labels(cmds)).toEqual(['Cleared to land', 'Go around'])
    const land = cmds[0]!.action
    if (land.kind === 'run') land.run()
    expect(dispatched).toEqual([{ type: 'clearedToLand', aircraftId: 'a' }])
    expect(cmds[1]!.action.kind).toBe('soon')
  })

  it('gates the landing clearance while another aircraft occupies the runway', () => {
    const { controller } = fakeController()
    const other = strip({ id: 'b', callsign: 'UAL2', status: 'lineUpWait', blocksTakeoff: true })
    const cmds = commandsFor(controller, onFinal(), [other])
    expect(labels(cmds)[0]).toBe('Cleared to land — runway busy')
    expect(cmds[0]!.action.kind).toBe('soon')
  })

  it('never offers a landing clearance twice — cleared traffic only has go around', () => {
    const { controller } = fakeController()
    const cmds = commandsFor(controller, onFinal({ status: 'landing' }), [])
    expect(labels(cmds)).toEqual(['Go around'])
  })

  it('rollout is an automatic phase — nothing actionable until Ground has it', () => {
    const { controller } = fakeController()
    const cmds = commandsFor(controller, onFinal({ status: 'rollout', altitude: 0, finalNm: 0 }), [])
    expect(cmds.every((c) => c.action.kind === 'soon')).toBe(true)
  })

  it('blocks a departure line-up and takeoff under traffic on short final', () => {
    const { controller } = fakeController()
    const inbound = strip({ id: 'b', callsign: 'UAL2', status: 'landing', controlledBy: 'tower', intent: 'arrival', altitude: 300, finalNm: 1 })
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

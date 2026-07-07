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
    intent: 'departure',
    gate: null,
    via: [],
    giveWayTo: null,
    squawk: null,
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

  it('holdShort + departure → contact tower (runs), hold position (soon)', () => {
    const { controller, dispatched } = fakeController()
    const cmds = commandsFor(controller, strip({ status: 'holdShort', intent: 'departure' }), [])
    expect(labels(cmds)).toEqual(['Contact tower', 'Hold position'])
    const contact = cmds[0]!.action
    if (contact.kind === 'run') contact.run()
    expect(dispatched).toEqual([{ type: 'contactTower', aircraftId: 'a' }])
    expect(cmds[1]!.action.kind).toBe('soon')
  })

  it('holdShort + arrival → cross runway (runs), hold position (soon)', () => {
    const { controller, dispatched } = fakeController()
    const cmds = commandsFor(controller, strip({ status: 'holdShort', intent: 'arrival' }), [])
    expect(labels(cmds)).toEqual(['Cross runway', 'Hold position'])
    const cross = cmds[0]!.action
    if (cross.kind === 'run') cross.run()
    expect(dispatched).toEqual([{ type: 'crossRunway', aircraftId: 'a' }])
  })

  it('parked departure without a squawk → deliver clearance', () => {
    const { controller, dispatched } = fakeController()
    const cmds = commandsFor(controller, strip({ status: 'parked', intent: 'departure', squawk: null }), [])
    expect(labels(cmds)).toEqual(['Deliver clearance', 'Contact tower'])
    const clr = cmds[0]!.action
    if (clr.kind === 'run') clr.run()
    expect(dispatched).toEqual([{ type: 'clearance', aircraftId: 'a' }])
  })

  it('parked departure with a squawk → pushback approved', () => {
    const { controller, dispatched } = fakeController()
    const cmds = commandsFor(controller, strip({ status: 'parked', intent: 'departure', squawk: '4231' }), [])
    expect(labels(cmds)).toEqual(['Pushback approved', 'Contact tower'])
    const push = cmds[0]!.action
    if (push.kind === 'run') push.run()
    expect(dispatched).toEqual([{ type: 'pushback', aircraftId: 'a' }])
  })

  it('pushback → only a soon "contact tower"', () => {
    const { controller } = fakeController()
    const cmds = commandsFor(controller, strip({ status: 'pushback' }), [])
    expect(labels(cmds)).toEqual(['Contact tower'])
    expect(cmds[0]!.action.kind).toBe('soon')
  })

  it('taxi departure → taxi-to submenu of destinations, route via, hold, give way, contact', () => {
    const { controller, dispatched } = fakeController()
    const cmds = commandsFor(controller, strip({ status: 'taxi' }), [strip({ status: 'taxi' })])
    expect(labels(cmds)).toEqual(['Taxi to…', 'Route via…', 'Hold position', 'Give way to…', 'Contact tower'])

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

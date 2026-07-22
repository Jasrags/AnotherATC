import { describe, it, expect } from 'vitest'
import type { StripItem } from './controller'
import { takeoffSequence } from './StripBay'

function strip(over: Partial<StripItem> = {}): StripItem {
  return {
    id: 'a',
    callsign: 'AAL1',
    type: 'B738',
    wake: 'M',
    status: 'holdShort',
    controlledBy: 'tower',
    intent: 'departure',
    gate: null,
    holdingForTakeoff: true,
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

describe('takeoffSequence', () => {
  it('numbers Tower-owned departures awaiting takeoff in fleet order', () => {
    const seq = takeoffSequence([
      strip({ id: 'a', status: 'holdShort' }),
      strip({ id: 'b', status: 'lineUpWait' }),
      strip({ id: 'c', status: 'holdShort' }),
    ])
    expect(seq.get('a')).toBe(1)
    expect(seq.get('b')).toBe(2)
    expect(seq.get('c')).toBe(3)
  })

  it('skips aircraft not in the takeoff queue and renumbers around them', () => {
    const seq = takeoffSequence([
      strip({ id: 'ground', controlledBy: 'ground' }), // not handed off
      strip({ id: 'q1', status: 'holdShort' }),
      strip({ id: 'taxi', status: 'taxi' }), // tower-owned but not awaiting takeoff (shouldn't occur, but excluded)
      strip({ id: 'arr', intent: 'arrival' }), // arrivals aren't in the departure queue
      strip({ id: 'q2', status: 'lineUpWait' }),
    ])
    expect(seq.has('ground')).toBe(false)
    expect(seq.has('arr')).toBe(false)
    expect(seq.get('q1')).toBe(1)
    expect(seq.get('q2')).toBe(2)
  })

  it('is empty when nothing is awaiting takeoff', () => {
    expect(takeoffSequence([strip({ controlledBy: 'ground', status: 'taxi' })]).size).toBe(0)
  })
})

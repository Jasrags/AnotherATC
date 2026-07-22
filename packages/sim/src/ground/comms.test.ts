import { describe, expect, it } from 'vitest'
import { phonetic, phraseFor, type PhraseContext } from './comms'

const ctx = (over: Partial<PhraseContext> = {}): PhraseContext => ({
  callsign: 'SKW412',
  runway: '27',
  squawk: null,
  taxiways: [],
  destination: null,
  giveWayTo: null,
  towerFreq: null,
  groundFreq: null,
  vacated: false,
  pushFacing: null,
  position: 'ground',
  crossing: false,
  onRunway: false,
  holdingShortOf: null,
  ...over,
})

describe('phraseFor — hold short', () => {
  it('names the runway both ways, because the read-back is the point', () => {
    const ex = phraseFor({ type: 'holdShort', aircraftId: 'a' }, ctx())
    expect(ex?.instruction).toBe('SKW412, hold short of runway 27.')
    expect(ex?.readback).toBe('Hold short of runway 27, SKW412.')
  })

  it('puts the clause in the taxi clearance that creates the hold', () => {
    const taxi = { type: 'taxiToGoal', aircraftId: 'a' } as const
    const held = ctx({ destination: 'runway 27', taxiways: ['C'], holdingShortOf: '27' })
    expect(phraseFor(taxi, held)?.instruction).toBe(
      'SKW412, taxi to runway 27 via Charlie, hold short of runway 27.',
    )
    // A clearance that never reaches a runway does not carry it.
    const free = ctx({ destination: 'gate 39', taxiways: ['C'] })
    expect(phraseFor(taxi, free)?.instruction).toBe('SKW412, taxi to gate 39 via Charlie.')
  })
})

describe('phraseFor — crossings', () => {
  const cross = { type: 'crossRunway', aircraftId: 'a' } as const

  it("carries 'no delay' from Tower and not from Ground", () => {
    expect(phraseFor(cross, ctx({ position: 'ground' }))?.instruction).toBe('SKW412, cross runway 27.')
    expect(phraseFor(cross, ctx({ position: 'tower' }))?.instruction).toBe(
      'SKW412, cross runway 27, no delay.',
    )
  })

  it('names what a handoff to Tower is for, so a crossing is not read as a takeoff', () => {
    const toTower = { type: 'contactTower', aircraftId: 'a' } as const
    expect(phraseFor(toTower, ctx({ towerFreq: '118.3', crossing: true }))?.instruction).toBe(
      'SKW412, contact tower 118.3 for runway 27 crossing.',
    )
    expect(phraseFor(toTower, ctx({ towerFreq: '118.3' }))?.instruction).toBe(
      'SKW412, contact tower 118.3.',
    )
  })

  it('defers the handoff back to Ground while the aircraft is still on the pavement', () => {
    const toGround = { type: 'contactGround', aircraftId: 'a' } as const
    const on = ctx({ groundFreq: '121.9', crossing: true, onRunway: true })
    const off = ctx({ groundFreq: '121.9', crossing: true, onRunway: false })
    expect(phraseFor(toGround, on)?.instruction).toBe(
      'SKW412, when clear of the runway, contact ground 121.9.',
    )
    expect(phraseFor(toGround, off)?.instruction).toBe('SKW412, runway 27 clear, contact ground 121.9.')
  })
})

describe('phonetic', () => {
  it('spells a single-letter taxiway', () => {
    expect(phonetic('A')).toBe('Alpha')
    expect(phonetic('J')).toBe('Juliett')
  })

  it('keeps the number on a numbered connector', () => {
    expect(phonetic('B4')).toBe('Bravo 4')
    expect(phonetic('C10')).toBe('Charlie 10')
  })

  it('passes through anything it cannot spell', () => {
    expect(phonetic('HS1')).toBe('HS1')
  })
})

describe('phraseFor', () => {
  it('reads an IFR clearance back with the beacon code', () => {
    const ex = phraseFor({ type: 'clearance', aircraftId: 'a' }, ctx({ squawk: '4201' }))
    expect(ex?.instruction).toBe('SKW412, cleared to destination as filed, squawk 4201.')
    expect(ex?.readback).toBe('Cleared as filed, squawk 4201, SKW412.')
  })

  it('phrases a taxi clearance with destination and route', () => {
    const ex = phraseFor(
      { type: 'taxiToGoal', aircraftId: 'a' },
      ctx({ destination: 'runway 27', taxiways: ['A', 'B', 'B4'] }),
    )
    expect(ex?.instruction).toBe('SKW412, taxi to runway 27 via Alpha, Bravo, Bravo 4.')
    expect(ex?.readback).toBe('Runway 27 via Alpha, Bravo, Bravo 4, SKW412.')
  })

  it('omits the route when no taxiways are named', () => {
    const ex = phraseFor({ type: 'taxiToGoal', aircraftId: 'a' }, ctx({ destination: 'gate 39' }))
    expect(ex?.instruction).toBe('SKW412, taxi to gate 39.')
  })

  it('phrases hold, continue and crossing', () => {
    expect(phraseFor({ type: 'hold', aircraftId: 'a' }, ctx())?.instruction).toBe('SKW412, hold position.')
    expect(phraseFor({ type: 'resume', aircraftId: 'a' }, ctx())?.instruction).toBe('SKW412, continue taxi.')
    expect(phraseFor({ type: 'crossRunway', aircraftId: 'a' }, ctx())?.readback).toBe(
      'Cross runway 27, SKW412.',
    )
  })

  it('names the traffic in a give-way instruction', () => {
    const ex = phraseFor({ type: 'giveWay', aircraftId: 'a', toId: 'b' }, ctx({ giveWayTo: 'AAL88' }))
    expect(ex?.instruction).toBe('SKW412, give way to AAL88.')
  })

  it('puts the runway before the takeoff and landing clearances', () => {
    expect(phraseFor({ type: 'clearedForTakeoff', aircraftId: 'a' }, ctx())?.instruction).toBe(
      'SKW412, runway 27, cleared for takeoff.',
    )
    expect(phraseFor({ type: 'lineUpAndWait', aircraftId: 'a' }, ctx())?.instruction).toBe(
      'SKW412, runway 27, line up and wait.',
    )
    expect(phraseFor({ type: 'clearedToLand', aircraftId: 'a' }, ctx())?.readback).toBe(
      'Runway 27, cleared to land, SKW412.',
    )
  })

  it('includes the frequency in a handoff when the field publishes one', () => {
    expect(
      phraseFor({ type: 'contactTower', aircraftId: 'a' }, ctx({ towerFreq: '118.3' }))?.instruction,
    ).toBe('SKW412, contact tower 118.3.')
    expect(phraseFor({ type: 'contactTower', aircraftId: 'a' }, ctx())?.instruction).toBe(
      'SKW412, contact tower.',
    )
  })

  it('says "when vacated" only while the arrival is still on the runway', () => {
    expect(
      phraseFor({ type: 'contactGround', aircraftId: 'a' }, ctx({ groundFreq: '123.9' }))?.instruction,
    ).toBe('SKW412, when vacated, contact ground 123.9.')
    expect(
      phraseFor({ type: 'contactGround', aircraftId: 'a' }, ctx({ groundFreq: '123.9', vacated: true }))
        ?.instruction,
    ).toBe('SKW412, contact ground 123.9.')
  })

  it('phrases an exit assignment phonetically', () => {
    const ex = phraseFor({ type: 'assignExit', aircraftId: 'a', ref: 'B4' }, ctx())
    expect(ex?.instruction).toBe('SKW412, turn off at Bravo 4.')
    expect(ex?.readback).toBe('Bravo 4, SKW412.')
  })

  it('phrases pushback, naming the direction when one was chosen', () => {
    expect(phraseFor({ type: 'pushback', aircraftId: 'a' }, ctx())?.instruction).toBe(
      'SKW412, push and start approved.',
    )
    expect(
      phraseFor({ type: 'pushback', aircraftId: 'a' }, ctx({ pushFacing: 'E' }))?.instruction,
    ).toBe('SKW412, push and start approved facing E.')
  })
})

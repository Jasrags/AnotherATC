import { describe, it, expect } from 'vitest'
import { createGroundSim } from './sim'
import type { AircraftInit } from './sim'
import { buildRunwayGuard } from './runwayGuard'
import type { AirportSurface } from '../world/types'
import { COMMS_LOG_LIMIT } from './comms'
import { KSAN } from '../world/ksanAirport'
import { createAirportGame } from '../world/airport'
import { buildTaxiGraph } from './taxiGraph'

// Runway along y=0; a departure taxis north up to it.
const surface: AirportSurface = {
  icao: 'T',
  name: 'T',
  ref: { lat: 0, lon: 0, elevationFt: 0 },
  units: 'nm',
  source: 'x',
  bounds: { minX: -1, minY: -1, maxX: 1, maxY: 1 },
  features: [{ kind: 'runway', points: [[-1, 0], [1, 0]] }],
}
const guard = buildRunwayGuard(surface)

function departure(id: string): AircraftInit {
  return {
    id,
    callsign: id,
    type: 'B738',
    wake: 'M',
    path: [[0, -0.5], [0, -0.1], [0, 0.1], [0, 0.5]],
    targetSpeed: 15,
    intent: 'departure',
    goalPoint: [0, 0],
  }
}

const parked = (id: string): AircraftInit => ({
  id,
  callsign: id,
  type: 'B738',
  wake: 'M',
  path: [[0, 0]],
  targetSpeed: 0,
  intent: 'departure',
  gate: '1',
})

describe('communications log', () => {
  it('records an accepted clearance as a controller call and a pilot read-back', () => {
    const sim = createGroundSim([parked('SKW412')])
    sim.step(1)
    sim.dispatch({ type: 'clearance', aircraftId: 'SKW412' })

    const comms = sim.snapshot().comms
    expect(comms).toHaveLength(2)
    expect(comms[0]).toMatchObject({
      from: 'controller',
      position: 'ground',
      aircraftId: 'SKW412',
      callsign: 'SKW412',
      time: 1,
    })
    expect(comms[0]!.text).toMatch(/^SKW412, cleared to destination as filed, squawk [0-7]{4}\.$/)
    expect(comms[1]).toMatchObject({ from: 'pilot', position: 'ground' })
    expect(comms[1]!.text).toMatch(/squawk [0-7]{4}, SKW412\.$/)
    // The read-back quotes the code the sim actually assigned.
    expect(comms[1]!.text).toContain(sim.snapshot().aircraft[0]!.squawk!)
  })

  it('says nothing when a command is refused', () => {
    const sim = createGroundSim([parked('a')])
    expect(sim.dispatch({ type: 'clearedForTakeoff', aircraftId: 'a' }).ok).toBe(false)
    expect(sim.snapshot().comms).toHaveLength(0)
  })

  it('numbers transmissions monotonically in the order they were said', () => {
    const sim = createGroundSim([parked('a')])
    sim.dispatch({ type: 'clearance', aircraftId: 'a' })
    sim.dispatch({ type: 'hold', aircraftId: 'a' })
    const seqs = sim.snapshot().comms.map((t) => t.seq)
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y))
    expect(new Set(seqs).size).toBe(seqs.length)
  })

  it('logs the handoff on ground and the pilot checking in on tower', () => {
    const sim = createGroundSim([departure('d')], { guard, frequencies: { ground: '123.9', tower: '118.3' } })
    for (let i = 0; i < 1500; i += 1) sim.step(0.1)
    expect(sim.snapshot().aircraft[0]!.holdShort).toBe(true)

    sim.dispatch({ type: 'contactTower', aircraftId: 'd' })
    const comms = sim.snapshot().comms
    const tail = comms.slice(-3)
    expect(tail[0]).toMatchObject({ from: 'controller', position: 'ground' })
    expect(tail[0]!.text).toBe('d, contact tower 118.3.')
    expect(tail[1]).toMatchObject({ from: 'pilot', position: 'ground' })
    // The check-in happens on the *new* frequency — that is what makes each bay's
    // transcript read as one continuous conversation.
    expect(tail[2]).toMatchObject({ from: 'pilot', position: 'tower' })
    expect(tail[2]!.text).toContain('holding short')
  })

  it('states the runway in a takeoff clearance', () => {
    const sim = createGroundSim([departure('d')], { guard })
    for (let i = 0; i < 1500; i += 1) sim.step(0.1)
    sim.dispatch({ type: 'contactTower', aircraftId: 'd' })
    expect(sim.dispatch({ type: 'clearedForTakeoff', aircraftId: 'd' })).toEqual({ ok: true })

    const said = sim.snapshot().comms.filter((t) => t.from === 'controller').at(-1)!
    expect(said.text).toContain('cleared for takeoff')
    expect(said.position).toBe('tower')
  })

  // The per-command units above prove each phrase; this proves the *transcript* — that a real
  // departure, driven through the real command sequence on the real field, reads as one
  // continuous conversation that changes frequency in the right place.
  it('transcribes a whole KSAN departure, in order, across both frequencies', () => {
    const graph = buildTaxiGraph(KSAN.surface)
    const guard = buildRunwayGuard(KSAN.surface)
    const game = createAirportGame(KSAN)
    const sim = createGroundSim(game.inits, {
      graph,
      guard,
      runway: game.runway,
      servicing: game.servicing,
      frequencies: { ground: KSAN.comms.ground, tower: KSAN.comms.tower },
    })
    const id = game.inits[0]!.id
    const at = () => sim.snapshot().aircraft.find((a) => a.id === id)!
    const run = (n: number) => {
      for (let i = 0; i < n; i += 1) sim.step(0.1)
    }

    expect(sim.dispatch({ type: 'clearance', aircraftId: id })).toEqual({ ok: true })
    run(1200) // let ground servicing finish
    expect(sim.dispatch({ type: 'pushback', aircraftId: id })).toEqual({ ok: true })
    run(600)
    expect(sim.dispatch({ type: 'taxiToGoal', aircraftId: id })).toEqual({ ok: true })
    for (let i = 0; i < 20000 && !at().holdShort; i += 1) sim.step(0.1)
    expect(at().holdShort).toBe(true)
    expect(sim.dispatch({ type: 'contactTower', aircraftId: id })).toEqual({ ok: true })
    expect(sim.dispatch({ type: 'clearedForTakeoff', aircraftId: id })).toEqual({ ok: true })

    const log = sim.snapshot().comms.filter((t) => t.aircraftId === id)
    const said = log.filter((t) => t.from === 'controller').map((t) => t.text)
    expect(said[0]).toMatch(/cleared to destination as filed, squawk [0-7]{4}\./)
    expect(said[1]).toContain('push and start approved')
    expect(said[2]).toContain('taxi to runway 27 via')
    expect(said[3]).toBe(`${at().callsign}, contact tower ${KSAN.comms.tower}.`)
    expect(said[4]).toContain('runway 27, cleared for takeoff')

    // Everything up to the handoff is on Ground; the takeoff clearance is on Tower, with the
    // pilot's check-in between them marking the frequency change.
    const positions = log.map((t) => t.position)
    expect(positions.slice(0, 8).every((p) => p === 'ground')).toBe(true)
    expect(log.at(-1)!.position).toBe('tower')
    expect(log.map((t) => t.time)).toEqual([...log.map((t) => t.time)].sort((a, b) => a - b))
  })

  it('keeps the log bounded so a long session cannot grow without limit', () => {
    const sim = createGroundSim([parked('a')])
    for (let i = 0; i < COMMS_LOG_LIMIT; i += 1) {
      sim.dispatch({ type: 'hold', aircraftId: 'a' })
    }
    const comms = sim.snapshot().comms
    expect(comms.length).toBe(COMMS_LOG_LIMIT)
    // Oldest dropped, newest kept.
    expect(comms.at(-1)!.seq).toBeGreaterThan(COMMS_LOG_LIMIT)
  })
})

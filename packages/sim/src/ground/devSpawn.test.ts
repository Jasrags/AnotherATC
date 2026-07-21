import { describe, it, expect } from 'vitest'
import { createGroundSim } from './sim'
import { buildTaxiGraph } from './taxiGraph'
import type { AircraftInit } from './sim'
import type { AirportSurface } from '../world/types'

// A single L-shaped taxiway pair, so a placed aircraft can be routed across a junction.
const surface: AirportSurface = {
  icao: 'TEST',
  name: 'Test',
  ref: { lat: 0, lon: 0, elevationFt: 0 },
  units: 'nm',
  source: 'synthetic',
  bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
  features: [
    { kind: 'taxiway', points: [[0, 0], [1, 0]], ref: 'A' },
    { kind: 'taxiway', points: [[1, 0], [1, 1]], ref: 'B' },
  ],
}

function dev(id: string, at: readonly [number, number]): AircraftInit {
  return { id, callsign: id, type: 'B738', wake: 'M', path: [at], targetSpeed: 0 }
}

describe('dev spawn/remove/clear', () => {
  it('add() inserts an aircraft that appears in the snapshot', () => {
    const sim = createGroundSim([])
    expect(sim.snapshot().aircraft).toHaveLength(0)
    const id = sim.add(dev('d0', [0, 0]))
    expect(id).toBe('d0')
    const acs = sim.snapshot().aircraft
    expect(acs).toHaveLength(1)
    expect(acs[0]!.callsign).toBe('d0')
  })

  it('an added aircraft can be routed and taxis along the graph', () => {
    const graph = buildTaxiGraph(surface)
    const sim = createGroundSim([], { graph })
    sim.add(dev('d0', [0, 0]))
    expect(sim.dispatch({ type: 'taxiTo', aircraftId: 'd0', dest: [1, 1] }).ok).toBe(true)
    for (let i = 0; i < 6000; i += 1) sim.step(0.1) // ~2 nm at 15 kt needs > 480 s
    const d0 = sim.snapshot().aircraft.find((a) => a.id === 'd0')!
    expect(Math.hypot(d0.x - 1, d0.y - 1)).toBeLessThan(0.02) // reached the far end via A→B
  })

  it('remove() deletes a specific aircraft and reports whether it existed', () => {
    const sim = createGroundSim([])
    sim.add(dev('d0', [0, 0]))
    sim.add(dev('d1', [1, 0]))
    expect(sim.remove('d0')).toBe(true)
    expect(sim.remove('nope')).toBe(false)
    const acs = sim.snapshot().aircraft
    expect(acs.map((a) => a.id)).toEqual(['d1'])
  })

  it('clear() empties the fleet', () => {
    const sim = createGroundSim([dev('a', [0, 0]), dev('b', [1, 0])])
    sim.clear()
    expect(sim.snapshot().aircraft).toHaveLength(0)
  })

  it('clear() also wipes the transcript — the calls belong to aircraft that are gone', () => {
    const sim = createGroundSim([{ ...dev('a', [0, 0]), gate: '1' }])
    sim.dispatch({ type: 'clearance', aircraftId: 'a' })
    expect(sim.snapshot().comms.length).toBeGreaterThan(0)

    sim.clear()
    expect(sim.snapshot().comms).toHaveLength(0)

    // The sequence counter resets with it, so a fresh call after clearing starts clean rather
    // than carrying a large number the empty panel could never explain.
    const id = sim.add({ ...dev('b', [0, 0]), gate: '1' })
    sim.dispatch({ type: 'clearance', aircraftId: id })
    expect(sim.snapshot().comms[0]!.seq).toBe(1)
  })
})

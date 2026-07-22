import { describe, it, expect } from 'vitest'
import { createGroundSim } from './sim'
import { buildTaxiGraph } from './taxiGraph'
import type { AircraftInit } from './sim'
import type { AirportSurface } from '../world/types'

function dep(id: string): AircraftInit {
  return { id, callsign: id, type: 'B738', wake: 'M', path: [[0, 0]], targetSpeed: 0, intent: 'departure' }
}

describe('dispatch result feedback', () => {
  it('refuses an unknown aircraft with a reason', () => {
    const sim = createGroundSim([dep('a')])
    const r = sim.dispatch({ type: 'hold', aircraftId: 'ghost' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/unknown aircraft/i)
  })

  it('accepts a valid hold', () => {
    const sim = createGroundSim([dep('a')])
    expect(sim.dispatch({ type: 'hold', aircraftId: 'a' })).toEqual({ ok: true })
  })

  it('refuses give-way to an unknown or self target', () => {
    const sim = createGroundSim([dep('a')])
    const unknown = sim.dispatch({ type: 'giveWay', aircraftId: 'a', toId: 'nobody' })
    expect(unknown.ok).toBe(false)
    const self = sim.dispatch({ type: 'giveWay', aircraftId: 'a', toId: 'a' })
    expect(self.ok).toBe(false)
  })

  it('refuses pushback for an arrival', () => {
    const arr: AircraftInit = { id: 'r', callsign: 'R', type: 'B738', wake: 'M', path: [[0, 0]], targetSpeed: 0, intent: 'arrival' }
    const sim = createGroundSim([arr])
    const r = sim.dispatch({ type: 'pushback', aircraftId: 'r' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/departure/i)
  })

  it('refuses a destination nowhere near the movement area, rather than snapping to it', () => {
    // Snapping is unbounded by nature — `nearestNode` always answers — so a point out over the
    // water used to resolve to whichever node happened to be closest and read back as an
    // accepted clearance. That is what made a stray click on the scope silently re-route the
    // selected aircraft.
    const surface: AirportSurface = {
      icao: 'T',
      name: 'T',
      ref: { lat: 0, lon: 0, elevationFt: 0 },
      units: 'nm',
      source: 'x',
      bounds: { minX: -1, minY: -1, maxX: 2, maxY: 1 },
      features: [{ kind: 'taxiway', ref: 'A', points: [[0, 0], [1, 0]] }],
    }
    const graph = buildTaxiGraph(surface)
    const taxiing: AircraftInit = {
      id: 'a', callsign: 'a', type: 'B738', wake: 'M', path: [[0, 0]], targetSpeed: 0, intent: 'departure',
    }
    const sim = createGroundSim([taxiing], { graph })

    // On the taxiway: a normal clearance.
    expect(sim.dispatch({ type: 'taxiTo', aircraftId: 'a', dest: [1, 0] }).ok).toBe(true)
    // Half a mile off the end of it: nothing to be cleared to.
    const far = sim.dispatch({ type: 'taxiTo', aircraftId: 'a', dest: [1.5, 0] })
    expect(far.ok).toBe(false)
    if (!far.ok) expect(far.reason).toMatch(/no taxi route/i)
    // …and the refusal left the aircraft's existing clearance alone.
    expect(sim.routeOf('a').at(-1)).toEqual([1, 0])
  })

  it('refuses crossRunway when not holding short', () => {
    const sim = createGroundSim([dep('a')])
    const r = sim.dispatch({ type: 'crossRunway', aircraftId: 'a' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/holding short/i)
  })

  it('issues clearance once, then refuses a duplicate', () => {
    const sim = createGroundSim([dep('a')])
    expect(sim.dispatch({ type: 'clearance', aircraftId: 'a' })).toEqual({ ok: true })
    const again = sim.dispatch({ type: 'clearance', aircraftId: 'a' })
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.reason).toMatch(/already/i)
  })

  it('refuses a taxi command when there is no taxi graph', () => {
    const sim = createGroundSim([dep('a')])
    const r = sim.dispatch({ type: 'taxiTo', aircraftId: 'a', dest: [1, 1] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/route|graph/i)
  })

  it('refuses a taxi to a destination in a disconnected part of the graph', () => {
    // Two taxiways with no shared node: nothing routes from one component to the other.
    const split: AirportSurface = {
      icao: 'TEST',
      name: 'Test',
      ref: { lat: 0, lon: 0, elevationFt: 0 },
      units: 'nm',
      source: 'synthetic',
      bounds: { minX: 0, minY: 0, maxX: 1, maxY: 0.2 },
      features: [
        { kind: 'taxiway', points: [[0, 0], [0, 0.2]], ref: 'A' }, // component 1 (near the aircraft)
        { kind: 'taxiway', points: [[1, 0], [1, 0.2]], ref: 'B' }, // component 2 (the destination)
      ],
    }
    const graph = buildTaxiGraph(split)
    const parked: AircraftInit = { id: 'a', callsign: 'a', type: 'B738', wake: 'M', path: [[0, 0]], targetSpeed: 0 }
    const sim = createGroundSim([parked], { graph })

    const r = sim.dispatch({ type: 'taxiTo', aircraftId: 'a', dest: [1, 0.2] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/no taxi route/i)
    // Refused = untouched: still a single-point (parked) route, never a partial/garbage one.
    expect(sim.routeOf('a')).toEqual([])
  })
})
